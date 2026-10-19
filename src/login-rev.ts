/**
 * The shared version of a row's OAuth login. Gist sync orders the copies of one
 * login that different machines hold by it, so every change of the access +
 * refresh pair (login, refresh, minted rotation) bumps it in the same pool
 * transaction as the credential.
 */
import type { PoolAccount } from './types'

/** Record that `row`'s login pair just changed. */
export function bumpLoginRev(row: PoolAccount, now = Date.now()): void {
  row.loginRev = (row.loginRev ?? 1) + 1
  row.loginAt = now
}

/** The version of a row's login; a row that never recorded one is revision 1, at time 0. */
export function loginVersion(row: PoolAccount): { rev: number; at: number } {
  return { rev: row.loginRev ?? 1, at: row.loginAt ?? 0 }
}
