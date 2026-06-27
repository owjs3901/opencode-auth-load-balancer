import { LockTimeoutError } from './pool/lock'
import { findAccount, mutatePool, PoolWriteError, readPool } from './pool/store'
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

/**
 * Run a post-response bookkeeping write that must NEVER fail the request it follows.
 * Usage/cooldown/session writes are best-effort: if the cross-process pool lock times
 * out or an atomic write fails, skip silently (the next request self-corrects) rather
 * than discarding an already-served response. Non-infrastructure errors still propagate.
 */
export async function bestEffort(
  what: string,
  op: () => Promise<unknown>,
): Promise<void> {
  try {
    await op()
  } catch (error) {
    if (error instanceof LockTimeoutError || error instanceof PoolWriteError) {
      log(`bookkeeping skipped (${what}): ${error.message}`)
      return
    }
    throw error
  }
}

async function recordUsage(
  adapter: ProviderAdapter,
  accountId: string,
  res: Response,
  now: number,
): Promise<void> {
  const partial = adapter.parseUsageHeaders(res.headers, now)
  await bestEffort('usage', () =>
    mutatePool((pool) => {
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
    }),
  )
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
  await bestEffort('cooldown', () =>
    mutatePool((pool) => {
      const account = findAccount(pool, accountId)
      if (account)
        account.cooldownUntil = Math.max(account.cooldownUntil, until)
    }),
  )
}

/** Pin a session to an account (preserving prompt cache) and prune stale assignments. */
async function assignSession(
  sessionKey: string | null,
  accountId: string,
  now: number,
  ttlMs: number,
): Promise<void> {
  if (!sessionKey) return
  const key = sessionKey
  await bestEffort('session', () =>
    mutatePool((pool) => {
      pool.sessions[key] = { accountId, updatedAt: now }
      for (const [k, value] of Object.entries(pool.sessions)) {
        if (now - value.updatedAt > ttlMs) delete pool.sessions[k]
      }
    }),
  )
}

export interface FetchHooks {
  /** Called with the account that successfully served a request (for toasts/logs). */
  onUse?: (providerID: string, account: PoolAccount) => void
}

/**
 * Build a provider-shaped 401 for the "pool has no usable account" case. We must
 * NOT fall through to the global fetch here: opencode handed auth control to this
 * plugin via `apiKey: ''`, so the SDK's default `x-api-key: ''` is the only thing on
 * the request — passing it through yields a misleading "x-api-key header is required"
 * upstream. A clean 401 surfaces the real cause (add or re-login an account) instead.
 */
function noUsableAccountResponse(providerID: string): Response {
  const message = `No usable ${providerID} account in the auth-load-balancer pool. Run "opencode auth login" to add or re-login an account.`
  const body =
    providerID === 'anthropic'
      ? { type: 'error', error: { type: 'authentication_error', message } }
      : { error: { type: 'authentication_error', message } }
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
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
    // Merge the user's request headers ONCE per request and reuse the result
    // throughout the retry loop (clone via `new Headers(baseHeaders)` per
    // attempt so each attempt's `applyAuth` mutation stays isolated). Before
    // this hoist, `mergeHeaders(input, init)` was called 1 + MAX_ATTEMPTS
    // times per request (once for deriveSessionKey, once per retry attempt)
    // and `headers.delete(SESSION_HEADER)` ran defensively on every attempt
    // even though the value to strip is deterministic from input/init.
    const baseHeaders = mergeHeaders(input, init)
    // Namespace the session-affinity key by providerID so a single opencode
    // session that alternates between providers (e.g. Claude on one turn, Codex
    // on the next) keeps a SEPARATE pin per provider. Without the namespace
    // both providers derive the same `s:<sessionID>` key, the second turn's
    // write overwrites the first provider's pin, and the original provider's
    // next turn loses its prompt-cache affinity. `deriveSessionKey` itself
    // stays provider-agnostic; the prefix is layered above it at the call site.
    const baseKey = deriveSessionKey(baseHeaders, bodyStr)
    const sessionKey = baseKey ? `${adapter.id}:${baseKey}` : null
    // Strip the internal routing header ONCE — it must never reach upstream.
    // The clone in the loop inherits the absence, so retry attempts cannot
    // accidentally re-introduce it.
    baseHeaders.delete(SESSION_HEADER)
    const tried = new Set<string>()
    let lastError: unknown = null

    // `bodyStr` is captured from the enclosing closure and never reassigned, so its
    // UTF-8 byte length is fixed per request. Hoist it out of the retry loop so it
    // is computed ONCE (not up to MAX_ATTEMPTS times) and the "this is the request
    // body's size" intent is explicit at the call site. The CJK cost-gate
    // regression lock in plugin.test.ts exercises this value on both the
    // gate-held and gate-passed branches.
    const requestBytes = bodyStr ? Buffer.byteLength(bodyStr, 'utf8') : 0

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
        requestBytes,
      )
      if (!selection) {
        // Exhausted every candidate this request, or none exist for this provider.
        if (tried.size > 0) break
        if (lastError) throw lastError
        // No usable account: return a clean 401 rather than leaking the SDK's empty
        // x-api-key through the global fetch (see noUsableAccountResponse).
        return noUsableAccountResponse(adapter.id)
      }

      const { account, degraded, sticky } = selection
      tried.add(account.id)

      try {
        await ensureAccessToken(adapter, account, now)

        // Clone the pre-computed base so each attempt's `applyAuth` mutation
        // (the per-account Bearer token) stays isolated from sibling attempts
        // and from the captured base. `SESSION_HEADER` was already stripped
        // from `baseHeaders` above, so the clone inherits the absence.
        const headers = new Headers(baseHeaders)
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
        // A client-side abort (opencode restarting, or the user cancelling the turn) is
        // NOT the account's fault: cooling it down would sideline a healthy account for
        // AUTH_COOLDOWN_MS, and rotating would spend a fresh account re-sending an
        // already-abandoned request. When several requests are in flight at shutdown this
        // otherwise cools EVERY account at once. Propagate the abort untouched instead.
        const aborted =
          init?.signal?.aborted === true ||
          (error instanceof Error && error.name === 'AbortError')
        if (aborted) throw error
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
