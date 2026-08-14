import type { PoolAccount, PoolFile } from '../types'
import { DEFAULT_CONFIG, type SchedulerConfig } from './config'
import {
  isAvailable,
  maxUtil,
  scoreAccount,
  utilOf,
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
/**
 * Incumbent hysteresis for `selectAccount`: keep the provider's current in-use
 * account (`lastSelected`) instead of switching to a marginally-higher-scoring
 * one, as long as its score stays within this RELATIVE band of the best
 * available (`incumbentScore >= best * (1 - H)`). When several accounts' weekly-
 * urgency scores are near-equal — the common steady state, since weekly resets
 * are days apart — strict argmax flips on every tiny per-request usage update,
 * scattering unpinned/new/forced-repick traffic across accounts and burning a
 * full prompt-cache write each time. A RELATIVE band (not an absolute score
 * delta) because `scoreAccount` ranges from ~0.015 in calm periods to several
 * units near a reset, so an absolute delta would either never fire now or
 * over-stick later. Only the sessionless / forced-repick callers pass an
 * incumbent; proactive & drain MIGRATION pass null so this never fights their
 * intent (they have their own `PROACTIVE_MIGRATE_MIN_DELTA` / drain-margin).
 */
const INCUMBENT_HYSTERESIS = 0.2

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
 * Shared "no exclusions" default for `selectAccount` / `selectForSession` —
 * a defaulted `new Set()` would re-allocate on every defaulted call. The
 * `ReadonlySet` type statically prevents mutating the shared instance.
 */
const NO_EXCLUSIONS: ReadonlySet<string> = new Set()

/**
 * Pick the best account for a provider by weekly urgency.
 *
 * 1. Restrict to the provider's non-disabled accounts, minus `exclude` (already
 *    tried this request).
 * 2. Prefer the subset that is currently available (not exhausted / cooling down).
 * 3. Among those, pick the highest urgency score — but KEEP the incumbent
 *    (`incumbentId`, the provider's current in-use account) when its score is
 *    within `INCUMBENT_HYSTERESIS` of the best, so near-equal scores don't churn
 *    the account and waste prompt cache.
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
  exclude: ReadonlySet<string> = NO_EXCLUSIONS,
  // The provider's current in-use account (`pool.lastSelected[providerID]`),
  // passed by the sessionless / forced-repick callers so a near-equal challenger
  // does not needlessly displace it (see `INCUMBENT_HYSTERESIS`). Proactive &
  // drain migration pass null to opt OUT — they WANT to move off the incumbent.
  incumbentId: string | null = null,
): Selection | null {
  // Single pass over `accounts` on this per-request hot path — no intermediate
  // filtered arrays, no per-call scoring closure. Both bests use a strict
  // comparison so ties keep the FIRST candidate (matching the old arg-max
  // loop's first-wins order); the fallback minimizes raw `weeklyUtil`, which is
  // the old `-weeklyUtil` maximization written directly.
  let bestAvail: PoolAccount | null = null
  let bestAvailScore = Number.NEGATIVE_INFINITY
  let bestFallback: PoolAccount | null = null
  let lowestWeeklyUtil = Number.POSITIVE_INFINITY
  // The incumbent's account + score, recorded only if it survives the SAME
  // filters as any other candidate (provider match, not disabled, not excluded,
  // available) — so a disabled/cooling/excluded incumbent is ignored and
  // selection falls through to the argmax below.
  let incumbentAccount: PoolAccount | null = null
  let incumbentScore = Number.NEGATIVE_INFINITY
  for (const account of accounts) {
    if (
      account.providerID !== providerID ||
      account.disabledReason ||
      exclude.has(account.id)
    )
      continue
    if (isAvailable(account, cfg, now)) {
      const score = scoreAccount(account, cfg, now)
      if (score > bestAvailScore) {
        bestAvailScore = score
        bestAvail = account
      }
      if (account.id === incumbentId) {
        incumbentAccount = account
        incumbentScore = score
      }
    } else {
      const util = weeklyUtil(account)
      if (util < lowestWeeklyUtil) {
        lowestWeeklyUtil = util
        bestFallback = account
      }
    }
  }

  // `bestAvail` is non-null IFF at least one account was AVAILABLE — the first
  // available account always sets it (its finite score beats the -Infinity
  // seed) — so it doubles as the old `sawAvailable` / `available.length > 0`
  // gate: a non-null `bestAvail` means "someone was available", and the
  // `degraded` fallback below runs only when NONE was. The degraded fallback
  // ranks the unavailable set by least-bad weekly use.
  if (bestAvail) {
    // Incumbent hysteresis: keep the current in-use account when its score is
    // within the relative band of the best. `scoreAccount` is provably >= 0
    // (weeklyUrgency >= 0 times a factor in [0,1]), so no special case is needed
    // when the best score is 0 (every available account past weeklyDrainTarget):
    // the band collapses to `incumbentScore >= 0`, which keeps the incumbent —
    // exactly right when the urgency signal has gone flat. Only a MEANINGFULLY
    // better challenger (beyond the band) displaces it.
    if (
      incumbentAccount &&
      incumbentScore >= bestAvailScore * (1 - INCUMBENT_HYSTERESIS)
    )
      return { account: incumbentAccount, degraded: false, sticky: false }
    return { account: bestAvail, degraded: false, sticky: false }
  }
  return bestFallback
    ? { account: bestFallback, degraded: true, sticky: false }
    : null
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
  // Closure-free single-pass loop (not `.find`) — this is the dominant
  // steady-state path of `selectForSession`, which runs on every request;
  // `selectAccount` above made the same conversion for the same reason.
  for (const a of pool.accounts) {
    if (a.id === assigned.accountId && a.providerID === providerID) return a
  }
  return null
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
  exclude: ReadonlySet<string> = NO_EXCLUSIONS,
  requestBytes: number | (() => number) = 0,
): Selection | null {
  const pinned = sessionKey
    ? findPinned(pool, providerID, sessionKey, exclude)
    : null
  if (!pinned)
    return selectAccount(
      pool.accounts,
      providerID,
      now,
      cfg,
      exclude,
      pool.lastSelected[providerID] ?? null,
    )

  // Forced: the pinned account can no longer serve requests. Pass the current
  // in-use account as the incumbent so a forced repick still honors hysteresis
  // (a near-equal challenger won't churn the global in-use account). If
  // lastSelected IS this now-unavailable pin, it simply won't match an
  // available candidate and selection falls through to the argmax.
  if (!isAvailable(pinned, cfg, now))
    return selectAccount(
      pool.accounts,
      providerID,
      now,
      cfg,
      exclude,
      pool.lastSelected[providerID] ?? null,
    )

  // Non-forced migration. The forced-switch path above already handled "the pin
  // can't serve"; here the pin is still usable, so any switch is OPTIONAL and must
  // earn its cost — re-sending the whole conversation onto a fresh (uncached)
  // account is a full per-account prompt-cache WRITE (~1.25x, no read discount).
  // Two-stage gate keeps the steady-state healthy follow-up turn (the dominant path)
  // free: skip the O(N) `selectAccount` scan AND the cost/imminence math whenever the
  // pin is below its soft threshold and drainMigrate is off. Both windows' `utilOf`
  // are read ONCE here and reused for both `pinnedOverSoft` (the soft-threshold OR:
  // weekly >= weeklyDrainTarget || hourly >= migrateAt) and `pinnedUtil` (inlining
  // `maxUtil`'s max) below — the same "hoist repeated window reads" pattern
  // score-core.ts already applies on this hot path — instead of a dedicated helper
  // and a second `maxUtil(pinned)` call each re-running `utilOf` on both windows
  // independently.
  const weeklyUtilPinned = utilOf(pinned.usage.weekly, now)
  const hourlyUtilPinned = utilOf(pinned.usage.hourly, now)
  const pinnedOverSoft =
    weeklyUtilPinned >= cfg.weeklyDrainTarget ||
    hourlyUtilPinned >= cfg.migrateAt
  if (pinnedOverSoft || cfg.drainMigrate) {
    // `pinnedUtil` is read ONLY under `pinnedOverSoft` (in `pinnedImminent`, whose
    // own definition short-circuits on `pinnedOverSoft`, and lines gated by
    // `if (pinnedOverSoft)`). On the drain-only path (`!pinnedOverSoft &&
    // drainMigrate`) it is never observed, so skip the max work there.
    const pinnedUtil = pinnedOverSoft
      ? Math.max(hourlyUtilPinned, weeklyUtilPinned)
      : 0
    // Imminence is only meaningful on the `pinnedOverSoft` side, so fold
    // `pinnedOverSoft &&` into the definition: on the drain-only path
    // (`!pinnedOverSoft && drainMigrate`) `pinnedImminent` is then plainly false
    // and every read below collapses accordingly. The gate's left operand already
    // short-circuits on `pinnedOverSoft`, so this is behavior-neutral.
    const pinnedImminent =
      pinnedOverSoft && pinnedUtil >= cfg.exhaustedAt - IMMINENT_EXHAUSTION_BAND
    // Resolve the byte size HERE, at its single read site: callers on the hot
    // path (fetch.ts) pass a memoized thunk so the full-body UTF-8 walk is paid
    // only when this migration-reachable branch actually consults the gate —
    // never on the dominant sticky path, which returns before this block.
    // `cheap` is only ever OBSERVED when the pin is not imminent (imminence
    // bypasses the byte gate below) or when drainMigrate is on — so skip the
    // full-body walk entirely in the one case its result can never be read
    // (`pinnedImminent && !drainMigrate`, exactly where bodies are largest).
    const cheap =
      (!pinnedImminent || cfg.drainMigrate) &&
      isCheapMoment(
        typeof requestBytes === 'function' ? requestBytes() : requestBytes,
        cfg,
      )
    if (
      // Within `IMMINENT_EXHAUSTION_BAND` of hard exhaustion, a forced (cost-gate-
      // ignoring) switch is coming next turn anyway; migrating now is cheaper because
      // the re-sent conversation only grows. So a PROACTIVE move bypasses the byte gate
      // here — drain never does (it is opportunistic, not imminent).
      (pinnedOverSoft && (pinnedImminent || cheap)) ||
      (cfg.drainMigrate && cheap)
    ) {
      const alt = selectAccount(
        pool.accounts,
        providerID,
        now,
        cfg,
        withExcluded(exclude, pinned.id),
        // No incumbent: a proactive/drain MIGRATION deliberately moves OFF the
        // pin, so it must not be pulled back by incumbent hysteresis — it has
        // its own PROACTIVE_MIGRATE_MIN_DELTA / drain-margin gates below.
        null,
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
          const altUtil = maxUtil(alt.account, now)
          // The NON-imminent proactive switch is a headroom OPTIMIZATION, not a
          // safety requirement, so it must not override the scheduler's core
          // weekly-drain priority: only shed a pin that crossed its 5h soft
          // threshold onto an account at least as weekly-PERISHABLE. A pin whose
          // weekly quota resets sooner (higher weeklyUrgency) keeps draining
          // until it reaches the IMMINENT band (the ternary's `pinnedImminent`
          // arm), which ignores this gate and switches for hard-limit safety.
          // Without the gate, a pin whose weekly resets in HOURS (mostly unused)
          // bled its pinned sessions to one resetting days out the instant its
          // short 5h window crossed migrateAt — wasting the very quota the pool
          // exists to drain first. Compared via weeklyUrgency (pure
          // perishability), NOT scoreAccount, whose 5h de-rate is exactly the
          // signal that mis-fires here.
          const proactiveBetter = pinnedImminent
            ? altUtil < pinnedUtil
            : pinnedUtil - altUtil >= PROACTIVE_MIGRATE_MIN_DELTA &&
              weeklyUrgency(alt.account, cfg, now) >=
                weeklyUrgency(pinned, cfg, now)
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
