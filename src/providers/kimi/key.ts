import { createHash } from 'node:crypto'

import type { TokenSet } from '../../types'
import { type KimiDeployment, STATIC_KEY_EXPIRES } from './constants'
import { getUsages } from './usage'

/**
 * Map a Kimi Code API key onto the pool's token shape: the key is the bearer,
 * with no refresh token and an expiry that never comes due. `accountId` is a
 * fingerprint of the key — `addAccount` dedups on it, so re-adding a key
 * updates its row instead of appending a second copy of the same quota.
 */
export function tokensFromApiKey(key: string): TokenSet {
  const fingerprint = createHash('sha256').update(key).digest('hex')
  return {
    access: key,
    refresh: '',
    expires: STATIC_KEY_EXPIRES,
    accountId: `key:${fingerprint.slice(0, 16)}`,
  }
}

/**
 * The pasted key, checked against `/usages` before it can join the pool: a
 * typo, a Moonshot open-platform key, or a stray URL fails the login instead
 * of adding a row that only ever 401s.
 */
export async function exchange(
  deployment: KimiDeployment,
  input: string,
): Promise<TokenSet | null> {
  const key = input.trim()
  if (!/^\S+$/.test(key)) return null
  const usages = await getUsages(deployment.baseUrl, key)
  return usages === null ? null : tokensFromApiKey(key)
}

/**
 * Never due (`expires` never lapses). Should a row's expiry get corrupted, the
 * `invalid_grant` text makes refresh.ts park it for a re-login instead of
 * retrying a key that no refresh can replace.
 */
export async function refresh(): Promise<TokenSet> {
  throw new Error('invalid_grant: a Kimi Code API key cannot be refreshed')
}
