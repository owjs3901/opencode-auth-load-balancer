import type { PoolAccount, TokenSet, UsageSnapshot } from '../types'

export type FetchInput = string | URL | Request

/**
 * Error classification drives rotation:
 *   "account" — this account is rate-limited/over quota (429/402). Cool it down, try next.
 *   "auth"    — this account's credential is bad (401/403). Cool it down, try next.
 *   "service" — provider-side/transient (5xx) or a genuine bad request. Return as-is.
 *   "ok"      — success, return the response.
 */
export type ErrorClass = 'account' | 'auth' | 'service' | 'ok'

export interface AuthorizeRequest {
  url: string
  verifier: string
  state: string
  redirectUri: string
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
  /** Parse usage from a normal inference response's headers (free, passive). */
  parseUsageHeaders(
    headers: Headers,
    now: number,
  ): Partial<UsageSnapshot> | null
  /** Poll a dedicated usage endpoint for authoritative quota, if one exists. */
  fetchUsage(account: PoolAccount, now: number): Promise<UsageSnapshot | null>

  /** Classify an HTTP status for rotation decisions. */
  classifyError(status: number): ErrorClass
}
