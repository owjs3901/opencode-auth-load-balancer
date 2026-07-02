import type { TokenSet } from '../../types'
import { ignore } from '../../util'
import {
  generateState,
  parseCallbackInput,
  readRefreshResponse,
  readTokenResponse,
  toTokenSet,
} from '../oauth-callback'
import { generatePKCE } from '../pkce'
import type { AuthorizeRequest } from '../types'
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  OAUTH_HTTP_TIMEOUT_MS,
  OAUTH_SCOPES,
  TOKEN_URL,
} from './constants'

/**
 * POST a JSON body to TOKEN_URL with the shared Claude OAuth shell.
 * Centralized so `exchange` and `refresh` can never drift on headers, UA, or
 * timeout — only their body objects differ.
 */
async function postToken(body: object): Promise<Response> {
  return fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  })
}

/** Begin the PKCE authorization flow (Claude Pro/Max subscription accounts). */
export async function authorize(): Promise<AuthorizeRequest> {
  const pkce = await generatePKCE()
  const state = generateState()

  const url = new URL(AUTHORIZE_URL)
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

  const result = await postToken({
    code: callback.code,
    state: callback.state,
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })

  if (!result.ok) {
    await result.body?.cancel().catch(ignore)
    return null
  }

  // "Returns null on failure" includes a 200 whose body is not JSON or is
  // missing the required fields — see readTokenResponse.
  const json = await readTokenResponse(result)
  if (!json) return null
  return toTokenSet(json, '')
}

/** Refresh an access token. Throws on failure; message includes the HTTP status. */
export async function refresh(refreshToken: string): Promise<TokenSet> {
  const response = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  })

  // readRefreshResponse throws the status-prefixed error contract on a non-OK
  // status or a malformed 200 body (see its doc comment in ../oauth-callback).
  const json = await readRefreshResponse(response)
  return toTokenSet(json, refreshToken)
}
