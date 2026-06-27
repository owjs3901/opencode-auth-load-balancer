import { findAccount, mutatePool, readPool } from './pool/store'
import type { ProviderAdapter } from './providers/types'
import { ensureAccessToken } from './refresh'

const SEED_TTL_MS = 5 * 60 * 1000

/** Per-account last poll time, to throttle usage-endpoint calls (which are themselves rate-limited). */
const lastPoll = new Map<string, number>()

/**
 * Best-effort: seed/refresh usage for accounts whose snapshot is missing or stale,
 * via the provider's dedicated usage endpoint. Throttled per account (at most one
 * poll per account per SEED_TTL_MS). Callers invoke it fire-and-forget, so it adds
 * no latency to the request path; failures are swallowed — response headers remain
 * the primary, always-fresh usage signal and this only fixes cold-start blindness.
 *
 * Returns a promise (for tests / explicit awaiting); request-path callers ignore it.
 */
export async function refreshUsageInBackground(
  adapter: ProviderAdapter,
  now: number,
): Promise<void> {
  const pool = await readPool()
  const accounts = pool.accounts.filter(
    (a) => a.providerID === adapter.id && !a.disabledReason,
  )
  // Parallelize across accounts: per-account refresh locks in `refresh.ts` are
  // keyed by (providerID, accountId), so distinct accounts never contend; and
  // `mutatePool` already serializes via the in-process chain mutex + cross-process
  // file lock, so concurrent calls degrade to sequential atomicity automatically.
  // Cold-start seeding for an N-account pool drops from O(N) sequential 30 s
  // timeouts (OAUTH_HTTP_TIMEOUT_MS + USAGE_HTTP_TIMEOUT_MS per account, summed)
  // to a single worst-case window. The throttle write below stays BEFORE the
  // awaits so re-entrant concurrent calls still short-circuit on `polledRecently`.
  await Promise.all(
    accounts.map(async (account) => {
      const stale =
        account.usage.capturedAt === 0 ||
        now - account.usage.capturedAt > SEED_TTL_MS
      const polledRecently = (lastPoll.get(account.id) ?? 0) > now - SEED_TTL_MS
      if (!stale || polledRecently) return
      lastPoll.set(account.id, now)
      try {
        await ensureAccessToken(adapter, account, Date.now())
        const snapshot = await adapter.fetchUsage(account, Date.now())
        if (snapshot) {
          await mutatePool((p) => {
            const stored = findAccount(p, account.id)
            if (stored) stored.usage = snapshot
          })
        }
      } catch {
        // best-effort; ignore (per-account catch isolates failures — one
        // account's network error cannot poison the others' parallel polls)
      }
    }),
  )
}
