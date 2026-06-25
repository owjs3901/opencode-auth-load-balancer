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
  for (const account of accounts) {
    const stale =
      account.usage.capturedAt === 0 ||
      now - account.usage.capturedAt > SEED_TTL_MS
    const polledRecently = (lastPoll.get(account.id) ?? 0) > now - SEED_TTL_MS
    if (!stale || polledRecently) continue
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
      // best-effort; ignore
    }
  }
}
