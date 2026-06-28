import type { PoolAccount, PoolFile } from '../types'
import { DEFAULT_CONFIG, type SchedulerConfig } from './config'
import {
  isAvailable,
  maxUtil,
  overSoftThreshold,
  scoreAccount,
  weeklyUrgency,
} from './score-core'

export interface Selection {
  account: PoolAccount
  /** true when every account was exhausted/cooling-down and we picked the least-bad one. */
  degraded: boolean
  /** true when the account came from this session's existing assignment (no switch). */
  sticky: boolean
}

function weeklyUtil(account: PoolAccount): number {
  return account.usage.weekly?.utilization ?? 0
}

/**
 * Pick the best account for a provider by weekly urgency.
 *
 * 1. Restrict to the provider's non-disabled accounts, minus `exclude` (already
 *    tried this request).
 * 2. Prefer the subset that is currently available (not exhausted / cooling down).
 * 3. Among those, pick the highest urgency score.
 * 4. If none are available, fall back to the least-bad account (lowest weekly
 *    utilization) and flag the selection as `degraded`.
 *
 * Returns null when the provider has no usable account left.
 */
export function selectAccount(
  accounts: PoolAccount[],
  providerID: string,
  now: number,
  cfg: SchedulerConfig = DEFAULT_CONFIG,
  exclude: ReadonlySet<string> = new Set(),
): Selection | null {
  const pool = accounts.filter(
    (a) =>
      a.providerID === providerID && !a.disabledReason && !exclude.has(a.id),
  )
  if (pool.length === 0) return null

  const available = pool.filter((a) => isAvailable(a, cfg, now))
  const degraded = available.length === 0
  const candidates = degraded ? pool : available

  let best: PoolAccount | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const account of candidates) {
    const score = degraded
      ? -weeklyUtil(account)
      : scoreAccount(account, cfg, now)
    if (score > bestScore) {
      bestScore = score
      best = account
    }
  }

  return best ? { account: best, degraded, sticky: false } : null
}

/** The account currently pinned to a session, if any (ignores availability). */
function findPinned(
  pool: PoolFile,
  providerID: string,
  sessionKey: string,
  exclude: ReadonlySet<string>,
): PoolAccount | null {
  const assigned = pool.sessions[sessionKey]
  if (!assigned || exclude.has(assigned.accountId)) return null
  return (
    pool.accounts.find(
      (a) => a.id === assigned.accountId && a.providerID === providerID,
    ) ?? null
  )
}

function withExcluded(
  exclude: ReadonlySet<string>,
  extra: string,
): Set<string> {
  const next = new Set(exclude)
  next.add(extra)
  return next
}

/**
 * A "cheap moment" to switch accounts: the outgoing request is small enough that
 * re-sending its context onto a fresh (uncached) account won't burn a big chunk of
 * that account's quota. cheapSwitchMaxBytes <= 0 disables the gate (always cheap).
 */
function isCheapMoment(requestBytes: number, cfg: SchedulerConfig): boolean {
  return cfg.cheapSwitchMaxBytes <= 0 || requestBytes <= cfg.cheapSwitchMaxBytes
}

/**
 * Session-aware selection. Balances prompt-cache stickiness against headroom safety
 * and quota perishability:
 *
 *  - No pin / pin excluded / pin unavailable (cooldown / disabled / hard-exhausted at
 *    `exhaustedAt`)  -> FORCED switch to the best urgency pick.
 *  - Pin healthy but a NON-forced switch is worthwhile AND it's a cheap moment
 *    (small `requestBytes`):
 *      (a) proactive: pin crossed the soft `migrateAt` (~95%) and another account has
 *          more headroom -> move before slamming into the 100% wall (subagent safety);
 *      (b) drain (opt-in `drainMigrate`): another account's weekly reset is imminent
 *          and its urgency dominates the pin's by `drainMigrateMargin` -> switch to
 *          drain that use-it-or-lose-it quota.
 *  - Otherwise keep the pin (sticky), preserving its prompt cache.
 *
 * Forced switches ignore the cost gate; proactive/drain switches honor it so a large
 * conversation isn't re-sent onto a fresh account all at once.
 */
export function selectForSession(
  pool: PoolFile,
  providerID: string,
  sessionKey: string | null,
  now: number,
  cfg: SchedulerConfig = DEFAULT_CONFIG,
  exclude: ReadonlySet<string> = new Set(),
  requestBytes = 0,
): Selection | null {
  const pinned = sessionKey
    ? findPinned(pool, providerID, sessionKey, exclude)
    : null
  if (!pinned)
    return selectAccount(pool.accounts, providerID, now, cfg, exclude)

  // Forced: the pinned account can no longer serve requests.
  if (!isAvailable(pinned, cfg, now)) {
    return selectAccount(pool.accounts, providerID, now, cfg, exclude)
  }

  // Consider a non-forced migration only when switching is cheap AND a
  // migration branch is actually reachable. The inner `proactive` check
  // requires `overSoftThreshold(pinned)` and the drain branch requires
  // `cfg.drainMigrate` — so when both are false (the steady-state default-
  // config "follow-up turn in a healthy session" path, by far the dominant
  // case), `alt` is computed and immediately discarded. Gating the
  // `selectAccount` call on the same predicates skips a full O(N) pool scan
  // (and a `scoreAccount`/`weeklyUrgency` call per candidate) on every such
  // request. Behavior is unchanged when either predicate is true.
  const migrationReachable =
    overSoftThreshold(pinned, cfg, now) || cfg.drainMigrate
  if (migrationReachable && isCheapMoment(requestBytes, cfg)) {
    const alt = selectAccount(
      pool.accounts,
      providerID,
      now,
      cfg,
      withExcluded(exclude, pinned.id),
    )
    // A `degraded` alt is selectAccount's "least-bad of the cooling-down /
    // exhausted set" — switching a still-healthy pin onto it just trades one
    // working account for one that is rate-limited right now (almost certain to
    // 429 again on the spot, extending its cooldown and burning a real request).
    // Non-forced migrations require a genuinely available alternative; the
    // forced-switch path above already handles the "pin itself is unavailable"
    // case (which is the only legitimate way to return a degraded selection).
    if (alt && !alt.degraded) {
      const proactive =
        overSoftThreshold(pinned, cfg, now) &&
        maxUtil(alt.account, now) < maxUtil(pinned, now)
      if (proactive) {
        return { account: alt.account, degraded: false, sticky: false }
      }
      // Drain branch is opt-in (`drainMigrate` defaults to false). Gating the
      // whole block on `cfg.drainMigrate` skips the `weeklyUrgency(alt)` /
      // `weeklyUrgency(pinned)` calls on every cheap-moment request in the
      // common default-config path, where their result is unused. Behavior is
      // unchanged when `drainMigrate=true`.
      if (cfg.drainMigrate) {
        // `altUrgency > 0` guard: when BOTH the pin AND the alt are past
        // `weeklyDrainTarget`, each `weeklyUrgency` collapses to 0 (its
        // `drainable = max(0, weeklyDrainTarget - util)` term zeroes out). Without
        // the guard, `0 >= 0 * margin` is true, firing a useless drain switch — no
        // perishable quota to chase, just a lost prompt cache on the pin. The
        // unchanged `>=` margin keeps behavior at non-zero urgencies byte-identical
        // (locked by the drainMigrate tests in scheduler.test.ts).
        const altUrgency = weeklyUrgency(alt.account, cfg, now)
        if (
          altUrgency > 0 &&
          altUrgency >= weeklyUrgency(pinned, cfg, now) * cfg.drainMigrateMargin
        ) {
          return { account: alt.account, degraded: false, sticky: false }
        }
      }
    }
  }

  return { account: pinned, degraded: false, sticky: true }
}
