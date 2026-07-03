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
import { MAX_QUOTA_RESET_BOUND_MS } from './providers/http-timeouts'
import type {
  FetchInput,
  ModelFallback,
  ProviderAdapter,
} from './providers/types'
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
 * out, the pool file cannot be read, or an atomic write fails, skip silently (the next
 * request self-corrects) rather than discarding an already-served response.
 * Non-infrastructure errors still propagate.
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
 * by FOUR call sites — `recordRotation` (rotation path, stored row),
 * `recordModelCooldown` (tier-cooldown path, stored row), `recordSuccess`
 * (success path, stored row), and the success path's local pre-`onUse` apply
 * (on the request's in-memory account object, so the switch toast shows the
 * response's fresh percentages) — so the field-merge contract lives in ONE
 * place and the paths can never diverge. Only defined fields overwrite.
 *
 * `capturedAt` is stamped ONLY when the partial actually delivered a WEEKLY
 * window. `capturedAt` is the gate `refreshUsageInBackground` uses to decide
 * whether the authoritative usage endpoint must be re-polled, and weekly is the
 * PRIMARY scheduling signal that poll exists to backfill. Stamping it on a
 * weekly-less partial (e.g. a response carrying only 5h headers — seen
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

// Real quota-driven Retry-After values are bounded by the weekly usage window
// (≤ 7 days). Anything past this bound is a broken server/proxy and is treated
// exactly like the +Infinity overflow case: fall through to the `fallbackMs`
// default (which self-heals) instead of sidelining the account for years.
// Single-sourced with `fallback.ts`'s `TIER_RESET_MAX_MS` — same invariant.
const RETRY_AFTER_MAX_MS = MAX_QUOTA_RESET_BOUND_MS

/**
 * Compute the absolute cooldown target (epoch ms) for a rejected response.
 * Defaults to `now + fallbackMs`, but honors `Retry-After` (RFC 9110 §10.2.3):
 * either delay-seconds or an HTTP-date — each bounded by `RETRY_AFTER_MAX_MS`,
 * so a bogus value can never sideline an account past any real quota window.
 * Pure (takes `now` explicitly) so both the standalone `applyCooldown` and the
 * folded `recordRotation` write share the exact same parsing + overflow-guard
 * math instead of re-implementing it.
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
      // (`account.cooldownUntil > now` would be true forever). A finite-but-
      // absurd delta (e.g. `Retry-After: 1e10` → ~317 years) sidelines the
      // account just as permanently, so both fall through to the `fallbackMs`
      // default via the RETRY_AFTER_MAX_MS bound. (`NaN <= x` is false, so the
      // single comparison also rejects the Infinity case; Number.isFinite stays
      // for clarity.)
      const delta = secs * 1000
      if (Number.isFinite(delta) && delta <= RETRY_AFTER_MAX_MS)
        until = now + delta
    } else {
      // RFC 9110 §10.2.3: Retry-After MAY be HTTP-date instead of delay-seconds.
      // Same bound: a far-future date (broken server clock/proxy) must not
      // sideline the account past any real quota window.
      const httpDate = Date.parse(retryAfter)
      if (
        Number.isFinite(httpDate) &&
        httpDate > now &&
        httpDate - now <= RETRY_AFTER_MAX_MS
      )
        until = httpDate
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
 * Fold the rotation path's usage record + cooldown into ONE atomic
 * `mutatePool`. On a 429/`account` rotation the response carries
 * usage headers AND we must cool the account down before the next attempt; the
 * two effects touch disjoint fields (`usage.*` vs `cooldownUntil`), are
 * commutative, and both must land before retrying — so a single lock+rewrite
 * cycle suffices instead of two, mirroring `recordSuccess` on the success path.
 * This halves post-response lock cycles during a rate-limit storm (the most
 * lock-contended moment). `cooldownUntilFrom` is read with the SAME `now` used
 * for the usage stamp so the write is internally consistent. `bestEffort` still
 * swallows `LockTimeoutError` / `PoolReadError` / `PoolWriteError` so a
 * bookkeeping failure never fails an already-served response.
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
 * Persist an account's MODEL-TIER cooldown (epoch ms until that tier's weekly
 * cap resets, keyed by tier — "opus", "fable", …) WITHOUT touching the
 * account-wide `cooldownUntil`. Deliberately separate from `recordRotation`: a
 * tier 429 does NOT sideline the account (it still serves every other model;
 * the current request rotates to an account with tier headroom, or downgrades
 * once the whole pool proves limited) — this write lets FUTURE requests for
 * the tier steer around the account proactively. Best-effort like every other
 * bookkeeping write: a lock/read/write skip just means the next request
 * re-discovers the limit via one more 429.
 *
 * `partial` is the tier-429 response's parsed usage headers: both sibling
 * outcomes of an Anthropic response record theirs (`recordRotation` on
 * rotation, `recordSuccess` on success), and this write is ALREADY holding the
 * pool lock — folding the fresh 5h/7d numbers in here (disjoint, commutative
 * fields; zero extra I/O) keeps the scheduler ranking on them even when the
 * rest of the request subsequently fails or throws.
 */
async function recordModelCooldown(
  accountId: string,
  tier: string,
  until: number,
  partial: Partial<UsageSnapshot> | null,
  now: number,
): Promise<void> {
  await bestEffort('model-cooldown', () =>
    mutatePool((pool) => {
      const account = findAccount(pool, accountId)
      if (!account) return
      if (partial) applyUsagePartial(account, partial, now)
      const map = (account.modelCooldownsUntil ??= {})
      map[tier] = Math.max(map[tier] ?? 0, until)
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
 *    `lastSelected` (matches the old `recordUsage`'s `if (!account) return` guard) but
 *    still update the session pin (matches the old `assignSession`'s behavior,
 *    which never consulted the account list).
 *  - `sessionKey === null` -> skip the session pin entirely (matches
 *    `assignSession`'s `if (!sessionKey) return` short-circuit).
 *  - `bestEffort` still swallows `LockTimeoutError` / `PoolReadError` /
 *    `PoolWriteError` so a bookkeeping failure never fails an already-served
 *    response.
 *
 * The failure paths differ: the thrown-error path uses the standalone
 * `applyCooldown` (no response headers to record), while the 429/auth rotation
 * path folds usage + cooldown into `recordRotation`.
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
        // Object.keys, not Object.entries: this TTL prune runs on EVERY
        // successful request, and entries allocates one 2-element tuple per
        // session on top of the outer array for data a keyed read gets free.
        // (`pin` is always defined for a key from Object.keys; the guard just
        // satisfies noUncheckedIndexedAccess without a `!` escape.)
        for (const k of Object.keys(pool.sessions)) {
          const pin = pool.sessions[k]
          if (pin && now - pin.updatedAt > ttlMs) delete pool.sessions[k]
        }
      }
    }),
  )
}

interface FetchHooks {
  /** Called with the account that successfully served a request (for toasts/logs). */
  onUse?: (providerID: string, account: PoolAccount) => void
  /**
   * Called on a successful request whose model was auto-downgraded to a fallback
   * (Opus/Fable→Sonnet) because the requested MODEL TIER's weekly cap is
   * exhausted on every candidate account. Drives the user-facing "model
   * switched" toast so the downgrade is never silent.
   */
  onModelFallback?: (
    providerID: string,
    account: PoolAccount,
    fromModel: string,
    toModel: string,
    fromTier?: string,
  ) => void
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
 * so those are never passed in. The ids come from `selectForSession` for THIS
 * provider in the same request, so no provider filter is needed here. A waitable
 * cooldown that ALREADY expired (a short Retry-After elapsed during the rest of
 * the round — other accounts' fetch round-trips, pool I/O) counts as "resume
 * now": the account is usable again, so failing the request would be wrong.
 * Returns null only when none of the ids maps to a waitable account anymore
 * (deleted or disabled since) — then the pool won't self-heal, so the caller
 * fails fast instead of blocking.
 */
function soonestCooldownUntil(
  accounts: PoolAccount[],
  now: number,
  accountIds: ReadonlySet<string>,
): number | null {
  if (accountIds.size === 0) return null
  let soonest = Number.POSITIVE_INFINITY
  for (const account of accounts) {
    if (account.disabledReason) continue
    if (!accountIds.has(account.id)) continue
    const until = account.cooldownUntil > now ? account.cooldownUntil : now
    if (until < soonest) soonest = until
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
  // The provider's model catalog (opencode's configured model ids), handed to
  // the adapter's fallback-ladder hooks so a tier-capped request downgrades to
  // the best model that actually EXISTS one family down. Empty (tests, absent
  // catalog) degrades to the adapter's static last-resort default.
  models: readonly string[] = [],
): typeof fetch {
  const cfg = loadConfig()

  return (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined
    // Merge the user's request headers ONCE per request and reuse the result
    // throughout the retry loop (clone via `new Headers(baseHeaders)` per
    // attempt so each attempt's `applyAuth` mutation stays isolated). Before
    // this hoist, `mergeHeaders(input, init)` was re-run once for
    // deriveSessionKey plus once per rotation attempt of the retry loop
    // and `headers.delete(SESSION_HEADER)` ran defensively on every attempt
    // even though the value to strip is deterministic from input/init.
    const baseHeaders = mergeHeaders(input, init)
    // The client's abort signal may ride on `init` OR on a `Request` passed as
    // `input` (`fetch(new Request(url, { signal }))` is part of the `typeof
    // fetch` contract, and Request-carried *headers* are already honored via
    // mergeHeaders above). Resolve it ONCE here so both consumers — the
    // fully-rate-limited cooldown wait (`sleepAbortable`) and the abort
    // fast-path classification in the catch below — see the same signal;
    // reading only `init?.signal` would leave a Request-borne abort blocked
    // in the wait for up to maxWaitMs.
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
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
    // below never blocks on a credential problem or a client abort. Allocated
    // LAZILY at the sole add site: the dominant success path never rotates, so
    // it should not pay for a Set it provably never touches.
    let waitableCooldownIds: Set<string> | null = null
    let lastError: unknown = null

    // `bodyStr` is captured from the enclosing closure and never reassigned, so its
    // UTF-8 byte length is fixed per request; the memo below computes it at most
    // ONCE. The CJK cost-gate regression lock in plugin.test.ts exercises the
    // resolved value on both the gate-held and gate-passed branches.
    // Skip the UTF-8 walk entirely when the cost gate is DISABLED
    // (`cheapSwitchMaxBytes <= 0` — an explicit opt-out, NO LONGER the default):
    // a `<= 0` gate makes every moment "cheap", so `selectForSession` never reads
    // `requestBytes`, and a full UTF-8 walk of a 100+ KB body would be pure waste.
    // Likewise when there is NO session key: the byte gate only exists for
    // pinned-session switch decisions (`isCheapMoment` inside `selectForSession`'s
    // non-forced branch), which are reachable only with a session key — with
    // `sessionKey === null` selection goes straight to `selectAccount` and
    // `requestBytes` is provably never read, so passing 0 is an exact identity
    // (the parameter already defaults to 0).
    // With the gate ON and a session pinned, pass a memoized THUNK instead of an
    // eager length: `selectForSession` reads `requestBytes` only inside its
    // non-forced-migration block (pin over the soft threshold, or drainMigrate
    // on) — on the dominant steady-state sticky path the value is provably never
    // read, so the full-body UTF-8 walk would be pure waste there. The thunk
    // defers the walk to the single read site and the memo keeps it at most one
    // walk per request across rotation rounds.
    let cachedRequestBytes = -1
    const requestBytes =
      cfg.cheapSwitchMaxBytes > 0 && sessionKey !== null && bodyStr
        ? () => {
            if (cachedRequestBytes < 0)
              cachedRequestBytes = Buffer.byteLength(bodyStr, 'utf8')
            return cachedRequestBytes
          }
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
    // once per request, not once per attempt of a 429/401 rotation round.
    const transformedBody =
      bodyStr !== undefined ? adapter.transformBody(bodyStr) : init?.body
    const transformedUrl = adapter.transformUrl(input)

    // --- model-tier fallback state (request-scoped) -------------------------
    // The body actually sent this attempt — rewritten one LADDER RUNG down
    // (fable → opus → sonnet …) each time every candidate account proves
    // limited for its current tier. Each rewrite descends at least one model
    // family (guaranteed by the adapter's ladder), so the walk terminates.
    let currentBody = transformedBody
    // The tier `currentBody`'s model belongs to (e.g. "fable", "opus"), when
    // the adapter can tell — the `modelCooldownsUntil` key the proactive skip
    // below consults. Recomputed on every downgrade; OpenAI leaves
    // `requestModelTier` unset, so this stays null there and the tier
    // machinery is provably unreachable.
    let currentTier =
      typeof currentBody === 'string'
        ? (adapter.requestModelTier?.(currentBody) ?? null)
        : null
    // Lazily-computed downgrade plan for `currentBody` (null = disabled via
    // env, non-JSON body, or no lower family to fall to). Memoized per RUNG —
    // keyed by the body it was computed for — because the skip branch consults
    // it once per CANDIDATE while its value is fixed until the next downgrade.
    // Only ever invoked with a string `currentBody` (the skip gate requires
    // `currentTier`, which implies it).
    let fallbackPlan: ModelFallback | null = null
    let fallbackPlanFor: string | null = null
    const planDowngrade = (): ModelFallback | null => {
      if (typeof currentBody === 'string' && fallbackPlanFor !== currentBody) {
        fallbackPlanFor = currentBody
        fallbackPlan = adapter.planModelFallback?.(currentBody, models) ?? null
      }
      return fallbackPlan
    }
    // Non-null once this request downgraded; drives the success toast. Chained
    // downgrades keep the ORIGINAL `fromModel` so the toast reports what the
    // user asked for → what actually served (fable → sonnet, not opus → sonnet).
    let fallbackInfo: ModelFallback | null = null
    // The downgrade to adopt once selection runs dry — captured at the moment
    // an account is passed over for tier reasons (both populate sites prove a
    // plan exists, so the adopt branch below needs no re-derivation). Consumed
    // (reset to null) on adoption; a FURTHER rung can repopulate it.
    let pendingTierFallback: ModelFallback | null = null
    // Accounts passed over for TIER reasons only (proactive skip or a reactive
    // tier-429) since the last adoption. They are healthy for other models, so
    // when the downgrade is adopted they are removed from `tried` and become
    // candidates again — preferably the session's pinned account (keeping its
    // prompt cache).
    let tierSkipped: Set<string> | null = null

    // Cold-start / staleness seeding fires once per request, inside the loop —
    // reusing the loop's own pool read instead of paying a second serialized
    // file read + JSON.parse per request (see the flag at the readPool below).
    let usageSeeded = false

    // Wall-clock budget for BLOCKING on a fully-rate-limited pool (see below). The
    // deadline is fixed at request start so the total wait can never exceed maxWaitMs
    // no matter how many rotate/wait rounds run. (maxWaitMs <= 0 = fail-fast
    // opt-out; the gate below never enters, so the deadline goes unread.)
    const waitDeadline = Date.now() + cfg.maxWaitMs

    // Rounds, not a fixed attempt cap: `tried` bounds each round (once every account is
    // tried, selectForSession returns null and the round ends), and `waitDeadline`
    // bounds the whole request across wait-and-retry rounds.
    for (;;) {
      const pool = await readPool()
      // Capture `now` AFTER the pool read: readPool queues behind the
      // in-process pool mutex (and, transitively, in-flight writers holding
      // the cross-process file lock), so a pre-read stamp could predate that
      // wait and make selection treat an already-expired cooldown/window as
      // still live. Same class as the fresh-Date.now() notes below.
      const now = Date.now()

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

        // Every candidate is limited for the CURRENT model tier (skipped
        // proactively or tier-429'd) while staying usable for other models:
        // adopt the next-rung body and restore the tier-skipped accounts as
        // candidates. Selection then re-runs with the ladder model — and
        // because the skipped ids leave `tried`, the session's pinned account
        // is preferred again, so the downgrade keeps the pin's prompt cache
        // instead of paying a switch. The pending plan is CONSUMED here; if
        // the new rung's tier proves capped everywhere too, the skip/reactive
        // paths repopulate it one family further down (strict descent, so the
        // chain terminates), and when no rung is left this falls through to
        // the wait/fail logic below.
        if (pendingTierFallback !== null) {
          const adopted = pendingTierFallback
          pendingTierFallback = null
          currentBody = adopted.body
          currentTier = adapter.requestModelTier?.(adopted.body) ?? null
          // Chained downgrades keep the ORIGINAL fromModel for the toast.
          fallbackInfo =
            fallbackInfo === null
              ? adopted
              : { ...adopted, fromModel: fallbackInfo.fromModel }
          // `tierSkipped` is populated together with `pendingTierFallback`;
          // one-line form so the guard stays coverage-honest either way.
          // prettier-ignore
          if (tierSkipped !== null) for (const id of tierSkipped) tried.delete(id)
          tierSkipped = null
          // prettier-ignore
          if (DEBUG) log(`~~ every ${adapter.id} account is tier-limited for ${adopted.fromModel} -> downgraded to ${adopted.toModel}`)
          continue
        }

        // Every account we tried is rate-limited. Instead of failing the turn abruptly,
        // WAIT for the soonest `account`-class (429/402) cooldown to expire — honoring
        // Retry-After — when it lands within the wait budget, then retry with a clean
        // slate. `sleepAbortable` wakes instantly on a client abort (opencode cancelling
        // the turn); that rejection propagates untouched, matching the abort handling in
        // the fetch catch below. When nothing recoverable is left (no waitable cooldown,
        // or it is beyond the budget) we fall through and throw the last error as before.
        // The O(accounts) scan runs only when waiting is enabled at all
        // (`maxWaitMs=0` is the explicit fail-fast opt-out) AND some account
        // actually entered a waitable cooldown (the Set stays null otherwise) —
        // don't compute a resume point that could never be used.
        if (cfg.maxWaitMs > 0 && waitableCooldownIds) {
          const resumeAt = soonestCooldownUntil(
            pool.accounts,
            now,
            waitableCooldownIds,
          )
          if (resumeAt !== null && resumeAt <= waitDeadline) {
            // Sleep until the soonest cooldown has GENUINELY elapsed. Fresh
            // Date.now() (NOT the loop-start `now`, captured before the
            // serialized pool read + selection scan + a whole round of
            // attempts) so `resumeAt - now` doesn't overshoot by that elapsed
            // I/O time. LOOP because `setTimeout` can fire a few ms EARLY under
            // CPU load: a single `sleepAbortable(resumeAt - now)` may then wake
            // with `Date.now() < resumeAt`, leaving the account we waited for
            // still `cooldownUntil > now`. selectForSession would then see NO
            // available account and fall through to selectAccount's DEGRADED
            // fallback — resuming on a DIFFERENT still-cooling account (the
            // lowest-weekly-util one) and silently defeating the wait. Re-
            // sleeping the remaining delta guarantees that account is actually
            // past its cooldown before we retry. An already-expired cooldown
            // makes the first delta <= 0, so the body is skipped (immediate
            // wake, as before); a client abort still interrupts the sleep and
            // propagates its reason untouched.
            let remaining = resumeAt - Date.now()
            while (remaining > 0) {
              await sleepAbortable(remaining, signal)
              remaining = resumeAt - Date.now()
            }
            tried.clear()
            waitableCooldownIds.clear()
            continue
          }
        }
        break
      }

      const { account, degraded, sticky } = selection
      tried.add(account.id)

      // PROACTIVE tier skip: this account's cap for the CURRENT model tier is
      // known-exhausted (persisted `modelCooldownsUntil[tier]`) and a further
      // ladder rung exists. Don't pay a guaranteed tier-429 round-trip (a
      // full conversation upload): pass the account over for this tier. If
      // EVERY candidate ends up skipped this way, the selection-null branch
      // above adopts the next rung and restores these accounts — so the pool
      // serves the current model whenever ANY account still has tier
      // headroom, and only then descends. When no rung is left
      // (`planDowngrade()` null — ladder exhausted or downgrade disabled) the
      // request is sent anyway, so the documented opt-out behavior (429 →
      // account-wide cooldown) is reached via the normal rotation path below.
      if (
        currentTier !== null &&
        (account.modelCooldownsUntil?.[currentTier] ?? 0) > now
      ) {
        const plan = planDowngrade()
        if (plan !== null) {
          pendingTierFallback = plan
          tierSkipped ??= new Set()
          tierSkipped.add(account.id)
          // prettier-ignore
          if (DEBUG) log(`~~ ${account.label} ${currentTier} tier exhausted -> skipped for ${currentTier}`)
          continue
        }
      }

      try {
        await ensureAccessToken(adapter, account, now)

        // Clone the pre-computed base so each attempt's `applyAuth` mutation
        // (the per-account Bearer token) stays isolated from sibling attempts
        // and from the captured base. `SESSION_HEADER` was already stripped
        // from `baseHeaders` above, so the clone inherits the absence.
        const headers = new Headers(baseHeaders)
        adapter.applyAuth(headers, account)

        // Call-site DEBUG gate: `log()` re-checks internally, but the template
        // literal argument would otherwise be BUILT on every successful request
        // (the dominant path) even with debugging off. Kept on ONE line so the
        // line still executes (condition evaluated) under the coverage gate.
        // prettier-ignore
        if (DEBUG) log(`-> ${adapter.id} via ${account.label}${sticky ? ' (sticky)' : ''}${degraded ? ' (degraded)' : ''}`)

        const res = await fetch(transformedUrl, {
          ...init,
          body: currentBody,
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
          // Release the rejected response's body stream — and its HTTP
          // connection — BEFORE any pool write below (`recordModelCooldown` /
          // `recordRotation`): rate-limit storms are exactly when the pool
          // lock is most contended (worst case a 30 s POOL_WRITE_LOCK
          // timeout), and neither path should wait behind a socket pinned to
          // a dead response. Everything in this branch
          // (`planReactiveFallback`, `parseUsageHeaders`, retry-after) reads
          // only `res.headers`, which stay readable after a body cancel.
          await res.body?.cancel().catch(ignore)
          // Model-tier fallback: a 429 whose BINDING limit is a MODEL-TIER
          // weekly cap (`representative-claim: seven_day_opus` /
          // `seven_day_fable` / …) is NOT the account's fault — the account
          // still serves every other model. So instead of cooling the WHOLE
          // account down (which cascaded every account into cooldown and
          // blocked non-limited models too), persist the TIER cooldown only
          // and rotate: the next candidate still gets asked for the CURRENT
          // model, and only when the whole pool proves tier-limited does the
          // selection-null branch above descend a ladder rung. The plan is
          // derived from `currentBody`, so each descent starts from the rung
          // that just 429'd; when no rung is left (`plan` null — ladder
          // exhausted or downgrade disabled) this falls through to a normal
          // account cooldown.
          if (cls === 'account' && typeof currentBody === 'string') {
            // Fresh Date.now() for the same reason as `recordRotation` below:
            // the loop-start `now` predates ensureAccessToken + the fetch.
            const reactiveNow = Date.now()
            const plan = adapter.planReactiveFallback?.(
              res,
              currentBody,
              reactiveNow,
              models,
            )
            if (plan) {
              // Fold the 429's usage headers into the SAME pool write as the
              // tier cooldown — otherwise a failing rest-of-request would
              // leave the scheduler on the stale pre-request snapshot.
              await recordModelCooldown(
                account.id,
                plan.tier,
                plan.resetAt,
                adapter.parseUsageHeaders(res.headers),
                reactiveNow,
              )
              // Sync the LOCAL account object with what was just persisted:
              // the fallback toast's per-window de-dupe key (notify.ts) reads
              // the tier map, so without this a downgrade that ends up served
              // by THIS account would toast under window `0` and a later real
              // window value would spuriously re-toast the same exhaustion.
              const local = (account.modelCooldownsUntil ??= {})
              local[plan.tier] = Math.max(local[plan.tier] ?? 0, plan.resetAt)
              pendingTierFallback = plan.fallback
              tierSkipped ??= new Set()
              tierSkipped.add(account.id)
              lastError = new Error(
                `${adapter.id} account "${account.label}" hit its "${plan.tier}" model-tier cap`,
              )
              // prettier-ignore
              if (DEBUG) log(`~~ ${account.label} ${plan.tier} tier limited -> rotating (fallback ${plan.fallback.toModel} pending)`)
              continue
            }
          }

          const ms = cls === 'auth' ? AUTH_COOLDOWN_MS : ACCOUNT_COOLDOWN_MS
          // Fresh Date.now(), NOT the loop-start `now`: that was captured before
          // ensureAccessToken (up to a 30 s network refresh) and the upstream
          // fetch, so basing the cooldown on it would understate `Retry-After`
          // by the request latency and retry the account before the server
          // said it may be. The success path already stamps response time.
          await recordRotation(adapter, account.id, res, ms, Date.now())
          // Only an `account`-class (429/402) cooldown is worth waiting out; an auth
          // (401/403) failure needs a re-login, not time, so it stays out of the set.
          if (cls === 'account') {
            waitableCooldownIds ??= new Set()
            waitableCooldownIds.add(account.id)
          }
          lastError = new Error(
            `${adapter.id} account "${account.label}" returned ${res.status}`,
          )
          // Same call-site DEBUG gate as the success path above:
          // don't build the template literal during a rate-limit storm.
          // prettier-ignore
          if (DEBUG) log(`!! ${account.label} ${res.status} (${cls}) -> rotating`)
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
        // Toast the model downgrade (de-duped per account in notify) so the
        // user knows this turn ran on the fallback model, not the one they
        // selected.
        if (fallbackInfo)
          hooks.onModelFallback?.(
            adapter.id,
            account,
            fallbackInfo.fromModel,
            fallbackInfo.toModel,
            fallbackInfo.fromTier,
          )
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
          signal?.aborted === true ||
          (error instanceof Error && error.name === 'AbortError')
        if (aborted) throw error
        // Any OTHER thrown error here (network/DNS/timeout failure, or
        // `ensureAccessToken` rejecting on a refresh problem) intentionally
        // shares the SHORT `AUTH_COOLDOWN_MS`, not the longer
        // `ACCOUNT_COOLDOWN_MS` or a dedicated constant: most such failures
        // are transient (a blip, a slow network), so assume that and retry
        // the account sooner. A genuine credential problem keeps throwing on
        // every attempt and re-cools each time, so it never gets treated as
        // healthy for longer than a real rate-limit cooldown would allow.
        if (!account.disabledReason)
          await applyCooldown(account.id, AUTH_COOLDOWN_MS)
        // prettier-ignore
        if (DEBUG) log(`!! ${account.label} threw: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
    }

    throw (
      lastError ??
      new Error(`${adapter.id}: no usable account in the load-balancer pool`)
    )
  }) as typeof fetch
}
