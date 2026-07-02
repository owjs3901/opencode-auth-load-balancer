import { findAccount, mutatePool, readPool } from './pool/store'
import type { ProviderAdapter } from './providers/types'
import { ensureAccessToken } from './refresh'
import type { PoolAccount, PoolFile } from './types'
import { preserveWeeklyAnchor } from './usage-merge'

const SEED_TTL_MS = 5 * 60 * 1000

/** Per-account last poll time, to throttle usage-endpoint calls (which are themselves rate-limited). */
const lastPoll = new Map<string, number>()

/**
 * Best-effort: seed/refresh usage for accounts whose WEEKLY snapshot is missing or
 * stale (`capturedAt` is stamped only when a weekly window arrives — see
 * `applyUsagePartial` in fetch.ts), via the provider's dedicated usage endpoint.
 * Throttled per account (at most one poll per account per SEED_TTL_MS). Callers
 * invoke it fire-and-forget, so it adds no latency to the request path; failures
 * are swallowed — response headers remain the primary, always-fresh usage signal
 * and this fixes cold-start blindness AND out-of-band server-side resets (e.g. a
 * promotional weekly-quota reset) that response headers alone don't converge.
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
export async function refreshUsageInBackground(
  adapter: ProviderAdapter,
  now: number,
  poolSnapshot?: PoolFile,
): Promise<void> {
  const pool = poolSnapshot ?? (await readPool())
  // Prune `lastPoll` entries for accounts that no longer exist in the pool —
  // TUI-sidebar deletes (`deleteFromPool` in `auth-load-balancer-tui.view.tsx`)
  // remove the row but cannot reach into this module's throttle map, and
  // `addAccount` coins a fresh `randomUUID` per add, so a deleted account's id
  // would otherwise linger in `lastPoll` forever (a bounded but real leak —
  // never iterated for prune, never collected). Use `pool.accounts` (NOT the
  // `accounts` filter above) for the alive set so a *disabled* row keeps its
  // throttle slot — re-enabling it shouldn't immediately re-poll the usage
  // endpoint and risk its own rate limit. The `> pool.accounts.length` gate
  // keeps the steady-state hot path (no deletions) free; comparing against the
  // per-provider `accounts.length` would have misfired on every call in a
  // mixed pool (lastPoll spans BOTH providers but the filter narrows to one),
  // running the idempotent prune loop pointlessly. The prune itself is
  // O(lastPoll.size), bounded by the historical account count.
  if (lastPoll.size > pool.accounts.length) {
    const alive = new Set(pool.accounts.map((a) => a.id))
    for (const id of lastPoll.keys()) if (!alive.has(id)) lastPoll.delete(id)
  }
  // Collect the stale, poll-eligible subset in ONE synchronous loop — provider
  // filter, staleness gate, and `lastPoll` throttle fused. This runs once per
  // request (fire-and-forget from the fetch retry loop), and in the dominant
  // steady state — every account's weekly snapshot freshly captured from
  // response headers — the old shape still allocated a filter array, one async
  // closure + promise per account, and a `Promise.all` aggregate, only for
  // every closure to bail at its staleness gate. Now nothing allocates unless
  // an account is genuinely stale. The `lastPoll.set` stays here — before any
  // await — so re-entrant concurrent calls still short-circuit on the throttle.
  let stale: PoolAccount[] | undefined
  for (const account of pool.accounts) {
    if (account.providerID !== adapter.id || account.disabledReason) continue
    // Check staleness FIRST: in the steady state it is false, and the
    // `lastPoll` Map lookup would be dead weight on the per-request hot path.
    if (
      account.usage.capturedAt !== 0 &&
      now - account.usage.capturedAt <= SEED_TTL_MS
    )
      continue
    if ((lastPoll.get(account.id) ?? 0) > now - SEED_TTL_MS) continue
    lastPoll.set(account.id, now)
    stale ??= []
    stale.push(account)
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
    stale.map(async (account) => {
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
