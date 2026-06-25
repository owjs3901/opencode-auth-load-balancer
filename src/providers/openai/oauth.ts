import type { TokenSet } from '../../types'
import { ignore } from '../../util'
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
import { generatePKCE } from './pkce'

function generateState(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

function parseCallbackInput(
  input: string,
): { code: string; state: string } | null {
  const trimmed = input.trim()
  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) return { code, state }
  } catch {
    // not a URL — fall through
  }
  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) return { code, state }
  return null
}

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

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(ignore)
    return null
  }

  const json = (await res.json()) as TokenResponse
  return toTokenSet(json, '')
}

/** Refresh an access token. Throws on failure; message includes the HTTP status. */
export async function refresh(refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token refresh failed: ${res.status} — ${text}`)
  }

  const json = (await res.json()) as TokenResponse
  return toTokenSet(json, refreshToken)
}
