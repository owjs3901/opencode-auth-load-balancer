import type { PoolAccount, TokenSet, UsageSnapshot } from '../../types'
import {
  type AuthorizeRequest,
  classifyHttpStatus,
  type ErrorClass,
  type FetchInput,
  type ProviderAdapter,
} from '../types'
import { PROVIDER_ID } from './constants'
import {
  authorize as oauthAuthorize,
  exchange as oauthExchange,
  refresh as oauthRefresh,
} from './oauth'
import {
  createStrippedStream,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform'
import { fetchUsage, parseUsageHeaders } from './usage'

/**
 * Anthropic (Claude Pro/Max OAuth) provider adapter.
 *
 * Login mode is fixed to "max" (subscription accounts) — the pool exists to
 * balance subscription quota, not metered API keys.
 */
export const anthropicAdapter: ProviderAdapter = {
  id: PROVIDER_ID,

  authorize(): Promise<AuthorizeRequest> {
    return oauthAuthorize()
  },

  exchange(
    input: string,
    verifier: string,
    redirectUri: string,
    state: string,
  ): Promise<TokenSet | null> {
    return oauthExchange(input, verifier, redirectUri, state)
  },

  refresh(refreshToken: string): Promise<TokenSet> {
    return oauthRefresh(refreshToken)
  },

  applyAuth(headers: Headers, account: PoolAccount): void {
    setOAuthHeaders(headers, account.access)
  },

  transformUrl(input: FetchInput): FetchInput {
    return rewriteUrl(input)
  },

  transformBody(body: string): string {
    return rewriteRequestBody(body)
  },

  transformResponse(response: Response): Response {
    return createStrippedStream(response)
  },

  parseUsageHeaders,

  fetchUsage(account: PoolAccount, now: number): Promise<UsageSnapshot | null> {
    return fetchUsage(account, now)
  },

  classifyError(status: number): ErrorClass {
    return classifyHttpStatus(status)
  },
}
