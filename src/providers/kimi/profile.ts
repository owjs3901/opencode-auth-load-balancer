import { isPlainObject } from '../../util'
import { fetchJson } from '../usage-http'
import { USAGE_HTTP_TIMEOUT_MS } from './constants'

/** What `GET /me` says about the account behind a bearer. */
export interface KimiProfile {
  /** Kimi's account id: one per subscription, whichever key or login reaches it. */
  readonly userId?: string
}

/**
 * `GET {baseUrl}/me` with an API key or an OAuth access token. Null when the
 * bearer is refused or the call fails, so it doubles as the key check.
 */
export async function fetchProfile(
  baseUrl: string,
  bearer: string,
): Promise<KimiProfile | null> {
  const me = await fetchJson<unknown>(
    `${baseUrl}/me`,
    { authorization: `Bearer ${bearer}`, accept: 'application/json' },
    USAGE_HTTP_TIMEOUT_MS,
  )
  if (!isPlainObject(me)) return null
  return typeof me.user_id === 'string' && me.user_id !== ''
    ? { userId: me.user_id }
    : {}
}
