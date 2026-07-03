import type { PoolAccount, TokenSet, UsageSnapshot } from '../types'

export type FetchInput = string | URL | Request

/**
 * Error classification drives rotation:
 *   "account" — this account is rate-limited/over quota (429/402). Cool it down, try next.
 *   "auth"    — this account's credential is bad (401/403). Cool it down, try next.
 *   "service" — provider-side/transient (5xx). Return as-is.
 *   "ok"      — success or any other status (including 4xx client errors like
 *               400/404): return the response as-is.
 */
export type ErrorClass = 'account' | 'auth' | 'service' | 'ok'

/**
 * Shared HTTP-status → ErrorClass mapping. Both Anthropic and OpenAI adapters
 * delegate to this single source of truth so a future status (e.g. 408, 425)
 * being added in one provider but missed in the other cannot silently diverge
 * rotation behavior between Claude and Codex.
 */
export function classifyHttpStatus(status: number): ErrorClass {
  if (status === 429 || status === 402) return 'account'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500) return 'service'
  return 'ok'
}

/**
 * Parse a fetch input into a URL, or null when it is not a valid absolute URL.
 * Shared by both providers' `rewriteUrl` so the `FetchInput → URL` prologue
 * (string/URL vs Request handling, malformed-input bail) can never drift
 * between Claude and Codex — same rationale as `classifyHttpStatus` above.
 */
export function urlFromInput(input: FetchInput): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : input)
  } catch {
    /* malformed input → null */
    return null
  }
}

export interface AuthorizeRequest {
  url: string
  verifier: string
  state: string
  redirectUri: string
}

/**
 * A request-body rewrite that downgrades the requested model to a cheaper
 * fallback (e.g. Claude Opus → Sonnet) when the primary model's tier quota is
 * exhausted on the chosen account. `body` is the rewritten JSON string to send;
 * `fromModel`/`toModel` drive the user-facing switch toast/log.
 */
export interface ModelFallback {
  body: string
  fromModel: string
  toModel: string
}

/**
 * Reactive-fallback plan returned from a rejected (429) response whose headers
 * indicate a MODEL-TIER cap (not an account-wide limit). `tier` names the
 * limited tier (e.g. "opus", "fable") and `resetAt` (epoch ms) is when it
 * recovers — persisted as `PoolAccount.modelCooldownsUntil[tier]` so subsequent
 * requests for that tier avoid the account without paying a rejected
 * round-trip. `fallback` is the downgraded body the fetch loop adopts once the
 * WHOLE pool proves limited for the tier.
 */
export interface ReactiveModelFallback {
  tier: string
  resetAt: number
  fallback: ModelFallback
}

/**
 * A provider adapter encapsulates everything provider-specific: OAuth, request
 * shaping (headers/body/url transforms), usage parsing, and error classification.
 * The scheduler, pool store, and load-balanced fetch are all provider-agnostic and
 * drive adapters through this interface.
 */
export interface ProviderAdapter {
  /** opencode provider id, e.g. "anthropic" | "openai". */
  readonly id: string

  // --- OAuth ---------------------------------------------------------------
  /** Begin an authorization-code (PKCE) flow. */
  authorize(): Promise<AuthorizeRequest>
  /** Exchange a pasted code/URL for tokens. Returns null on failure. */
  exchange(
    input: string,
    verifier: string,
    redirectUri: string,
    state: string,
  ): Promise<TokenSet | null>
  /** Refresh an access token. Throws on failure (callers handle invalid_grant). */
  refresh(refreshToken: string): Promise<TokenSet>

  // --- request shaping -----------------------------------------------------
  /** Set auth + provider headers on an outgoing request for the chosen account. */
  applyAuth(headers: Headers, account: PoolAccount): void
  /** Optionally rewrite the request URL (e.g. add ?beta=true, swap base URL). */
  transformUrl(input: FetchInput): FetchInput
  /** Optionally rewrite a string request body (system-prompt spoof, tool prefixing). */
  transformBody(body: string): string
  /** Optionally wrap the response (e.g. strip tool prefixes from the stream). */
  transformResponse(response: Response): Response

  // --- usage ---------------------------------------------------------------
  /**
   * Parse usage from a normal inference response's headers (free, passive).
   * Deliberately takes NO timestamp: the capture time is stamped downstream by
   * `applyUsagePartial` (see the doc comments in each provider's usage.ts).
   */
  parseUsageHeaders(headers: Headers): Partial<UsageSnapshot> | null
  /** Poll a dedicated usage endpoint for authoritative quota, if one exists. */
  fetchUsage(account: PoolAccount, now: number): Promise<UsageSnapshot | null>

  /** Classify an HTTP status for rotation decisions. */
  classifyError(status: number): ErrorClass

  // --- model-tier fallback (optional; Anthropic Opus/Fable→Sonnet) ---------
  /**
   * The model TIER `body` asks for (the `modelCooldownsUntil` key the fetch
   * loop consults BEFORE sending, to steer the request onto an account with
   * tier headroom), or null when the body has no recognizable tier. Absent on
   * providers without per-tier caps (OpenAI) — the fetch loop treats an absent
   * hook as "no tier logic".
   */
  requestModelTier?(body: string): string | null
  /**
   * Pure body downgrade: rewrite `body`'s model ONE RUNG DOWN the fallback
   * ladder — the best model of the next family below, chosen from `models`
   * (the provider's catalog, e.g. opencode's configured model list) — or null
   * when disabled / not downgradable. The fetch loop adopts it when EVERY
   * candidate account is limited for the current body's tier — so the
   * downgraded request can then reuse any of them, preferably the session's
   * pinned account (keeping its prompt cache). Each call descends at least
   * one family, so repeated adoption terminates.
   */
  planModelFallback?(
    body: string,
    models: readonly string[],
  ): ModelFallback | null
  /**
   * REACTIVE classification (post-429): when a rejected response's headers
   * indicate a MODEL-TIER cap (not account-wide) that `body`'s model can fall
   * down the ladder from, return the tier + its `resetAt` to persist and the
   * downgraded body. null = treat the 429 as a normal account rotation.
   */
  planReactiveFallback?(
    res: Response,
    body: string,
    now: number,
    models: readonly string[],
  ): ReactiveModelFallback | null
}
