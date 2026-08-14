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
import {
  MANUAL_DISABLED_REASON,
  type PoolAccount,
  type PoolFile,
} from './types'

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
}

/**
 * Byte-deterministic ASCII string comparator. Uses raw `< / >` rather than
 * `localeCompare` to stay byte-deterministic regardless of host locale.
 * Shared by every raw-ASCII sort site in this file (provider sections,
 * model-tier names) so the "why raw `< / >` and not `localeCompare`"
 * rationale lives in one place instead of being repeated per call site.
 */
function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Deterministic ASCII order for provider sections by id (`anthropic` before `openai`). */
function byProviderId(
  a: [string, PoolAccount[]],
  b: [string, PoolAccount[]],
): number {
  return compareAscii(a[0], b[0])
}

interface AccountStatus {
  id: string
  label: string
  weeklyUtil: number | null
  hourlyUtil: number | null
  weeklyResetAt: number
  available: boolean
  cooldownUntil: number
  /** tier name → epoch ms until that model tier's cap resets (empty = none). */
  modelCooldownsUntil: Record<string, number>
  disabledReason: string | null
  /** The account that most recently served a request for this provider. */
  current: boolean
  /** 1 = next candidate the scheduler would pick. */
  rank: number
}

interface ProviderStatus {
  providerID: string
  accounts: AccountStatus[]
}

/**
 * Whether a usage window has already reset (its stored values are stale).
 *
 * Mirrors `displayUtil`'s expiry rule (re-spelled here rather than imported, to
 * avoid exporting a new score-core symbol, which would break the byte-identical
 * TUI scoring sync). A `null` window or `resetAt === 0` (unknown) is NOT expired.
 */
function isExpired(
  window: PoolAccount['usage']['weekly'],
  now: number,
): boolean {
  return !!window && window.resetAt > 0 && window.resetAt <= now
}

function toStatus(
  account: PoolAccount,
  now: number,
  current: boolean,
  available: boolean,
  rank: number,
): AccountStatus {
  const weekly = account.usage.weekly
  // Evaluate the weekly window's expiry ONCE and reuse it for both display
  // values: a reset window shows `0%` util, so the `resets` column must show
  // `0` too (not the elapsed window's stale reset time) to match that `0%`.
  const weeklyExpired = isExpired(weekly, now)
  return {
    id: account.id,
    label: account.label,
    weeklyUtil: displayUtil(weekly, now),
    hourlyUtil: displayUtil(account.usage.hourly, now),
    weeklyResetAt: weekly && !weeklyExpired ? weekly.resetAt : 0,
    available,
    cooldownUntil: account.cooldownUntil,
    modelCooldownsUntil: account.modelCooldownsUntil ?? {},
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
  const sorted = [...byProvider.entries()].sort(byProviderId)
  return sorted.map(([providerID, providerAccounts]) => {
    const currentAccountId = pool.lastSelected[providerID] ?? null
    const ranked = providerAccounts
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
    return { providerID, accounts }
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
 * `tui/auth-load-balancer-tui.logic.ts` keeps its own copy
 * (the TUI runtime cannot import `src/`).
 */
export function pct(u: number | null | undefined): string {
  return typeof u === 'number' ? `${Math.round(u * 100)}%` : '-'
}

/**
 * Approximate on-screen terminal width of a string, treating common East-Asian
 * "wide" characters (Hangul, CJK Unified Ideographs + Extension blocks,
 * Hiragana/Katakana, fullwidth forms) as 2 columns and everything else as 1.
 * Account labels are user-editable free-form text (rename tool / TUI / a
 * hand-edited pool file), and this project's own stated locale is `ko-KR` —
 * a CJK/Hangul label is plausible, and `.length` (UTF-16 code units) undercounts
 * each such character by one column, breaking `renderStatus`'s table alignment.
 * Not a full Unicode-grapheme-cluster/emoji-aware implementation — a pragmatic,
 * dependency-free improvement over the previous zero handling for the common
 * CJK case. Degenerates to `.length` for pure-ASCII input.
 */
export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK Radicals .. Yi (covers CJK ideographs, Kana, Hangul Compatibility Jamo)
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
      (cp >= 0x20000 && cp <= 0x3fffd) // CJK Extension B+ / Compatibility Supplement
    width += wide ? 2 : 1
  }
  return width
}

/** Pad `s` on the right with spaces up to `width` display columns (CJK-aware). */
function padDisplayEnd(s: string, width: number): string {
  const pad = width - displayWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

function relTime(at: number, now: number): string {
  if (at <= now) return '-'
  // Floor at 1: a sub-30s future time would otherwise round to "0m", which
  // reads as "already done" while the guard above reserves '-' for elapsed.
  const mins = Math.max(1, Math.round((at - now) / 60_000))
  if (mins <= 120) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (mins <= 48 * 60) return `${hrs}h${mins % 60}m`
  return `${Math.floor(hrs / 24)}d${hrs % 24}h`
}

function stateOf(a: AccountStatus, now: number): string {
  if (a.disabledReason)
    return a.disabledReason === MANUAL_DISABLED_REASON ? 'disabled' : 're-login'
  if (a.cooldownUntil > now) return `cooldown ${relTime(a.cooldownUntil, now)}`
  if (!a.available) return 'exhausted'
  const base = a.current ? 'in use' : 'ready'
  // A model-tier limit does NOT sideline the account (it still serves every
  // other model; tier requests steer to accounts with headroom or downgrade)
  // — so each active tier annotates the usable state rather than replacing
  // it, showing when that tier recovers. Sorted by tier name (raw `< / >`,
  // no locale) so the rendered bytes are deterministic.
  const tiers = Object.entries(a.modelCooldownsUntil)
    .filter(([, until]) => until > now)
    .sort(([x], [y]) => compareAscii(x, y))
    .map(([tier, until]) => `${tier} ${relTime(until, now)}`)
  if (tiers.length > 0) return `${base} · ${tiers.join(' · ')}`
  return base
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
    // Labels are user-editable (rename tool/TUI or the pool file directly), so
    // pad the label column to the provider's longest label. `max(16, …)` keeps
    // the classic layout — and the rendered bytes — unchanged for short labels.
    // Use display-width (not `.length`/UTF-16 code units) so a CJK/fullwidth
    // label (plausible — this project's own stated locale is `ko-KR`) doesn't
    // shear the weekly/5h/resets/state columns out of alignment.
    const width = p.accounts.reduce(
      (w, a) => Math.max(w, displayWidth(a.label)),
      16,
    )
    lines.push(
      `  #  ${'account'.padEnd(width + 3)}weekly   5h   resets   state`,
    )
    for (const a of p.accounts) {
      const mark = a.current ? '▶' : ' '
      lines.push(
        `  ${String(a.rank).padEnd(2)} ${mark} ${padDisplayEnd(a.label, width)} ${pct(a.weeklyUtil).padStart(5)} ${pct(a.hourlyUtil).padStart(5)} ${relTime(a.weeklyResetAt, now).padStart(7)}  ${stateOf(a, now)}`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
