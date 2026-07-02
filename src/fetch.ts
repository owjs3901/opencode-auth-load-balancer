import { LockTimeoutError } from './pool/lock'
import {
  findAccount,
  mutatePool,
  PoolReadError,
  PoolWriteError,
  readPool,
} from './pool/store'
import { PROVIDER_ID as ANTHROPIC_PROVIDER_ID } from './providers/anthropic/constants'
import { mergeHeaders } from './providers/headers'
import type { FetchInput, ProviderAdapter } from './providers/types'
import { ensureAccessToken } from './refresh'
import { loadConfig } from './scheduler/config'
import { selectForSession } from './scheduler/select'
import { deriveSessionKey, SESSION_HEADER } from './session'
import type { PoolAccount, UsageSnapshot } from './types'
import { preserveWeeklyAnchor } from './usage-merge'
import { refreshUsageInBackground } from './usage-refresh'
import { ignore, sleepAbortable } from './util'

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
    if (
      error instanceof LockTimeoutError ||
      error instanceof PoolReadError ||
      error instanceof PoolWriteError
    ) {
      log(`bookkeeping skipped (${what}): ${error.message}`)
      return
    }
    throw error
  }
}

/**
 * Merge a parsed usage partial into an account's usage snapshot in place. Shared
 * by `recordUsage` (rotation path) and `recordSuccess` (success path) so the
 * field-merge contract lives in ONE place and the two paths can never diverge.
 * Only defined fields overwrite.
 *
 * `capturedAt` is stamped ONLY when the partial actually delivered a WEEKLY
 * window. `capturedAt` is the gate `refreshUsageInBackground` uses to decide
 * whether the authoritative usage endpoint must be re-polled, and weekly is the
 * PRIMARY scheduling signal that poll exists to backfill. Stamping it on a
 * weekly-less partial (e.g. a response carrying only 5h/status headers — seen
 * after Anthropic's out-of-band "special" weekly resets, when a fresh empty
 * weekly window has nothing to report) marked the snapshot "fresh" without
 * refreshing the weekly field, so the endpoint was never consulted and a stale
 * pre-reset weekly value persisted indefinitely on the actively-used account.
 */
function applyUsagePartial(
  account: PoolAccount,
  partial: Partial<UsageSnapshot>,
  now: number,
): void {
  if (partial.hourly !== undefined) account.usage.hourly = partial.hourly
  if (partial.status !== undefined) account.usage.status = partial.status
  if (partial.weekly !== undefined) {
    // Weekly resets are FIXED per-account anchors: when the incoming window
    // carries no reset time (post-reset headers/endpoint), keep the previously
    // seen anchor (rolled forward) instead of downgrading to "unknown".
    account.usage.weekly = preserveWeeklyAnchor(
      partial.weekly,
      account.usage.weekly,
      now,
    )
    account.usage.capturedAt = now
  }
}

/**
 * Compute the absolute cooldown target (epoch ms) for a rejected response.
 * Defaults to `now + fallbackMs`, but honors `Retry-After` (RFC 9110 §10.2.3):
 * either delay-seconds or an HTTP-date. Pure (takes `now` explicitly) so both
 * the standalone `applyCooldown` and the folded `recordRotation` write share
 * the exact same parsing + overflow-guard math instead of re-implementing it.
 */
function cooldownUntilFrom(
  res: Response | null,
  fallbackMs: number,
  now: number,
): number {
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
  return until
}

async function applyCooldown(
  accountId: string,
  fallbackMs: number,
): Promise<void> {
  // No response to consult (this path handles THROWN network errors), so
  // `cooldownUntilFrom(null, …)` reduces to exactly `now + fallbackMs` —
  // routed through the shared helper so the doc contract above stays true.
  const until = cooldownUntilFrom(null, fallbackMs, Date.now())
  await bestEffort('cooldown', () =>
    mutatePool((pool) => {
      const account = findAccount(pool, accountId)
      if (account)
        account.cooldownUntil = Math.max(account.cooldownUntil, until)
    }),
  )
}

/**
 * Fold the rotation path's two pool writes (`recordUsage` + `applyCooldown`)
 * into ONE atomic `mutatePool`. On a 429/`account` rotation the response carries
 * usage headers AND we must cool the account down before the next attempt; the
 * two effects touch disjoint fields (`usage.*` vs `cooldownUntil`), are
 * commutative, and both must land before retrying — so a single lock+rewrite
 * cycle suffices instead of two, mirroring `recordSuccess` on the success path.
 * This halves post-response lock cycles during a rate-limit storm (the most
 * lock-contended moment). `cooldownUntilFrom` is read with the SAME `now` used
 * for the usage stamp so the write is internally consistent. `bestEffort` still
 * swallows `LockTimeoutError` / `PoolWriteError` so a bookkeeping failure never
 * fails an already-served response.
 */
async function recordRotation(
  adapter: ProviderAdapter,
  accountId: string,
  res: Response,
  fallbackMs: number,
  now: number,
): Promise<void> {
  const partial = adapter.parseUsageHeaders(res.headers)
  const until = cooldownUntilFrom(res, fallbackMs, now)
  await bestEffort('rotation', () =>
    mutatePool((pool) => {
      const account = findAccount(pool, accountId)
      if (!account) return
      if (partial) applyUsagePartial(account, partial, now)
      account.cooldownUntil = Math.max(account.cooldownUntil, until)
    }),
  )
}

/**
 * Fold the success path's two pool writes (`recordUsage` + session pin / TTL prune)
 * into ONE atomic `mutatePool` callback. Each `mutatePool` acquires the in-process
 * mutex AND the cross-process pool file lock, then reads + atomically rewrites
 * `auth-load-balancer.json` — doing it twice per successful request (the dominant
 * code path in production) doubled the post-response I/O lock cycles for no
 * benefit, since the two effects touch disjoint pool fields and are commutative.
 *
 * Semantics are preserved exactly:
 *  - `findAccount` returns null (account deleted mid-write) -> skip usage AND
 *    `lastSelected` (matches `recordUsage`'s `if (!account) return` guard) but
 *    still update the session pin (matches the old `assignSession`'s behavior,
 *    which never consulted the account list).
 *  - `sessionKey === null` -> skip the session pin entirely (matches
 *    `assignSession`'s `if (!sessionKey) return` short-circuit).
 *  - `bestEffort` still swallows `LockTimeoutError` / `PoolWriteError` so a
 *    bookkeeping failure never fails an already-served response.
 *
 * The failure path keeps using the standalone `recordUsage` + `applyCooldown`
 * pair (recordUsage now lives inside the rotation branch so we don't pay it on
 * a request that succeeds first try).
 *
 * `partial` arrives PRE-PARSED from the success branch (which also applies it
 * to its local account object before `hooks.onUse`, so the switch toast shows
 * the response's fresh usage) — the headers are still parsed exactly once.
 */
async function recordSuccess(
  adapter: ProviderAdapter,
  accountId: string,
  partial: Partial<UsageSnapshot> | null,
  sessionKey: string | null,
  now: number,
  ttlMs: number,
): Promise<void> {
  await bestEffort('record-success', () =>
    mutatePool((pool) => {
      const account = findAccount(pool, accountId)
      if (account) {
        if (partial) applyUsagePartial(account, partial, now)
        pool.lastSelected[adapter.id] = accountId
      }
      if (sessionKey) {
        pool.sessions[sessionKey] = { accountId, updatedAt: now }
        for (const [k, value] of Object.entries(pool.sessions)) {
          if (now - value.updatedAt > ttlMs) delete pool.sessions[k]
        }
      }
    }),
  )
}

interface FetchHooks {
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
  const error = { type: 'authentication_error', message }
  const body =
    providerID === ANTHROPIC_PROVIDER_ID ? { type: 'error', error } : { error }
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Earliest epoch-ms at which one of `accountIds` recovers from an `account`-class
 * (429/402) cooldown. Considers ONLY those ids (the accounts THIS request cooled via a
 * 429/402) — an auth cooldown or a thrown network error is NOT recoverable by waiting,
 * so those are never passed in. Returns null when none of them is still cooling (the
 * pool won't self-heal, so the caller fails fast instead of blocking).
 */
function soonestCooldownUntil(
  accounts: PoolAccount[],
  providerID: string,
  now: number,
  accountIds: ReadonlySet<string>,
): number | null {
  if (accountIds.size === 0) return null
  let soonest = Number.POSITIVE_INFINITY
  for (const account of accounts) {
    if (account.providerID !== providerID) continue
    if (account.disabledReason) continue
    if (!accountIds.has(account.id)) continue
    if (account.cooldownUntil <= now) continue
    if (account.cooldownUntil < soonest) soonest = account.cooldownUntil
  }
  return Number.isFinite(soonest) ? soonest : null
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
    // Accounts cooled by an `account`-class 429/402 THIS request — the only cooldowns
    // worth WAITING out (they reflect a real Retry-After / quota window that WILL clear).
    // Auth (401/403) cooldowns and thrown network errors are NOT added, so the wait path
    // below never blocks on a credential problem or a client abort.
    const waitableCooldownIds = new Set<string>()
    let lastError: unknown = null

    // `bodyStr` is captured from the enclosing closure and never reassigned, so its
    // UTF-8 byte length is fixed per request. Hoist it out of the retry loop so it
    // is computed ONCE (not up to MAX_ATTEMPTS times) and the "this is the request
    // body's size" intent is explicit at the call site. The CJK cost-gate
    // regression lock in plugin.test.ts exercises this value on both the
    // gate-held and gate-passed branches.
    // Skip the UTF-8 walk entirely when the cost gate is DISABLED
    // (`cheapSwitchMaxBytes <= 0` — an explicit opt-out, NO LONGER the default):
    // a `<= 0` gate makes every moment "cheap", so `selectForSession` never reads
    // `requestBytes`, and a full UTF-8 walk of a 100+ KB body would be pure waste.
    // With the gate ON by default (64 KiB) the walk runs per request — a native,
    // allocation-free length the gate genuinely needs to size the request.
    const requestBytes =
      cfg.cheapSwitchMaxBytes > 0 && bodyStr
        ? Buffer.byteLength(bodyStr, 'utf8')
        : 0

    // `transformBody` / `transformUrl` are deterministic in `bodyStr` / `input`,
    // which are captured once and never reassigned across attempts. Both
    // transforms also catch their own parse errors (Anthropic
    // `rewriteRequestBody` / `rewriteUrl` and OpenAI siblings each `try {…}
    // catch { return body|input }`), so the hoist cannot introduce a new throw
    // path. Before this hoist each retry attempt re-ran the full transform pass
    // — on Anthropic that meant `JSON.parse` + CCH SHA-256 + identity prepend +
    // tool-name prefixing + `JSON.stringify` + a `new URL(...)` clone + a
    // `resolveBaseUrl()` re-read of `ANTHROPIC_BASE_URL`; on OpenAI it meant
    // `JSON.parse` + `applyInstructions` + `include` Set merge + `JSON.stringify`
    // + `new URL(...)` + `/responses` rewrite. With this hoist that work runs
    // once per request, not up to MAX_ATTEMPTS times during a 429/401 rotation.
    const transformedBody =
      bodyStr !== undefined ? adapter.transformBody(bodyStr) : init?.body
    const transformedUrl = adapter.transformUrl(input)

    // Cold-start / staleness seeding fires once per request, inside the loop —
    // reusing the loop's own pool read instead of paying a second serialized
    // file read + JSON.parse per request (see the flag at the readPool below).
    let usageSeeded = false

    // Wall-clock budget for BLOCKING on a fully-rate-limited pool (see below). The
    // deadline is fixed at request start so the total wait can never exceed maxWaitMs
    // no matter how many rotate/wait rounds run.
    const requestStart = Date.now()
    const waitBudgetMs = Math.max(0, cfg.maxWaitMs)
    const waitDeadline = requestStart + waitBudgetMs

    // Rounds, not a fixed attempt cap: `tried` bounds each round (once every account is
    // tried, selectForSession returns null and the round ends), and `waitDeadline`
    // bounds the whole request across wait-and-retry rounds.
    for (;;) {
      const now = Date.now()
      const pool = await readPool()

      // Cold-start / staleness seeding (throttled, fire-and-forget — no added
      // latency). Passes THIS iteration's pool snapshot so the seeding path
      // adds no extra pool read on the request hot path; only the first round
      // fires, so a 429-rotation retry doesn't re-trigger it.
      if (!usageSeeded) {
        usageSeeded = true
        void refreshUsageInBackground(adapter, now, pool).catch(ignore)
      }

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
        // No account exists for this provider at all: return a clean 401 rather than
        // leaking the SDK's empty x-api-key through the global fetch (see
        // noUsableAccountResponse).
        if (tried.size === 0) return noUsableAccountResponse(adapter.id)

        // Every account we tried is rate-limited. Instead of failing the turn abruptly,
        // WAIT for the soonest `account`-class (429/402) cooldown to expire — honoring
        // Retry-After — when it lands within the wait budget, then retry with a clean
        // slate. `sleepAbortable` wakes instantly on a client abort (opencode cancelling
        // the turn); that rejection propagates untouched, matching the abort handling in
        // the fetch catch below. When nothing recoverable is left (no waitable cooldown,
        // or it is beyond the budget) we fall through and throw the last error as before.
        // The O(accounts) scan runs only when waiting is enabled at all
        // (`maxWaitMs=0` is the explicit fail-fast opt-out) — don't compute a
        // resume point that could never be used.
        if (waitBudgetMs > 0) {
          const resumeAt = soonestCooldownUntil(
            pool.accounts,
            adapter.id,
            now,
            waitableCooldownIds,
          )
          if (resumeAt !== null && resumeAt <= waitDeadline) {
            await sleepAbortable(resumeAt - now, init?.signal ?? undefined)
            tried.clear()
            waitableCooldownIds.clear()
            continue
          }
        }
        break
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

        log(
          `-> ${adapter.id} via ${account.label}${sticky ? ' (sticky)' : ''}${degraded ? ' (degraded)' : ''}`,
        )

        const res = await fetch(transformedUrl, {
          ...init,
          body: transformedBody,
          headers,
        })

        // Split usage recording across the two outcomes so the dominant
        // success path needs only ONE pool write (combined with the session
        // pin via `recordSuccess`) instead of two. On rotation we fold the
        // usage record + cooldown into ONE pool write via `recordRotation`
        // (disjoint, commutative fields that both must land before retrying),
        // halving post-response lock cycles during a rate-limit storm.
        const cls = adapter.classifyError(res.status)
        if (cls === 'account' || cls === 'auth') {
          const ms = cls === 'auth' ? AUTH_COOLDOWN_MS : ACCOUNT_COOLDOWN_MS
          // Fresh Date.now(), NOT the loop-start `now`: that was captured before
          // ensureAccessToken (up to a 30 s network refresh) and the upstream
          // fetch, so basing the cooldown on it would understate `Retry-After`
          // by the request latency and retry the account before the server
          // said it may be. The success path already stamps response time.
          await recordRotation(adapter, account.id, res, ms, Date.now())
          // Only an `account`-class (429/402) cooldown is worth waiting out; an auth
          // (401/403) failure needs a re-login, not time, so it stays out of the set.
          if (cls === 'account') waitableCooldownIds.add(account.id)
          lastError = new Error(
            `${adapter.id} account "${account.label}" returned ${res.status}`,
          )
          log(`!! ${account.label} ${res.status} (${cls}) -> rotating`)
          await res.body?.cancel().catch(ignore)
          continue
        }

        // Parse the response's usage headers ONCE, here, and apply them to the
        // LOCAL account object before `onUse` fires: the switch toast (which by
        // definition fires on the first request to an account in a while) then
        // shows the response's fresh percentages instead of the pre-request
        // snapshot read at loop start. The same partial is handed to
        // `recordSuccess` so the stored-row merge is unchanged.
        const successNow = Date.now()
        const partial = adapter.parseUsageHeaders(res.headers)
        if (partial) applyUsagePartial(account, partial, successNow)
        hooks.onUse?.(adapter.id, account)
        await recordSuccess(
          adapter,
          account.id,
          partial,
          sessionKey,
          successNow,
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
          await applyCooldown(account.id, AUTH_COOLDOWN_MS)
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
