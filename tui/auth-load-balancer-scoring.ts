/**
 * Pure account-scoring core — the SINGLE SOURCE OF TRUTH for how the load balancer
 * ranks accounts. Imported by both the server scheduler (score.ts / config.ts) AND the
 * standalone TUI view, which loads a byte-identical copy installed alongside it
 * (`tui/auth-load-balancer-scoring.ts`, kept in sync by a build step + a test). Keeping
 * the formula in one place means the dashboard's ranking can never silently drift from
 * what the scheduler actually picks (which it once did, as duplicated copies).
 *
 * This module MUST stay dependency-free (only `process.env`) so the TUI view can load a
 * single copied file without resolving the rest of `src/`.
 */

/** Tunable scoring knobs (the subset of the scheduler config that affects ranking). */
export interface ScoreConfig {
  /**
   * How much the 5h-window headroom modulates the weekly-urgency score, in [0,1].
   * 0 = ignore the 5h window; 1 = an account with no 5h headroom scores 0. Applied
   * multiplicatively so it de-rates within the weekly ordering but never flips it.
   */
  hourlyInfluence: number
  /** Floor for time-until-reset (ms). Caps how large urgency can grow near a reset. */
  minResetMs: number
  /** Baseline horizon (ms) used when an account's weekly reset time is unknown/stale. */
  weekWindowMs: number
  /**
   * Hard exhaustion: utilization >= this excludes the account entirely while others
   * have headroom, and forces a pinned session off it regardless of switch cost.
   */
  exhaustedAt: number
  /**
   * Soft threshold for the SHORT 5h window: proactively migrate a pinned session once
   * its 5h utilization crosses this — before it hard-exhausts at `exhaustedAt`. Must be
   * < exhaustedAt. (The WEEKLY window migrates at the higher `weeklyDrainTarget`.)
   */
  migrateAt: number
  /**
   * Weekly drain target (default 0.98): scoring treats weekly quota as "fully drained"
   * at this utilization (the account stops being favored past it), and a pinned session
   * proactively migrates once its WEEKLY util crosses it — so perishable weekly quota is
   * drained close to full before the window resets. In (migrateAt, exhaustedAt].
   */
  weeklyDrainTarget: number
}

/** A single rate-limit window slice the scoring reads. */
export interface ScoreWindow {
  utilization: number
  resetAt: number
}

/**
 * The slice of an account the scoring reads. The server's full `PoolAccount` and the
 * TUI's parsed-pool account both satisfy this (the TUI normalizes its looser JSON into
 * this shape before scoring).
 */
export interface ScoreAccount {
  usage: {
    hourly: ScoreWindow | null
    weekly: ScoreWindow | null
  }
  cooldownUntil: number
  disabledReason: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** The ~5h short rolling window (Anthropic 5h ≈ Codex primary). */
const HOURLY_WINDOW_MS = 5 * HOUR_MS
/**
 * ~6h cushion added to time-to-reset so an imminent reset stays urgent without the score
 * exploding toward infinity at the reset instant (and so tiny crumbs near a reset don't
 * dominate). In days.
 */
const RESET_CUSHION_DAYS = 0.25

/** Scoring-config defaults (the scoring subset of the scheduler's DEFAULT_CONFIG). */
export const SCORE_DEFAULTS: ScoreConfig = {
  hourlyInfluence: 0.25,
  minResetMs: 5 * 60 * 1000, // 5 minutes
  weekWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  exhaustedAt: 0.999,
  migrateAt: 0.95,
  weeklyDrainTarget: 0.98,
}

/** Read scoring overrides from env (OPENCODE_AUTH_LB_*), falling back to SCORE_DEFAULTS. */
export function loadScoreConfig(
  env: Record<string, string | undefined> = process.env,
): ScoreConfig {
  const num = (key: string, dflt: number): number => {
    const raw = env[key]
    if (raw === undefined) return dflt
    const n = Number(raw)
    return Number.isFinite(n) ? n : dflt
  }
  return {
    hourlyInfluence: num(
      'OPENCODE_AUTH_LB_HOURLY_INFLUENCE',
      SCORE_DEFAULTS.hourlyInfluence,
    ),
    minResetMs: num('OPENCODE_AUTH_LB_MIN_RESET_MS', SCORE_DEFAULTS.minResetMs),
    weekWindowMs: num(
      'OPENCODE_AUTH_LB_WEEK_WINDOW_MS',
      SCORE_DEFAULTS.weekWindowMs,
    ),
    exhaustedAt: num(
      'OPENCODE_AUTH_LB_EXHAUSTED_AT',
      SCORE_DEFAULTS.exhaustedAt,
    ),
    migrateAt: num('OPENCODE_AUTH_LB_MIGRATE_AT', SCORE_DEFAULTS.migrateAt),
    weeklyDrainTarget: num(
      'OPENCODE_AUTH_LB_WEEKLY_DRAIN_TARGET',
      SCORE_DEFAULTS.weeklyDrainTarget,
    ),
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function utilOf(window: ScoreWindow | null): number {
  return window ? clamp01(window.utilization) : 0
}

/** The busiest window's utilization (whichever of 5h / weekly is higher). */
export function maxUtil(account: ScoreAccount): number {
  return Math.max(utilOf(account.usage.hourly), utilOf(account.usage.weekly))
}

/** An account is exhausted when ANY window is at/over the exhaustion threshold. */
export function isExhausted(account: ScoreAccount, cfg: ScoreConfig): boolean {
  return maxUtil(account) >= cfg.exhaustedAt
}

/**
 * True once a pinned session should proactively move on — BEFORE the hard `exhaustedAt`
 * wall — so in-flight subagents never hit a 100% limit. The two windows use different
 * thresholds: the WEEKLY window drains to `weeklyDrainTarget` (~0.98 — perishable
 * use-it-or-lose-it quota, drained nearly full), while the shorter 5h window migrates
 * earlier at `migrateAt` (~0.95) for hard-limit safety.
 */
export function overSoftThreshold(
  account: ScoreAccount,
  cfg: ScoreConfig,
): boolean {
  return (
    utilOf(account.usage.weekly) >= cfg.weeklyDrainTarget ||
    utilOf(account.usage.hourly) >= cfg.migrateAt
  )
}

/** Available = not disabled, not in cooldown, and not exhausted. */
export function isAvailable(
  account: ScoreAccount,
  cfg: ScoreConfig,
  now: number,
): boolean {
  if (account.disabledReason) return false
  if (account.cooldownUntil > now) return false
  if (isExhausted(account, cfg)) return false
  return true
}

/**
 * Weekly "urgency" — how perishable an account's remaining weekly quota is. It favors
 * draining the SOONEST-resetting account first (earliest-deadline-first), because unused
 * weekly quota is LOST at the reset:
 *
 *   drainable = max(0, weeklyDrainTarget - weeklyUtil)   // quota left to safely burn
 *   urgency   = drainable / (daysToReset + cushion)^2
 *
 * The SQUARED time term is the key: it approximates the cost of DELAYING — as a reset
 * nears, the drain rate needed to avoid waste worsens nonlinearly, so a near-reset
 * account outranks one that merely has more quota left but resets far away (which is what
 * `remaining / time` failed to do). `drainable` caps the chase at `weeklyDrainTarget`
 * (stop favoring an account near the top of its window) and the cushion prevents a blow-up
 * at the reset instant. An unknown/stale reset time falls back to a full-window baseline,
 * keeping the account conservative (low urgency) until real reset metadata arrives.
 */
export function weeklyUrgency(
  account: ScoreAccount,
  cfg: ScoreConfig,
  now: number,
): number {
  const drainable = Math.max(
    0,
    cfg.weeklyDrainTarget - utilOf(account.usage.weekly),
  )
  const resetAt = account.usage.weekly?.resetAt ?? 0
  const ms = resetAt > now ? resetAt - now : cfg.weekWindowMs
  const days = Math.max(ms, cfg.minResetMs) / DAY_MS + RESET_CUSHION_DAYS
  return drainable / (days * days)
}

/**
 * Score one candidate account (higher is better):
 *   score = weeklyUrgency * (1 - hourlyInfluence * hourlyPressure)
 *
 * The 5h window is only a SAFETY de-rate (avoid a short-window hard limit), NOT a quota
 * objective — and it is RESET-AWARE: `hourlyPressure = hourlyUtil * (msToReset / 5h)`, so
 * an account whose 5h window is busy but resets in minutes is barely penalized (its
 * short-term pressure is about to clear), letting the perishable weekly urgency drive the
 * choice. An unknown 5h reset is treated as a full window (full penalty).
 */
export function scoreAccount(
  account: ScoreAccount,
  cfg: ScoreConfig,
  now: number,
): number {
  const urgency = weeklyUrgency(account, cfg, now)
  const hourlyUtil = utilOf(account.usage.hourly)
  const resetAt = account.usage.hourly?.resetAt ?? 0
  const msToReset = resetAt > now ? resetAt - now : HOURLY_WINDOW_MS
  const resetFactor = clamp01(msToReset / HOURLY_WINDOW_MS)
  const pressure = hourlyUtil * resetFactor
  return urgency * (1 - cfg.hourlyInfluence * pressure)
}
