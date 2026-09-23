import { createHash } from 'node:crypto'

import type { TokenSet } from '../../types'
import { type KimiDeployment, STATIC_KEY_EXPIRES } from './constants'
import { fetchProfile } from './profile'

/**
 * Map a Kimi Code API key onto the pool's token shape: the key is the bearer,
 * with no refresh token and an expiry that never comes due. `accountId` is a
 * fingerprint of the key — `addAccount` dedups on it — which a login upgrades
 * to the Kimi account id; this bare form serves the startup import, where no
 * network call can run.
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
 * The pasted key, checked against `GET /me` before it can join the pool: a
 * typo, a Moonshot open-platform key, or a stray URL fails the login instead
 * of adding a row that only ever 401s. The row is keyed by the Kimi account
 * behind the key, so a second key — or an OAuth login — for the same
 * subscription replaces its row instead of double-counting one quota.
 */
export async function exchange(
  deployment: KimiDeployment,
  input: string,
): Promise<TokenSet | null> {
  const key = input.trim()
  if (!/^\S+$/.test(key)) return null
  const profile = await fetchProfile(deployment.baseUrl, key)
  if (!profile) return null
  const tokens = tokensFromApiKey(key)
  return profile.userId ? { ...tokens, accountId: profile.userId } : tokens
}
