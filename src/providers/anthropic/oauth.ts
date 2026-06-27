import type { TokenSet } from '../../types'
import { ignore } from '../../util'
import { generateState, parseCallbackInput } from '../oauth-callback'
import { generatePKCE } from '../pkce'
import type { AuthorizeRequest } from '../types'
import {
  AUTHORIZE_URLS,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_HTTP_TIMEOUT_MS,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants'

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

/** Begin the PKCE authorization flow for the given login mode. */
export async function authorize(
  mode: 'max' | 'console',
): Promise<AuthorizeRequest> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URLS[mode])
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CODE_CALLBACK_URL)
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '))
  url.searchParams.set('code_challenge', pkce.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  return {
    url: url.toString(),
    redirectUri: CODE_CALLBACK_URL,
    state,
    verifier: pkce.verifier,
  }
}

/** Exchange a pasted authorization code/URL for tokens. Returns null on failure. */
export async function exchange(
  input: string,
  verifier: string,
  redirectUri: string,
  expectedState?: string,
): Promise<TokenSet | null> {
  const callback = parseCallbackInput(input, { allowHashFormat: true })
  if (!callback) return null
  if (expectedState && callback.state !== expectedState) return null

  const result = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      code: callback.code,
      state: callback.state,
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  })

  if (!result.ok) {
    await result.body?.cancel().catch(ignore)
    return null
  }

  const json = (await result.json()) as TokenResponse
  return {
    access: json.access_token,
    // RFC 6749 §5.1: server MAY omit refresh_token; at exchange time there is
    // no previous token, so the empty-string fall-back matches the OpenAI
    // exchange path (toTokenSet(json, '')) — a missing field still fails the
    // next refresh loudly, but never writes `undefined` onto the pool account.
    refresh: json.refresh_token || '',
    expires: Date.now() + json.expires_in * 1000,
  }
}

/** Refresh an access token. Throws on failure; message includes the HTTP status. */
export async function refresh(refreshToken: string): Promise<TokenSet> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Token refresh failed: ${response.status} — ${body}`)
  }

  const json = (await response.json()) as TokenResponse
  return {
    access: json.access_token,
    // RFC 6749 §5.1: server MAY omit a rotated refresh_token; keep the previous
    // one then (symmetric with toTokenSet() in ../openai/oauth.ts).
    refresh: json.refresh_token || refreshToken,
    expires: Date.now() + json.expires_in * 1000,
  }
}
