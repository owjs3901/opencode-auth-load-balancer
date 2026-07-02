import type { PoolAccount } from '../../types'
import { classifyHttpStatus, type ProviderAdapter } from '../types'
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

  authorize: oauthAuthorize,
  exchange: oauthExchange,
  refresh: oauthRefresh,

  // Sole wrapper left: adapts (headers, account) → (headers, account.access).
  applyAuth(headers: Headers, account: PoolAccount): void {
    setOAuthHeaders(headers, account.access)
  },

  transformUrl: rewriteUrl,
  transformBody: rewriteRequestBody,
  transformResponse: createStrippedStream,

  parseUsageHeaders,
  fetchUsage,

  classifyError: classifyHttpStatus,
}
