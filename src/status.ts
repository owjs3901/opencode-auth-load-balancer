import { readPool } from './pool/store'
import {
  DEFAULT_CONFIG,
  loadConfig,
  type SchedulerConfig,
} from './scheduler/config'
import { isAvailable, scoreAccount } from './scheduler/score'
import type { PoolAccount, PoolFile } from './types'

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
}

export interface AccountStatus {
  id: string
  label: string
  weeklyUtil: number | null
  hourlyUtil: number | null
  weeklyResetAt: number
  available: boolean
  cooldownUntil: number
  disabledReason: string | null
  /** The account that most recently served a request for this provider. */
  current: boolean
  /** 1 = next candidate the scheduler would pick. */
  rank: number
}

export interface ProviderStatus {
  providerID: string
  currentAccountId: string | null
  accounts: AccountStatus[]
}

function toStatus(
  account: PoolAccount,
  now: number,
  cfg: SchedulerConfig,
  current: boolean,
): AccountStatus {
  return {
    id: account.id,
    label: account.label,
    weeklyUtil: account.usage.weekly?.utilization ?? null,
    hourlyUtil: account.usage.hourly?.utilization ?? null,
    weeklyResetAt: account.usage.weekly?.resetAt ?? 0,
    available: isAvailable(account, cfg, now),
    cooldownUntil: account.cooldownUntil,
    disabledReason: account.disabledReason,
    current,
    rank: 0,
  }
}

/**
 * Build the ranked status model: per provider, the candidate accounts sorted in
 * the order the scheduler would pick them (available accounts by urgency score,
 * then unavailable ones by weekly utilization). Mirrors `selectAccount`'s ordering.
 */
export function buildStatus(
  pool: PoolFile,
  now: number,
  cfg: SchedulerConfig = DEFAULT_CONFIG,
): ProviderStatus[] {
  const providerIds = [
    ...new Set(pool.accounts.map((a) => a.providerID)),
  ].sort()
  return providerIds.map((providerID) => {
    const currentAccountId = pool.lastSelected[providerID] ?? null
    const ranked = pool.accounts
      .filter((a) => a.providerID === providerID)
      .map((a) => {
        const available = isAvailable(a, cfg, now)
        return {
          a,
          available,
          score: available
            ? scoreAccount(a, cfg, now)
            : Number.NEGATIVE_INFINITY,
        }
      })
      .sort((x, y) => {
        if (x.available !== y.available) return x.available ? -1 : 1
        if (x.available) return y.score - x.score
        return (
          (x.a.usage.weekly?.utilization ?? 0) -
          (y.a.usage.weekly?.utilization ?? 0)
        )
      })
    const accounts = ranked.map(({ a }, i) => {
      const status = toStatus(a, now, cfg, a.id === currentAccountId)
      status.rank = i + 1
      return status
    })
    return { providerID, currentAccountId, accounts }
  })
}

/** Read the live pool and build its ranked status. */
export async function readStatus(
  now: number = Date.now(),
  cfg: SchedulerConfig = loadConfig(),
): Promise<ProviderStatus[]> {
  return buildStatus(await readPool(), now, cfg)
}

function pct(u: number | null): string {
  return u === null ? '-' : `${Math.round(u * 100)}%`
}

function relTime(at: number, now: number): string {
  if (at <= now) return '-'
  const mins = Math.round((at - now) / 60_000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h${mins % 60}m`
  return `${Math.floor(hrs / 24)}d${hrs % 24}h`
}

function stateOf(a: AccountStatus, now: number): string {
  if (a.disabledReason) return 're-login'
  if (a.cooldownUntil > now) return `cooldown ${relTime(a.cooldownUntil, now)}`
  if (!a.available) return 'exhausted'
  return a.current ? 'in use' : 'ready'
}

export function providerName(providerID: string): string {
  return PROVIDER_NAMES[providerID] ?? providerID
}

/** Render the status model as a compact text dashboard (for tools/commands/CLI). */
export function renderStatus(
  providers: ProviderStatus[],
  now: number = Date.now(),
): string {
  if (providers.length === 0)
    return 'auth-load-balancer: no accounts registered.'
  const lines: string[] = []
  for (const p of providers) {
    const current = p.accounts.find((a) => a.current)
    lines.push(
      `${providerName(p.providerID)} — in use: ${current ? current.label : '(none yet)'}`,
    )
    lines.push('  #  account            weekly   5h   resets   state')
    for (const a of p.accounts) {
      const mark = a.current ? '▶' : ' '
      lines.push(
        `  ${String(a.rank).padEnd(2)} ${mark} ${a.label.padEnd(16)} ${pct(a.weeklyUtil).padStart(5)} ${pct(a.hourlyUtil).padStart(5)} ${relTime(a.weeklyResetAt, now).padStart(7)}  ${stateOf(a, now)}`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** One-line "provider: account" summary of what's in use (for toasts / logs). */
export function summarizeCurrent(providers: ProviderStatus[]): string {
  if (providers.length === 0) return 'no accounts'
  return providers
    .map((p) => {
      const current = p.accounts.find((a) => a.current)
      return `${providerName(p.providerID)}: ${current ? current.label : '—'}`
    })
    .join(' | ')
}
