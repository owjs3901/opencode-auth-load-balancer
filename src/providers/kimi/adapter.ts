import type { PoolAccount } from '../../types'
import { classifyHttpStatus, type ProviderAdapter } from '../types'
import { KIMI_CODE, KIMI_CODE_GLOBAL, type KimiDeployment } from './constants'
import { exchange, refresh, tokensFromApiKey } from './key'
import { usageFetcher } from './usage'

/** Send the pooled key as the Bearer; drop any SDK placeholder key (the loader hands opencode `apiKey: ''`). */
function applyAuth(headers: Headers, account: PoolAccount): void {
  headers.delete('x-api-key')
  headers.set('authorization', `Bearer ${account.access}`)
}

/**
 * Kimi Code (subscription API key) adapter for one deployment. opencode
 * already shapes these requests as OpenAI-compatible chat completions, so they
 * pass through untouched. Inference responses carry no quota headers: usage
 * comes from `/usages` alone.
 */
export function createKimiAdapter(deployment: KimiDeployment): ProviderAdapter {
  return {
    id: deployment.id,

    authorize: async () => ({
      url: deployment.consoleUrl,
      verifier: '',
      state: '',
      redirectUri: '',
      instructions: 'Paste your Kimi Code API key here:',
    }),
    exchange: (input) => exchange(deployment, input),
    refresh,
    tokensFromApiKey,

    applyAuth,
    transformUrl: (input) => input,
    transformBody: (body) => body,
    transformResponse: (response) => response,

    parseUsageHeaders: () => null,
    fetchUsage: usageFetcher(deployment.baseUrl),

    classifyError: classifyHttpStatus,
  }
}

export const kimiCodeAdapter = createKimiAdapter(KIMI_CODE)
export const kimiCodeGlobalAdapter = createKimiAdapter(KIMI_CODE_GLOBAL)
