import { findAccount, mutatePool, readPool } from './pool/store'
import { adapterFor, ADAPTERS } from './providers/registry'
import type { ProviderAdapter } from './providers/types'
import { ensureAccessToken } from './refresh'
import type { PoolAccount, PoolFile } from './types'
import { preserveWeeklyAnchor } from './usage-merge'

const SEED_TTL_MS = 5 * 60 * 1000

/** Per-account last poll time, to throttle usage-endpoint calls (which are themselves rate-limited). */
const lastPoll = new Map<string, number>()

/**
 * Test-only window into the module-private `lastPoll` throttle map. Never
 * imported by production code — only by usage-refresh tests that need to
 * assert on the prune's exact membership (a net-neutral delete+re-add cycle
 * cannot be distinguished by fetchUsage call counts alone, since a freshly
 * added account never collides with a stale id).
 */
export function _lastPollIdsForTests(): Set<string> {
  return new Set(lastPoll.keys())
}

/** One stale pool row paired with the adapter that owns its provider. */
interface StaleTarget {
  adapter: ProviderAdapter
  account: PoolAccount
}

/**
 * Best-effort: seed/refresh usage for accounts whose WEEKLY snapshot is missing or
 * stale (`capturedAt` is stamped only when a weekly window arrives — see
 * `applyUsagePartial` in fetch.ts), via each provider's dedicated usage endpoint.
 * Throttled per account (at most one poll per account per SEED_TTL_MS). Callers
 * invoke it fire-and-forget, so it adds no latency to the request path; failures
 * are swallowed — response headers remain the primary, always-fresh usage signal
 * and this fixes cold-start blindness AND out-of-band server-side resets (e.g. a
 * promotional weekly-quota reset) that response headers alone don't converge.
 *
 * `adapters` is a LIST, not a single provider, because a pool row is refreshed
 * by whichever adapter owns its `providerID` — the ambient callers (request
 * path, dashboard) pass the whole registry so ANY activity keeps EVERY
 * provider's usage current (see `refreshAllUsageInBackground`).
 *
 * Returns a promise (for tests / explicit awaiting); request-path callers ignore it.
 *
 * `poolSnapshot` lets the request hot path reuse the pool it JUST read for
 * account selection instead of paying a second serialized file read +
 * JSON.parse per request. The snapshot is only consulted for the staleness
 * gates below; the actual usage write still goes through `mutatePool` (which
 * re-reads under the lock), so a slightly stale snapshot is harmless. Callers
 * without a pool in hand (e.g. the startup seed in index.ts) omit it.
 */
async function refreshUsage(
  adapters: readonly ProviderAdapter[],
  now: number,
  poolSnapshot?: PoolFile,
): Promise<void> {
  const pool = poolSnapshot ?? (await readPool())
  // Collect the stale, poll-eligible subset in ONE synchronous loop — staleness
  // gate, adapter resolution, and `lastPoll` throttle fused. This runs once per
  // request (fire-and-forget from the fetch retry loop), and in the dominant
  // steady state — every account's weekly snapshot freshly captured from
  // response headers — the old shape still allocated a filter array, one async
  // closure + promise per account, and a `Promise.all` aggregate, only for
  // every closure to bail at its staleness gate. Now nothing allocates unless
  // an account is genuinely stale. The `lastPoll.set` stays here — before any
  // await — so re-entrant concurrent calls still short-circuit on the throttle.
  //
  // The SAME pass also builds an alive-id Set — but ONLY when `lastPoll`
  // already has entries, so the very first call (no throttle history yet)
  // pays nothing extra — used below to prune `lastPoll` entries for accounts
  // that no longer exist. TUI-sidebar deletes (`deleteFromPool` in
  // `auth-load-balancer-tui.view.tsx`) remove the row but cannot reach into
  // this module's throttle map, and `addAccount` coins a fresh `randomUUID`
  // per add, so a deleted account's id would otherwise linger in `lastPoll`
  // forever (a bounded but real leak). Pruning by exact Set membership
  // (rather than comparing `lastPoll.size` against `pool.accounts.length`)
  // also catches a delete-then-add cycle that keeps the account COUNT
  // constant — e.g. the TUI sidebar's Delete followed by a fresh login —
  // where a size-only comparison can never detect the churn since both sides
  // stay equal. Every account (including the openai `continue` below) is
  // added to the alive set BEFORE any `continue`, so it costs no extra
  // iteration over `pool.accounts`; disabled rows are included too, so a
  // disabled account keeps its throttle slot — re-enabling it shouldn't
  // immediately re-poll the usage endpoint and risk its own rate limit. The
  // final prune loop is O(lastPoll.size), bounded by the historical account
  // count, and runs once after this loop instead of gating on a size compare.
  const aliveIds = lastPoll.size > 0 ? new Set<string>() : undefined
  let stale: StaleTarget[] | undefined
  for (const account of pool.accounts) {
    aliveIds?.add(account.id)
    if (account.disabledReason) continue
    // Check staleness FIRST: in the steady state it is false, and both the
    // adapter lookup and the `lastPoll` Map lookup would be dead weight on the
    // per-request hot path.
    if (
      account.usage.capturedAt !== 0 &&
      now - account.usage.capturedAt <= SEED_TTL_MS
    )
      continue
    // Resolve the adapter that OWNS this row, rather than assuming the caller's
    // own provider: a single-provider caller passes a one-entry list, so a row
    // belonging to another provider finds no match and is skipped exactly as
    // the previous `providerID !== adapter.id` filter did. Resolved BEFORE the
    // throttle is stamped so a row whose provider this build doesn't know never
    // burns its `lastPoll` slot on a poll that can't happen.
    const adapter = adapterFor(adapters, account.providerID)
    if (!adapter) continue
    if ((lastPoll.get(account.id) ?? 0) > now - SEED_TTL_MS) continue
    lastPoll.set(account.id, now)
    stale ??= []
    stale.push({ adapter, account })
  }
  if (aliveIds) {
    for (const id of lastPoll.keys()) if (!aliveIds.has(id)) lastPoll.delete(id)
  }
  if (!stale) return
  // Parallelize across the stale subset: per-account refresh locks in
  // `refresh.ts` are keyed by (providerID, accountId), so distinct accounts
  // never contend; and `mutatePool` already serializes via the in-process
  // chain mutex + cross-process file lock, so concurrent calls degrade to
  // sequential atomicity automatically. Cold-start seeding for an N-account
  // pool drops from O(N) sequential 30 s timeouts (OAUTH_HTTP_TIMEOUT_MS +
  // USAGE_HTTP_TIMEOUT_MS per account, summed) to a single worst-case window.
  await Promise.all(
    stale.map(async ({ adapter, account }) => {
      try {
        await ensureAccessToken(adapter, account, now)
        const snapshot = await adapter.fetchUsage(account, now)
        if (snapshot) {
          await mutatePool((p) => {
            const stored = findAccount(p, account.id)
            // Weekly resets are FIXED per-account anchors: an endpoint response
            // whose weekly window lost its reset time (`resets_at: null` after
            // an out-of-band quota reset) must not erase a previously seen
            // anchor — preserve it (rolled forward) so the scheduler keeps
            // ranking the account by its REAL, possibly imminent reset.
            //
            // A `null` window here means PRESENT-but-MALFORMED: both providers'
            // `endpointWindow` return null only for a non-finite/non-number
            // utilization (a genuinely ABSENT window maps to `{0, 0}`), exactly
            // so the scheduler does not read garbage as "full headroom". Honor
            // that contract on merge: keep the stored last-known window instead
            // of erasing it. `capturedAt` is weekly-scoped (types.ts) — a failed
            // weekly refresh must not stamp freshness, or the re-poll that
            // would heal it is suppressed for SEED_TTL_MS.
            if (stored)
              stored.usage = {
                hourly: snapshot.hourly ?? stored.usage.hourly,
                weekly:
                  snapshot.weekly === null
                    ? stored.usage.weekly
                    : preserveWeeklyAnchor(
                        snapshot.weekly,
                        stored.usage.weekly,
                        now,
                      ),
                capturedAt:
                  snapshot.weekly === null ? stored.usage.capturedAt : now,
              }
          })
        }
      } catch {
        // best-effort; ignore (per-account catch isolates failures — one
        // account's network error cannot poison the others' parallel polls)
      }
    }),
  )
}

/**
 * Refresh stale usage for ONE provider's accounts (see `refreshUsage`).
 *
 * Used by the flows that are inherently scoped to a single provider: the
 * OAuth login callback (only the just-added account matters) and each
 * provider plugin's startup seed, which awaits ITS provider's usage before
 * priming that provider's in-use marker. Ambient callers must NOT use this —
 * see `refreshAllUsageInBackground`.
 */
export function refreshUsageInBackground(
  adapter: ProviderAdapter,
  now: number,
  poolSnapshot?: PoolFile,
): Promise<void> {
  return refreshUsage([adapter], now, poolSnapshot)
}

/**
 * Refresh stale usage across EVERY registered provider (see `refreshUsage`).
 *
 * This is what the ambient callers — the request hot path and the
 * `auth_lb_status` dashboard — use, and the distinction is load-bearing:
 * usage converges to server-side truth from response headers (only for the
 * provider you are actually sending requests to) or from a usage-endpoint
 * poll. Scoping that poll to the requesting provider left an IDLE provider
 * with no refresh cycle whatsoever after its one startup seed, so working all
 * day in Claude froze the Codex numbers in the dashboard/TUI at whatever they
 * were when opencode launched (and vice versa). Refreshing the whole registry
 * instead costs nothing in the steady state — the per-account staleness gate
 * and `lastPoll` throttle inside `refreshUsage` are unchanged, so an idle
 * provider is polled at most once per SEED_TTL_MS and a fresh one not at all.
 */
export function refreshAllUsageInBackground(
  now: number,
  poolSnapshot?: PoolFile,
): Promise<void> {
  return refreshUsage(ADAPTERS, now, poolSnapshot)
}
