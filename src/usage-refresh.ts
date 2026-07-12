import { findAccount, mutatePool, readPool } from './pool/store'
import type { ProviderAdapter } from './providers/types'
import { ensureAccessToken } from './refresh'
import { isExhausted, loadScoreConfig } from './scheduler/score-core'
import type { PoolAccount, PoolFile } from './types'
import { preserveWeeklyAnchor } from './usage-merge'

const SEED_TTL_MS = 5 * 60 * 1000

/**
 * Max lifetime of a TRANSIENT (non-quota) cooldown. fetch.ts cools a thrown
 * network error or a header-less 429/402 for at most `ACCOUNT_COOLDOWN_MS`
 * (5min) and an auth 401/403 for `AUTH_COOLDOWN_MS` (2min); ONLY a quota 429's
 * `Retry-After` writes a cooldown beyond this. So a cooldown whose remainder
 * still exceeds this bound is necessarily quota-derived — the one class that can
 * outlive its own usage window after an out-of-band reset (see the stale-cooldown
 * reconciliation below). Kept `=== ACCOUNT_COOLDOWN_MS` by a drift-guard test;
 * defined locally because importing it from fetch.ts (which imports THIS module)
 * would form a cycle.
 */
export const MAX_TRANSIENT_COOLDOWN_MS = 5 * 60 * 1000

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
  // Collect the stale, poll-eligible subset in ONE synchronous loop — provider
  // filter, staleness gate, and `lastPoll` throttle fused. This runs once per
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
  let stale: PoolAccount[] | undefined
  for (const account of pool.accounts) {
    aliveIds?.add(account.id)
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
  if (aliveIds) {
    for (const id of lastPoll.keys()) if (!aliveIds.has(id)) lastPoll.delete(id)
  }
  if (!stale) return
  // Loaded once per poll batch (past the steady-state early-return above, so it
  // never runs on the request hot path), shared by the stale-cooldown
  // reconciliation inside the mutate below. `loadScoreConfig` reads the same
  // `OPENCODE_AUTH_LB_EXHAUSTED_AT` knob the scheduler uses, so "has headroom"
  // here means exactly "available" there.
  const scoreCfg = loadScoreConfig()
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
            if (stored) {
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
              // Self-heal a STALE long cooldown. A weekly-limit 429's
              // `Retry-After` latches `cooldownUntil` at the weekly reset
              // (`recordRotation` in fetch.ts), but Anthropic's out-of-band
              // resets zero the usage window early while NOTHING lowers
              // `cooldownUntil` except wall-clock — stranding a full-headroom
              // account as "cooldown" for days (both dashboards AND the
              // scheduler gate on this single field). This authoritative poll
              // just proved headroom, so drop the latch — but only when a REAL
              // fresh weekly reading arrived (not the retained-stale malformed
              // branch), the remainder still exceeds any transient backoff (so
              // it is necessarily quota-derived, not a live 5min/2min error
              // cooldown), and the merged usage is not exhausted. A genuinely
              // still-limited account re-cools on its next real 429 — the same
              // "re-poll, don't latch" contract `utilOf`/`isWindowExpired` keep.
              if (
                snapshot.weekly !== null &&
                stored.cooldownUntil > now + MAX_TRANSIENT_COOLDOWN_MS &&
                !isExhausted(stored, scoreCfg, now)
              )
                stored.cooldownUntil = 0
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
