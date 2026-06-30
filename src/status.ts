import { readPool } from './pool/store'
import {
  DEFAULT_CONFIG,
  loadConfig,
  type SchedulerConfig,
} from './scheduler/config'
import {
  compareRanked,
  displayUtil,
  isAvailable,
  scoreAccount,
} from './scheduler/score-core'
import type { PoolAccount, PoolFile } from './types'

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
}

interface AccountStatus {
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

interface ProviderStatus {
  providerID: string
  currentAccountId: string | null
  accounts: AccountStatus[]
}

/**
 * The weekly reset time to display, or `0` when there is none to show.
 *
 * Mirrors `displayUtil`'s expiry rule (inlined here rather than imported, to
 * avoid exporting a new score-core symbol, which would break the byte-identical
 * TUI scoring sync): once a weekly window has reset (`resetAt > 0 && resetAt <=
 * now`) its stored values are stale, so the dashboard shows `0%` util — return
 * `0` here too so the `resets` column matches that `0%` instead of printing the
 * elapsed window's old reset time. `resetAt === 0` (unknown) is NOT expired.
 */
function weeklyResetForDisplay(
  weekly: PoolAccount['usage']['weekly'],
  now: number,
): number {
  if (!weekly) return 0
  const expired = weekly.resetAt > 0 && weekly.resetAt <= now
  return expired ? 0 : weekly.resetAt
}

function toStatus(
  account: PoolAccount,
  now: number,
  current: boolean,
  available: boolean,
  rank: number,
): AccountStatus {
  const weekly = account.usage.weekly
  return {
    id: account.id,
    label: account.label,
    weeklyUtil: displayUtil(weekly, now),
    hourlyUtil: displayUtil(account.usage.hourly, now),
    weeklyResetAt: weeklyResetForDisplay(weekly, now),
    available,
    cooldownUntil: account.cooldownUntil,
    disabledReason: account.disabledReason,
    current,
    rank,
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
  const byProvider = new Map<string, PoolAccount[]>()
  for (const a of pool.accounts) {
    const list = byProvider.get(a.providerID)
    if (list) list.push(a)
    else byProvider.set(a.providerID, [a])
  }
  const providerIds = [...byProvider.keys()].sort()
  return providerIds.map((providerID) => {
    const currentAccountId = pool.lastSelected[providerID] ?? null
    const ranked = (byProvider.get(providerID) ?? [])
      .map((a) => {
        const available = isAvailable(a, cfg, now)
        return {
          a,
          available,
          score: available
            ? scoreAccount(a, cfg, now)
            : Number.NEGATIVE_INFINITY,
          // Pre-compute the unavailable-fallback tie-breaker so the comparator
          // touches each accessor at most once instead of re-reading
          // `a.usage.weekly?.utilization ?? 0` four times per sort pair. The
          // sibling TUI ranking at `tui/auth-load-balancer-tui.view.tsx` uses
          // the same shape (`weeklyUtil` field hoisted into the .map()), so
          // both ranking pipelines stay structurally symmetric. We use the
          // raw stored value (not `utilOf`/`displayUtil`) on purpose: this
          // branch only runs for already-unavailable accounts, and the local
          // `weeklyUtil` helper in `src/scheduler/select.ts` uses the same
          // raw expression — keeping the "least-bad cooling-down account"
          // distinguishable even if its window just rolled over.
          weeklyUtil: a.usage.weekly?.utilization ?? 0,
        }
      })
      .sort(compareRanked)
    const accounts = ranked.map(({ a, available }, i) =>
      toStatus(a, now, a.id === currentAccountId, available, i + 1),
    )
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

/**
 * Render a utilization as `"45%"` (or `"-"` for null/undefined). Shared with
 * `notify.ts` so the dashboard, the `auth_lb_status` tool, and the switch
 * toast cannot silently disagree on the same account's percentage rounding.
 * The TUI view at `tui/auth-load-balancer-tui.view.tsx` keeps its own copy
 * (the TUI runtime cannot import `src/`).
 */
export function pct(u: number | null | undefined): string {
  return typeof u === 'number' ? `${Math.round(u * 100)}%` : '-'
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
