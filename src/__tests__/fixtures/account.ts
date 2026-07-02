import { emptyUsage, type PoolAccount } from '../../types'

/**
 * Shared PoolAccount test fixture. Every test file's per-file builder
 * delegates here so a future PoolAccount field addition is edited ONCE, not
 * once per test file. Defaults are the neutral "zero" account; per-file
 * builders override only what their tests actually rely on.
 */
export function testAccount(over: Partial<PoolAccount> = {}): PoolAccount {
  return {
    id: 'x',
    providerID: 'anthropic',
    label: 'x',
    access: 'tok',
    refresh: 'r',
    expires: 0,
    accountId: null,
    usage: emptyUsage(),
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: 0,
    ...over,
  }
}
