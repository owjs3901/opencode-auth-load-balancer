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
import { applyAuth, rewriteRequestBody, rewriteUrl } from './transform'
import { fetchUsage, parseUsageHeaders } from './usage'

/**
 * OpenAI ChatGPT/Codex (subscription OAuth) provider adapter.
 *
 * Assumes opencode's `openai` provider is configured to use the Responses API
 * (the standard ChatGPT/Codex setup) — requests on a `/responses` path are routed
 * to the Codex backend. Other paths are left untouched.
 */
export const openaiAdapter: ProviderAdapter = {
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
    applyAuth(headers, account)
  },

  transformUrl(input: FetchInput): FetchInput {
    return rewriteUrl(input)
  },

  transformBody(body: string): string {
    return rewriteRequestBody(body)
  },

  transformResponse(response: Response): Response {
    return response
  },

  parseUsageHeaders(
    headers: Headers,
    now: number,
  ): Partial<UsageSnapshot> | null {
    return parseUsageHeaders(headers, now)
  },

  fetchUsage(account: PoolAccount, now: number): Promise<UsageSnapshot | null> {
    return fetchUsage(account, now)
  },

  classifyError(status: number): ErrorClass {
    return classifyHttpStatus(status)
  },
}
