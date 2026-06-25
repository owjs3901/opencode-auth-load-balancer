import { findAccount, mutatePool, readPool } from './pool/store'
import { mergeHeaders } from './providers/headers'
import type { FetchInput, ProviderAdapter } from './providers/types'
import { ensureAccessToken } from './refresh'
import { loadConfig } from './scheduler/config'
import { selectForSession } from './scheduler/select'
import { deriveSessionKey, SESSION_HEADER } from './session'
import type { PoolAccount } from './types'
import { refreshUsageInBackground } from './usage-refresh'
import { ignore } from './util'

/** Max distinct accounts to try for a single logical request before giving up. */
const MAX_ATTEMPTS = 4
const ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000
const AUTH_COOLDOWN_MS = 2 * 60 * 1000

const DEBUG =
  process.env.OPENCODE_AUTH_LB_DEBUG === '1' ||
  process.env.OPENCODE_AUTH_LB_DEBUG === 'true'

function log(message: string): void {
  if (DEBUG) console.error(`[auth-lb] ${message}`)
}

async function recordUsage(
  adapter: ProviderAdapter,
  accountId: string,
  res: Response,
  now: number,
): Promise<void> {
  const partial = adapter.parseUsageHeaders(res.headers, now)
  await mutatePool((pool) => {
    const account = findAccount(pool, accountId)
    if (!account) return
    if (partial) {
      if (partial.hourly !== undefined) account.usage.hourly = partial.hourly
      if (partial.weekly !== undefined) account.usage.weekly = partial.weekly
      if (partial.status !== undefined) account.usage.status = partial.status
      account.usage.capturedAt = now
    }
    account.lastUsedAt = now
    pool.lastSelected[adapter.id] = accountId
  })
}

async function applyCooldown(
  accountId: string,
  fallbackMs: number,
  res: Response | null,
): Promise<void> {
  const now = Date.now()
  let until = now + fallbackMs
  const retryAfter = res?.headers.get('retry-after')
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs) && secs > 0) {
      // Guard: `secs` like 1e308 is itself finite, but `secs * 1000` exceeds
      // Number.MAX_VALUE (~1.798e308) and collapses to +Infinity, which would
      // set `cooldownUntil` to +Infinity and permanently sideline the account
      // (`account.cooldownUntil > now` would be true forever). Fall through to
      // the `fallbackMs` default in that case.
      const delta = secs * 1000
      if (Number.isFinite(delta)) until = now + delta
    } else {
      // RFC 9110 §10.2.3: Retry-After MAY be HTTP-date instead of delay-seconds.
      const httpDate = Date.parse(retryAfter)
      if (Number.isFinite(httpDate) && httpDate > now) until = httpDate
    }
  }
  await mutatePool((pool) => {
    const account = findAccount(pool, accountId)
    if (account) account.cooldownUntil = Math.max(account.cooldownUntil, until)
  })
}

/** Pin a session to an account (preserving prompt cache) and prune stale assignments. */
async function assignSession(
  sessionKey: string | null,
  accountId: string,
  now: number,
  ttlMs: number,
): Promise<void> {
  if (!sessionKey) return
  await mutatePool((pool) => {
    pool.sessions[sessionKey] = { accountId, updatedAt: now }
    for (const [key, value] of Object.entries(pool.sessions)) {
      if (now - value.updatedAt > ttlMs) delete pool.sessions[key]
    }
  })
}

export interface FetchHooks {
  /** Called with the account that successfully served a request (for toasts/logs). */
  onUse?: (providerID: string, account: PoolAccount) => void
}

/**
 * Build a `fetch`-compatible function that load-balances every request for one
 * provider across the pooled accounts. Returned from an adapter's auth.loader and
 * handed to opencode's provider SDK, so it sits on the path of every API call.
 *
 * Per call: derive the session key -> pick the session's pinned account (or, if it
 * is unavailable, the highest weekly-urgency account) -> ensure a fresh token ->
 * apply auth + body/url transforms -> fetch -> record usage. On a rate-limit/auth
 * error the account is cooled down and the next-best account is tried; a successful
 * response re-pins the session to the account that served it and reports it via onUse.
 */
export function createLoadBalancedFetch(
  adapter: ProviderAdapter,
  hooks: FetchHooks = {},
): typeof fetch {
  const cfg = loadConfig()

  return (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined
    const sessionKey = deriveSessionKey(mergeHeaders(input, init), bodyStr)
    const tried = new Set<string>()
    let lastError: unknown = null

    // Cold-start / staleness seeding (throttled, fire-and-forget — no added latency).
    void refreshUsageInBackground(adapter, Date.now()).catch(ignore)

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const now = Date.now()
      const pool = await readPool()

      const selection = selectForSession(
        pool,
        adapter.id,
        sessionKey,
        now,
        cfg,
        tried,
        bodyStr ? Buffer.byteLength(bodyStr, 'utf8') : 0,
      )
      if (!selection) {
        // Exhausted every candidate this request, or none exist for this provider.
        if (tried.size > 0) break
        if (lastError) throw lastError
        // No pooled accounts: defer to default fetch so the provider's own auth works.
        return fetch(input as Parameters<typeof fetch>[0], init)
      }

      const { account, degraded, sticky } = selection
      tried.add(account.id)

      try {
        await ensureAccessToken(adapter, account, now)

        const headers = mergeHeaders(input, init)
        headers.delete(SESSION_HEADER) // internal routing header; never sent upstream
        adapter.applyAuth(headers, account)

        let body = init?.body
        if (typeof body === 'string') body = adapter.transformBody(body)

        const url = adapter.transformUrl(input)
        log(
          `-> ${adapter.id} via ${account.label}${sticky ? ' (sticky)' : ''}${degraded ? ' (degraded)' : ''}`,
        )

        const res = await fetch(url as Parameters<typeof fetch>[0], {
          ...init,
          body,
          headers,
        })
        await recordUsage(adapter, account.id, res, Date.now())

        const cls = adapter.classifyError(res.status)
        if (cls === 'account' || cls === 'auth') {
          const ms = cls === 'auth' ? AUTH_COOLDOWN_MS : ACCOUNT_COOLDOWN_MS
          await applyCooldown(account.id, ms, res)
          lastError = new Error(
            `${adapter.id} account "${account.label}" returned ${res.status}`,
          )
          log(`!! ${account.label} ${res.status} (${cls}) -> rotating`)
          await res.body?.cancel().catch(ignore)
          continue
        }

        hooks.onUse?.(adapter.id, account)
        await assignSession(
          sessionKey,
          account.id,
          Date.now(),
          cfg.sessionTtlMs,
        )
        return adapter.transformResponse(res)
      } catch (error) {
        lastError = error
        if (!account.disabledReason)
          await applyCooldown(account.id, AUTH_COOLDOWN_MS, null)
        log(
          `!! ${account.label} threw: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
    }

    throw (
      lastError ??
      new Error(`${adapter.id}: no usable account in the load-balancer pool`)
    )
  }) as typeof fetch
}
