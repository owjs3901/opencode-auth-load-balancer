/**
 * Hooks gist sync plugs into the refresh path. A leaf module on purpose:
 * `refresh.ts` stays free of GitHub and crypto code, and sync can register
 * without an import cycle. No hooks are set unless sync registers some.
 */
import type { PoolAccount } from './types'

export interface RefreshHooks {
  /**
   * Called inside the account's refresh lock, before the provider is asked:
   * resolves true when it put a newer shared login on the row (re-read it).
   * `recovery` is set once the provider refused the refresh token.
   */
  pull?: (account: PoolAccount, recovery: boolean) => Promise<boolean>
  /** Called outside the lock after a refresh this call performed. */
  afterRefresh?: () => void
}

let current: RefreshHooks | null = null

export function setRefreshHooks(hooks: RefreshHooks | null): void {
  current = hooks
}

export function getRefreshHooks(): RefreshHooks | null {
  return current
}
