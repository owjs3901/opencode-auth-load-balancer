/**
 * The sync side of the refresh hooks: before a machine spends a login's
 * single-use refresh token it looks at the gist, because another machine may
 * have refreshed that login already.
 *
 * Runs inside the caller's refresh lock, so it never takes that lock again and
 * never takes the cycle lock or writes the sync state (the cycle takes refresh
 * locks while holding the cycle lock; the other order could deadlock).
 */
import type { PoolAccount } from '../types'
import { decodeKey, open } from './crypto'
import { syncEnabled } from './enabled'
import { readGist } from './gist'
import { discoverGithubToken, type GhRunner } from './github-auth'
import { compareLogins, LOGIN_PROVIDERS, loginKey } from './login-payload'
import {
  loginsSyncEnabled,
  overwriteLocked,
  sameLogin,
  versionOf,
} from './logins'
import { parsePayload } from './payload'
import { readSyncState } from './state'

/** The hook `refresh.ts` calls; `runGh` finds the GitHub token (a test replaces it). */
export function createPullLogin(runGh?: GhRunner) {
  /** True only when a newer gist login was put on `account`. Any failure is "nothing adopted". */
  return async function pullLogin(
    account: PoolAccount,
    _recovery: boolean,
  ): Promise<boolean> {
    const { providerID, accountId } = account
    if (!syncEnabled() || !loginsSyncEnabled()) return false
    if (!LOGIN_PROVIDERS.has(providerID) || !accountId || !account.refresh)
      return false
    try {
      const state = await readSyncState()
      if (!state) return false
      const token = (await discoverGithubToken(runGh)) ?? undefined
      const read = await readGist(state.gistId, undefined, Date.now(), token)
      if (!read.changed) return false
      const key = decodeKey(state.key) ?? Buffer.alloc(32)
      const wanted = loginKey(providerID, accountId)
      const login = parsePayload(open(read.content, key)).logins.find(
        (l) => l.key === wanted,
      )
      if (!login || !sameLogin(account, login)) return false
      if (compareLogins(login, versionOf(account)) <= 0) return false
      return await overwriteLocked(account, login)
    } catch {
      return false
    }
  }
}

export const pullLogin = createPullLogin()
