import { tokensFromApiKey } from '../../providers/kimi/key'
import type { ProviderAdapter } from '../../providers/types'
import {
  STATIC_CREDENTIAL_EXPIRES,
  type TokenSet,
  type UsageSnapshot,
} from '../../types'
import { fakeAdapter } from './adapter'
import { REJECTED_TOKEN } from './sync'

const USAGE: UsageSnapshot = { hourly: null, weekly: null, capturedAt: 0 }

/** Claude adapter whose setup-token probe accepts every token but `REJECTED_TOKEN`. */
export function claudeSyncAdapter(
  orgId: string | null = 'org-1',
): ProviderAdapter {
  return fakeAdapter({
    id: 'anthropic',
    tokenLogin: {
      label: 'setup-token',
      url: '',
      instructions: '',
      exchange: async (token): Promise<TokenSet | null> =>
        token === REJECTED_TOKEN
          ? null
          : {
              access: token,
              refresh: '',
              expires: STATIC_CREDENTIAL_EXPIRES,
              inferenceOnly: true,
              ...(orgId ? { orgId } : {}),
              usage: { ...USAGE },
            },
    },
  })
}

/** Kimi-like adapter: a key is verified and keyed by the account behind it. */
export function kimiSyncAdapter(
  accountId = 'kimi-user-1',
  id = 'kimi-code-plan-cn',
): ProviderAdapter {
  return fakeAdapter({
    id,
    tokensFromApiKey,
    exchange: async (key): Promise<TokenSet | null> => ({
      access: key,
      refresh: '',
      expires: STATIC_CREDENTIAL_EXPIRES,
      accountId,
    }),
  })
}
