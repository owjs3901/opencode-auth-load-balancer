import type { TokenSet } from '../../types'
import { isFiniteNumber, isPlainObject } from '../../util'
import {
  type BaseTokenResponse,
  generateState,
  parseCallbackInput,
  readExchangeResponse,
  readRefreshResponse,
  toTokenSet,
} from '../oauth-callback'
import { generatePKCE } from '../pkce'
import type { AuthorizeRequest } from '../types'
import {
  AUTHORIZE_URL,
  CLIENT_ID,
  CODE_CALLBACK_URL,
  INFERENCE_SCOPE,
  INFERENCE_TOKEN_LIFETIME_S,
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

interface AnthropicTokenResponse extends BaseTokenResponse {
  account?: unknown
  organization?: unknown
  refresh_token_expires_in?: unknown
}

/** Claude Code's assumed OAuth login lifetime when a login response does not state one. */
const ASSUMED_LOGIN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

function uuidOf(value: unknown): string | undefined {
  return isPlainObject(value) && typeof value.uuid === 'string' && value.uuid
    ? value.uuid
    : undefined
}

/**
 * The account a token response belongs to — the same `account.uuid` and
 * `organization.uuid` Claude Code records from it. The account id dedups a
 * re-login whose refresh token has rotated; the organization pairs the
 * login with the account's setup-token. Also when the login itself expires,
 * mirroring Claude Code: `refresh_token_expires_in` when stated, else 30
 * days at login — while a refresh that does not state it leaves the login's
 * expiry where it was.
 */
function withAccount(
  tokens: TokenSet,
  json: AnthropicTokenResponse,
  atLogin: boolean,
): TokenSet {
  const accountId = uuidOf(json.account)
  const orgId = uuidOf(json.organization)
  if (accountId) tokens.accountId = accountId
  if (orgId) tokens.orgId = orgId
  const lifetime = json.refresh_token_expires_in
  if (isFiniteNumber(lifetime) && lifetime > 0)
    tokens.refreshExpires = Date.now() + lifetime * 1000
  else if (atLogin)
    tokens.refreshExpires = Date.now() + ASSUMED_LOGIN_LIFETIME_MS
  return tokens
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

  // "Returns null on failure" includes a non-ok status and a 200 whose body
  // is not JSON or is missing the required fields — see readExchangeResponse.
  const json = await readExchangeResponse<AnthropicTokenResponse>(result)
  if (!json) return null
  return withAccount(toTokenSet(json, ''), json, true)
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
  const json = await readRefreshResponse<AnthropicTokenResponse>(response)
  return withAccount(toTokenSet(json, refreshToken), json, false)
}

/**
 * Mint the token `claude setup-token` prints from an OAuth login, with no
 * Claude Code and no second browser approval: a refresh grant naming the
 * scope and lifetime it wants, as Claude Code's own `claude auth login`
 * mints its one-year token from a refresh token. The grant spends the
 * refresh token like `refresh`, so the result carries the rotated one;
 * `access`/`expires` are the minted token. Throws like `refresh`.
 */
export async function mintInferenceToken(
  refreshToken: string,
): Promise<TokenSet> {
  const response = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: INFERENCE_SCOPE,
    expires_in: INFERENCE_TOKEN_LIFETIME_S,
  })
  const json = await readRefreshResponse<AnthropicTokenResponse>(response)
  return withAccount(toTokenSet(json, refreshToken), json, false)
}
