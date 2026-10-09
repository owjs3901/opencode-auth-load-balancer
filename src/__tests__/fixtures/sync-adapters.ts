import { tokensFromApiKey } from '../../providers/kimi/key'
import type { ProviderAdapter } from '../../providers/types'
import {
  STATIC_CREDENTIAL_EXPIRES,
  type TokenSet,
  type UsageSnapshot,
} from '../../types'
import { fakeAdapter } from './adapter'
import { CLAUDE_TOKEN_2, REJECTED_TOKEN } from './sync'

const USAGE: UsageSnapshot = { hourly: null, weekly: null, capturedAt: 0 }

/** The organization of a test token: org-2 for the second one (and its variants), org-3 for one marked _org3_, org-1 for the rest. */
export const orgOf = (token: string): string =>
  token.startsWith(CLAUDE_TOKEN_2)
    ? 'org-2'
    : token.includes('_org3_')
      ? 'org-3'
      : 'org-1'

export function claudeSyncAdapter(
  org: string | null | ((token: string) => string | null) = 'org-1',
): ProviderAdapter {
  const orgIdOf = (token: string): string | null =>
    typeof org === 'function' ? org(token) : org
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
              ...(orgIdOf(token) ? { orgId: orgIdOf(token) ?? '' } : {}),
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
