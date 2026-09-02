import type { ScoreConfig } from '../scheduler/score-core'
import { utilOf } from '../scheduler/score-core'
import type { PoolAccount, UsageWindow } from '../types'

export type ProviderRecovery =
  | { state: 'available' }
  | { state: 'quota-blocked'; nextCheckAt: number; resumeAt: number | null }
  | { state: 'unusable' }

function exhaustedWindows(
  account: PoolAccount,
  cfg: Pick<ScoreConfig, 'exhaustedAt'>,
  now: number,
): UsageWindow[] {
  const windows: UsageWindow[] = []
  const hourly = account.usage.hourly
  const weekly = account.usage.weekly
  if (hourly && utilOf(hourly, now) >= cfg.exhaustedAt) windows.push(hourly)
  if (weekly && utilOf(weekly, now) >= cfg.exhaustedAt) windows.push(weekly)
  return windows
}

/**
 * Determine whether a provider can serve now, is provably blocked only by
 * account-wide quota, or has no account that waiting for quota can repair.
 */
export function classifyProviderRecovery(
  accounts: readonly PoolAccount[],
  providerID: string,
  cfg: Pick<ScoreConfig, 'exhaustedAt'>,
  now: number,
  pollMs: number,
): ProviderRecovery {
  let hasQuotaCandidate = false
  let hasUnknownReset = false
  const knownAccountRecoveries: number[] = []

  for (const account of accounts) {
    if (account.providerID !== providerID || account.disabledReason) continue

    const windows = exhaustedWindows(account, cfg, now)
    const cooldownActive = account.cooldownUntil > now

    if (!cooldownActive && windows.length === 0) return { state: 'available' }

    // Auth and transport cooldowns are not quota work. They do not prevent a
    // different quota-blocked account from making the provider waitable, but
    // cannot establish durable pending on their own.
    if (
      cooldownActive &&
      (account.cooldownKind === 'auth' || account.cooldownKind === 'transient')
    )
      continue

    // A legacy unclassified cooldown is quota evidence only when a live usage
    // window independently proves exhaustion.
    if (cooldownActive && account.cooldownKind === undefined && !windows.length)
      continue

    hasQuotaCandidate = true
    const constraints: number[] = []
    let accountHasUnknownReset = false
    for (const window of windows) {
      if (window.resetAt > now) constraints.push(window.resetAt)
      else accountHasUnknownReset = true
    }
    if (cooldownActive) constraints.push(account.cooldownUntil)

    if (accountHasUnknownReset) {
      hasUnknownReset = true
      continue
    }
    knownAccountRecoveries.push(Math.max(...constraints))
  }

  if (!hasQuotaCandidate) return { state: 'unusable' }

  const resumeAt = knownAccountRecoveries.length
    ? Math.min(...knownAccountRecoveries)
    : null
  const pollAt = hasUnknownReset
    ? now + Math.max(0, pollMs)
    : Number.POSITIVE_INFINITY
  const nextCheckAt = Math.min(resumeAt ?? Number.POSITIVE_INFINITY, pollAt)
  return { state: 'quota-blocked', nextCheckAt, resumeAt }
}
