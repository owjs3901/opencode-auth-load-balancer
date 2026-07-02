/**
 * Shared OAuth callback helpers used by both the Anthropic and OpenAI OAuth
 * flows. Sibling to `pkce.ts` — both providers had near-identical private
 * copies of `generateState` (byte-identical) and `parseCallbackInput`
 * (95%-identical: the Anthropic variant also accepts the legacy `code#state`
 * hash-split format pasted manually by users). Keeping two copies meant every
 * future tweak (new callback format, whitespace normalization) had to be made
 * in two places to stay consistent. `readTokenResponse` unifies the same way:
 * the token-endpoint 200-body validation was copy-pasted four times (exchange
 * + refresh, per provider).
 */

/** The fields every provider's token-endpoint response must carry. */
export interface BaseTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

/**
 * Parse and validate an OAuth token-endpoint 200 body. Returns null when the
 * body is not JSON or is missing `access_token`/`expires_in` — otherwise a
 * SyntaxError escapes into the login flow, or a missing `expires_in` poisons
 * the pool with `expires: NaN` (which `needsRefresh` never treats as stale).
 * `expires_in` must be FINITE, not just a number: `JSON.parse('1e999')`
 * legally yields `Infinity`, which would poison the pool with
 * `expires: Infinity` — the same never-stale soft-brick as NaN.
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
    !Number.isFinite(json.expires_in)
  )
    return null
  return json
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
  return crypto.randomUUID().replace(/-/g, '')
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

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) return { code, state }
  } catch {
    // Fall through to legacy/manual formats.
  }

  if (options.allowHashFormat) {
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
