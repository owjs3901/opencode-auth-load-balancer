import type { TokenSet } from '../../types'
import { ignore } from '../../util'
import { generateState, parseCallbackInput } from '../oauth-callback'
import { generatePKCE } from '../pkce'
import type { AuthorizeRequest } from '../types'
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  OAUTH_HTTP_TIMEOUT_MS,
  OAUTH_SCOPES,
  ORIGINATOR,
  REDIRECT_URI,
  TOKEN_URL,
} from './constants'
import { extractAccountId } from './jwt'

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in: number
}

function toTokenSet(json: TokenResponse, previousRefresh: string): TokenSet {
  const accountId = json.id_token ? extractAccountId(json.id_token) : undefined
  return {
    access: json.access_token,
    // The server may omit a rotated refresh token; keep the previous one then.
    refresh: json.refresh_token || previousRefresh,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  }
}

/**
 * POST a form-encoded body to TOKEN_URL with the shared Codex OAuth shell.
 * Centralized so `exchange` and `refresh` can never drift on headers or
 * timeout — only their URLSearchParams bodies differ.
 */
async function postToken(body: URLSearchParams): Promise<Response> {
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  })
}

/** Begin the ChatGPT PKCE authorization flow. */
export async function authorize(): Promise<AuthorizeRequest> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('state', state)
  url.searchParams.set('originator', ORIGINATOR)

  return {
    url: url.toString(),
    redirectUri: REDIRECT_URI,
    state,
    verifier: pkce.verifier,
  }
}

/**
 * Exchange a pasted callback URL (or `code#state`) for tokens. Returns null on
 * failure. The redirect lands on http://localhost:1455/auth/callback — the user
 * copies that URL from the browser address bar and pastes it here.
 */
export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<TokenSet | null> {
  const callback = parseCallbackInput(input)
  if (!callback) return null
  if (expectedState && callback.state !== expectedState) return null

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: callback.code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
  })

  const res = await postToken(body)
  if (!res.ok) {
    await res.body?.cancel().catch(ignore)
    return null
  }

  // "Returns null on failure" includes a 200 whose body is not JSON or is
  // missing the required fields — otherwise a SyntaxError escapes into the
  // login flow, or a missing expires_in poisons the pool with `expires: NaN`
  // (which needsRefresh never treats as stale). Symmetric with
  // ../anthropic/oauth.ts.
  const json = (await res.json().catch(() => null)) as TokenResponse | null
  if (
    !json ||
    typeof json.access_token !== 'string' ||
    typeof json.expires_in !== 'number'
  )
    return null
  return toTokenSet(json, '')
}

/** Refresh an access token. Throws on failure; message includes the HTTP status. */
export async function refresh(refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })

  const res = await postToken(body)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token refresh failed: ${res.status} — ${text}`)
  }

  // Validate the 200 body like exchange() does: a non-JSON 200 or a JSON 200
  // missing access_token/expires_in must never reach commitRefresh, or the
  // account gets `expires: NaN` (which needsRefresh never treats as stale) and
  // soft-bricks into a perpetual auth-cooldown loop that survives restarts.
  // The status-prefixed message keeps isInvalidGrant() false (200 ≠ 400/401),
  // so the failure stays transient — the account is NOT disabled. Symmetric
  // with ../anthropic/oauth.ts.
  const json = (await res.json().catch(() => null)) as TokenResponse | null
  if (
    !json ||
    typeof json.access_token !== 'string' ||
    typeof json.expires_in !== 'number'
  )
    throw new Error(
      `Token refresh failed: ${res.status} — malformed token response body`,
    )
  return toTokenSet(json, refreshToken)
}
