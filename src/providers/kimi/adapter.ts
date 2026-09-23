import type { PoolAccount } from '../../types'
import { classifyHttpStatus, type ProviderAdapter } from '../types'
import { KIMI_CODE, KIMI_CODE_GLOBAL, type KimiDeployment } from './constants'
import { exchange, tokensFromApiKey } from './key'
import { refreshOAuth, startDeviceLogin } from './oauth'
import { usageFetcher } from './usage'

/** Send the pooled key as the Bearer; drop any SDK placeholder key (the loader hands opencode `apiKey: ''`). */
function applyAuth(headers: Headers, account: PoolAccount): void {
  headers.delete('x-api-key')
  headers.set('authorization', `Bearer ${account.access}`)
}

/**
 * Kimi Code adapter for one deployment. A subscription joins the pool either
 * through a device-code OAuth login (`startDeviceLogin`, refreshed by
 * `refresh`) or as a pasted API key (`authorize`/`exchange` +
 * `tokensFromApiKey`). opencode already shapes the requests as
 * OpenAI-compatible chat completions, so they pass through untouched, and
 * inference responses carry no quota headers: usage comes from `/usages`.
 */
export function createKimiAdapter(deployment: KimiDeployment): ProviderAdapter {
  return {
    id: deployment.id,

    startDeviceLogin: () => startDeviceLogin(deployment),
    refresh: (refreshToken) => refreshOAuth(deployment, refreshToken),

    authorize: async () => ({
      url: deployment.consoleUrl,
      verifier: '',
      state: '',
      redirectUri: '',
      instructions: 'Paste your Kimi Code API key here:',
    }),
    exchange: (input) => exchange(deployment, input),
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
