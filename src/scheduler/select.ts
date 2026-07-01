import type { PoolAccount, PoolFile } from '../types'
import { DEFAULT_CONFIG, type SchedulerConfig } from './config'
import {
  isAvailable,
  maxUtil,
  overSoftThreshold,
  scoreAccount,
  weeklyUrgency,
} from './score-core'

/**
 * Within this fraction of hard exhaustion (`exhaustedAt`) the pinned account is about to
 * force a switch anyway — and a forced switch IGNORES the cost gate. So a PROACTIVE
 * migration in this band bypasses the byte gate too: opencode re-sends the whole (only-
 * growing) conversation every turn, so switching NOW is cheaper than the forced switch
 * NEXT turn. Drain migration stays byte-gated (it is opportunistic, never imminent).
 */
const IMMINENT_EXHAUSTION_BAND = 0.01
/**
 * Below the imminent band, a proactive migration requires the alternative to have at
 * least this much more headroom (absolute `maxUtil` delta). Without a margin, two
 * accounts hovering near the soft threshold ping-pong A->B->A across turns, each switch
 * paying a full per-account prompt-cache write.
 */
const PROACTIVE_MIGRATE_MIN_DELTA = 0.02

export interface Selection {
  account: PoolAccount
  /** true when every account was exhausted/cooling-down and we picked the least-bad one. */
  degraded: boolean
  /** true when the account came from this session's existing assignment (no switch). */
  sticky: boolean
}

// Raw stored weekly utilization, NOT `utilOf`/`displayUtil` — the degraded
// fallback ranks already-unavailable accounts by least-bad weekly use, and must
// stay distinguishable even when a window just rolled over. This is the
// reciprocal of the same raw expression in `src/status.ts`'s ranked-fallback
// tie-breaker (see its comment at the `weeklyUtil:` field): the two are
// deliberately NOT shared — score-core stays byte-synced with the TUI copy and
// status.ts can't be imported into this hot path — so keep both inlined.
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

  // `degraded` is loop-invariant (fixed above before the loop), so pick the scoring
  // function ONCE rather than re-branching the ternary per candidate on this
  // per-request hot path. The degraded fallback ranks by least weekly
  // utilization; the normal path uses the full urgency scorer.
  const scoreOf = degraded
    ? (account: PoolAccount) => -weeklyUtil(account)
    : (account: PoolAccount) => scoreAccount(account, cfg, now)

  let best: PoolAccount | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const account of candidates) {
    const score = scoreOf(account)
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
  // Account ids are globally unique uuids, so `a.id === assigned.accountId`
  // already pins a single account; the `&& a.providerID === providerID`
  // conjunct is a deliberate guard against a stale CROSS-PROVIDER pin (e.g. an
  // older session-key scheme) — keep it, it is not redundant.
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

  // Non-forced migration. The forced-switch path above already handled "the pin
  // can't serve"; here the pin is still usable, so any switch is OPTIONAL and must
  // earn its cost — re-sending the whole conversation onto a fresh (uncached)
  // account is a full per-account prompt-cache WRITE (~1.25x, no read discount).
  // Two-stage gate keeps the steady-state healthy follow-up turn (the dominant path)
  // free: skip the O(N) `selectAccount` scan AND the cost/imminence math whenever the
  // pin is below its soft threshold and drainMigrate is off. `overSoftThreshold` is
  // computed once (it re-reads usage.{weekly,hourly} + re-runs utilOf), so the extra
  // `maxUtil(pinned)` below is only paid on the migration-reachable path.
  const pinnedOverSoft = overSoftThreshold(pinned, cfg, now)
  if (pinnedOverSoft || cfg.drainMigrate) {
    const pinnedUtil = maxUtil(pinned, now)
    const cheap = isCheapMoment(requestBytes, cfg)
    if (
      // Within `IMMINENT_EXHAUSTION_BAND` of hard exhaustion, a forced (cost-gate-
      // ignoring) switch is coming next turn anyway; migrating now is cheaper because
      // the re-sent conversation only grows. So a PROACTIVE move bypasses the byte gate
      // here — drain never does (it is opportunistic, not imminent). Imminence is only
      // consulted on the `pinnedOverSoft` side, so it is computed there (and reused
      // inside the block below), never on the drain-only path.
      (pinnedOverSoft &&
        (cheap || pinnedUtil >= cfg.exhaustedAt - IMMINENT_EXHAUSTION_BAND)) ||
      (cfg.drainMigrate && cheap)
    ) {
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
        if (pinnedOverSoft) {
          // Imminent: any genuinely-more-headroom account is worth it (the forced
          // switch is coming regardless). Otherwise: require a real headroom margin
          // so two near-threshold accounts don't ping-pong A->B->A, each switch
          // paying a full prompt-cache write.
          const pinnedImminent =
            pinnedUtil >= cfg.exhaustedAt - IMMINENT_EXHAUSTION_BAND
          const altUtil = maxUtil(alt.account, now)
          const proactiveBetter = pinnedImminent
            ? altUtil < pinnedUtil
            : pinnedUtil - altUtil >= PROACTIVE_MIGRATE_MIN_DELTA
          if (proactiveBetter) {
            return { account: alt.account, degraded: false, sticky: false }
          }
        }
        // Drain branch is opt-in (`drainMigrate` defaults to false) and stays byte-
        // gated (`cheap`): unlike proactive it is never imminent, so it must never
        // bypass the cost gate. Gating on `cfg.drainMigrate` also skips the
        // `weeklyUrgency` calls on the common proactive path.
        if (cfg.drainMigrate && cheap) {
          // `altUrgency > 0` guard: when BOTH the pin AND the alt are past
          // `weeklyDrainTarget`, each `weeklyUrgency` collapses to 0 (its
          // `drainable = max(0, weeklyDrainTarget - util)` term zeroes out). Without
          // the guard, `0 >= 0 * margin` is true, firing a useless drain switch — no
          // perishable quota to chase, just a lost prompt cache on the pin.
          const altUrgency = weeklyUrgency(alt.account, cfg, now)
          if (
            altUrgency > 0 &&
            altUrgency >=
              weeklyUrgency(pinned, cfg, now) * cfg.drainMigrateMargin
          ) {
            return { account: alt.account, degraded: false, sticky: false }
          }
        }
      }
    }
  }

  return { account: pinned, degraded: false, sticky: true }
}
