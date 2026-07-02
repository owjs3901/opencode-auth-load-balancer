import { classifyHttpStatus, type ProviderAdapter } from '../types'
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

  authorize: oauthAuthorize,
  exchange: oauthExchange,
  refresh: oauthRefresh,

  applyAuth,
  transformUrl: rewriteUrl,
  transformBody: rewriteRequestBody,

  // Sole method body left: no named identity function exists to reference.
  transformResponse(response: Response): Response {
    return response
  },

  parseUsageHeaders,
  fetchUsage,

  classifyError: classifyHttpStatus,
}
