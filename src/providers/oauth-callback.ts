/**
 * Shared OAuth callback helpers used by both the Anthropic and OpenAI OAuth
 * flows. Sibling to `pkce.ts` — both providers had near-identical private
 * copies of `generateState` (byte-identical) and `parseCallbackInput`
 * (95%-identical: the Anthropic variant also accepts the legacy `code#state`
 * hash-split format pasted manually by users). Keeping two copies meant every
 * future tweak (new callback format, whitespace normalization) had to be made
 * in two places to stay consistent. `readTokenResponse` unifies the same way:
 * the token-endpoint 200-body validation was copy-pasted four times (exchange
 * + refresh, per provider). `toTokenSet` single-sources the response→TokenSet
 * mapping contract the same way — it too was maintained as two mirrored
 * private copies.
 */

import type { TokenSet } from '../types'
import { ignore } from '../util'

/** The fields every provider's token-endpoint response must carry. */
export interface BaseTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

/**
 * Map a token-endpoint response body to a TokenSet. RFC 6749 §5.1: the server
 * MAY omit refresh_token; fall back to `previousRefresh` then — `''` at
 * exchange time (no previous token; a missing field still fails the next
 * refresh loudly, but never writes `undefined` onto the pool account), the
 * current token at refresh time. Providers with extra fields (e.g. OpenAI's
 * `accountId`) spread this result and add them.
 */
export function toTokenSet(
  json: BaseTokenResponse,
  previousRefresh: string,
): TokenSet {
  return {
    access: json.access_token,
    refresh: json.refresh_token || previousRefresh,
    expires: Date.now() + json.expires_in * 1000,
  }
}

/**
 * Parse and validate an OAuth token-endpoint 200 body. Returns null when the
 * body is not JSON, `access_token` is missing/empty, `expires_in` is
 * missing, or a PRESENT, non-null `refresh_token` is non-string — otherwise
 * a SyntaxError escapes into the login flow, an empty-string `access_token`
 * writes `access: ''` onto the pool row (silently bricking auth until the
 * next self-healing refresh), a missing `expires_in` poisons the pool with
 * `expires: NaN` (which `needsRefresh` never treats as stale), or a
 * malformed `refresh_token` (e.g. a number) writes a non-string value onto
 * `PoolAccount.refresh` (typed `string`) via `toTokenSet`'s
 * `json.refresh_token || previousRefresh` — until the next `readPool()`
 * heals it via `normalizeAccounts`'s own `typeof row.refresh !== 'string'`
 * guard (`pool/store.ts`). `refresh_token` is still OPTIONAL per RFC 6749
 * §5.1 — only a present-but-wrong-type value is rejected. An explicit JSON
 * `null` (how some statically-typed token endpoints serialize an omitted
 * `Option<String>`) is treated the same as `undefined`: both are falsy, so
 * `toTokenSet`'s `json.refresh_token || previousRefresh` already falls back
 * identically for either — rejecting `null` here would just misreport a
 * valid response as "malformed" for no behavioral gain.
 * `expires_in` must be FINITE, not just a number: `JSON.parse('1e999')`
 * legally yields `Infinity`, which would poison the pool with
 * `expires: Infinity` — the same never-stale soft-brick as NaN.
 * It must also be POSITIVE: RFC 6749 §5.1 defines it as a lifetime in
 * seconds, so 0/negative is nonsensical — and would write an already-expired
 * `expires` to the pool, making `needsRefresh` true on EVERY request (a
 * network refresh round-trip per request, each burning a single-use rotated
 * refresh token).
 * Its MS PRODUCT must be finite too: a finite-but-huge value like `1e306`
 * passes the checks above, yet every consumer computes
 * `Date.now() + expires_in * 1000`, and `1e306 * 1000` collapses to
 * `+Infinity` — the same never-stale soft-brick. Mirrors the `secondsToMs`
 * guard in `src/util.ts` and `cooldownUntilFrom`'s retry-after guard in
 * `src/fetch.ts`.
 * Callers decide the failure shape: exchange sites return null, refresh sites
 * throw their status-prefixed "malformed token response body" error.
 */
export async function readTokenResponse<
  T extends BaseTokenResponse = BaseTokenResponse,
>(res: Response): Promise<T | null> {
  const json = (await res.json().catch(() => null)) as T | null
  if (
    !json ||
    typeof json.access_token !== 'string' ||
    json.access_token === '' ||
    !Number.isFinite(json.expires_in) ||
    json.expires_in <= 0 ||
    !Number.isFinite(json.expires_in * 1000) ||
    // this codebase uses strict === / !== everywhere (no bare `!=`/`==`
    // appears anywhere in src/) — an explicit null-or-undefined check keeps
    // that convention rather than introducing a loose-equality `!= null`.
    (json.refresh_token !== undefined &&
      json.refresh_token !== null &&
      typeof json.refresh_token !== 'string')
  )
    return null
  return json
}

/**
 * Validate an exchange-endpoint response with the shared exchange failure
 * contract: null on a non-ok status (with the body stream — and its HTTP
 * connection — released), null on a malformed 200 body (see
 * readTokenResponse). Refresh-side sibling of `readRefreshResponse`; both
 * providers' `exchange` delegate here so a future tweak (logging, a new
 * failure shape) can never be made in only one copy.
 */
export async function readExchangeResponse<
  T extends BaseTokenResponse = BaseTokenResponse,
>(res: Response): Promise<T | null> {
  if (!res.ok) {
    await res.body?.cancel().catch(ignore)
    return null
  }
  return readTokenResponse<T>(res)
}

/**
 * Validate a refresh-endpoint response, throwing the status-prefixed error
 * `isInvalidGrant()` (src/refresh.ts) parses — that message format is a
 * contract, single-sourced here so it can never be half-updated. A malformed
 * 200 body must never reach commitRefresh, or the account gets `expires: NaN`
 * (which needsRefresh never treats as stale) and soft-bricks into a perpetual
 * auth-cooldown loop that survives restarts; the 200-status prefix keeps
 * isInvalidGrant() false (200 ≠ 400/401), so the failure stays transient —
 * the account is NOT disabled.
 */
export async function readRefreshResponse<
  T extends BaseTokenResponse = BaseTokenResponse,
>(res: Response): Promise<T> {
  if (!res.ok)
    throw new Error(`Token refresh failed: ${res.status} — ${await res.text()}`)
  const json = await readTokenResponse<T>(res)
  if (!json)
    throw new Error(
      `Token refresh failed: ${res.status} — malformed token response body`,
    )
  return json
}

/** Generate an opaque OAuth `state` parameter (32-char hex, no hyphens). */
export function generateState(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/**
 * Parse a pasted OAuth callback into `{ code, state }`. Accepts a full
 * `https://…?code=…&state=…` URL, a `key=value` form (`code=…&state=…`), and
 * — when `allowHashFormat` is on — the legacy/manual `<code>#<state>` format.
 * Returns null when no shape matches.
 */
export function parseCallbackInput(
  input: string,
  options: { allowHashFormat?: boolean } = {},
): { code: string; state: string } | null {
  const trimmed = input.trim()

  let isUrl = false
  try {
    const url = new URL(trimmed)
    isUrl = true
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) return { code, state }
  } catch {
    // Fall through to legacy/manual formats.
  }

  // The legacy `<code>#<state>` hash format is for a raw manual paste, not a
  // real URL — a syntactically valid URL that merely lacks `code`/`state`
  // (e.g. one with a `#fragment`) must fall through to the key=value parse
  // below instead of having its fragment misread as `state`.
  if (options.allowHashFormat && !isUrl) {
    const hashSplits = trimmed.split('#')
    if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
      return { code: hashSplits[0], state: hashSplits[1] }
    }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) return { code, state }

  return null
}
