import { loadScoreConfig, SCORE_DEFAULTS, type ScoreConfig } from './score-core'

/**
 * Tunable parameters for the account scheduler. All overridable via env vars. Extends
 * the scoring knobs (`ScoreConfig`, the single source shared with the TUI view) with the
 * session/migration parameters that only the server scheduler needs.
 */
export interface SchedulerConfig extends ScoreConfig {
  /** Session->account assignments older than this (ms) are pruned. */
  sessionTtlMs: number
  /**
   * Cost gate for NON-forced switches (proactive `migrateAt` and `drainMigrate`):
   * only switch when the outgoing request body is <= this many bytes, so a large
   * conversation isn't re-sent onto a fresh account (which has no prompt cache and
   * would burn a big chunk of its quota in one shot). <= 0 disables the gate, i.e.
   * always allow the switch. Forced switches (hard exhaustion) ignore this gate;
   * so does a PROACTIVE switch when the pin is within `IMMINENT_EXHAUSTION_BAND` of
   * hard exhaustion (see select.ts) — a forced, still-ungated switch is coming next
   * turn anyway and the re-sent conversation only grows, so moving now is cheaper.
   * Drain switches always stay byte-gated.
   */
  cheapSwitchMaxBytes: number
  /**
   * Allow migrating a still-healthy session to drain another account whose weekly
   * window is about to reset (use-it-or-lose-it). Off by default — when off, a
   * healthy session only ever leaves on the proactive/forced thresholds above.
   */
  drainMigrate: boolean
  /**
   * When drainMigrate is on, the candidate account's weekly urgency must exceed the
   * pinned account's by at least this factor to justify breaking session affinity.
   */
  drainMigrateMargin: number
  /**
   * Max wall-clock time (ms) a single request may BLOCK waiting for the pool to recover
   * when EVERY account is rate-limited (a 429/402 `account`-class cooldown). Rather than
   * failing the turn abruptly, the load-balanced fetch sleeps until the soonest account's
   * cooldown expires (honoring `Retry-After`) — bounded by this budget — then retries. A
   * client abort (opencode cancelling the turn) interrupts the wait immediately. Must
   * exceed `ACCOUNT_COOLDOWN_MS` (5 min) to cover a 429 that carries no `Retry-After`.
   * <= 0 disables waiting (fail fast, the old behavior).
   */
  maxWaitMs: number
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  ...SCORE_DEFAULTS,
  sessionTtlMs: 6 * 60 * 60 * 1000, // 6 hours
  cheapSwitchMaxBytes: 64 * 1024, // 64 KiB: gate ON — hold large-context proactive switches; small/early ones (and imminent-exhaustion switches, see select.ts) still pass
  drainMigrate: false,
  drainMigrateMargin: 1.5,
  maxWaitMs: 305_000, // 5 min + 5 s: outlast the ACCOUNT_COOLDOWN_MS fallback so a no-Retry-After 429 can still auto-recover before giving up
}

/** Read overrides from env (OPENCODE_AUTH_LB_*), falling back to defaults. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const num = (key: string, dflt: number): number => {
    const raw = env[key]
    if (raw === undefined || raw === '') return dflt
    const n = Number(raw)
    return Number.isFinite(n) ? n : dflt
  }
  const bool = (key: string, dflt: boolean): boolean => {
    const raw = env[key]?.trim().toLowerCase()
    if (raw === undefined || raw === '') return dflt
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
  }
  return {
    ...loadScoreConfig(env),
    sessionTtlMs: num(
      'OPENCODE_AUTH_LB_SESSION_TTL_MS',
      DEFAULT_CONFIG.sessionTtlMs,
    ),
    cheapSwitchMaxBytes: num(
      'OPENCODE_AUTH_LB_CHEAP_SWITCH_MAX_BYTES',
      DEFAULT_CONFIG.cheapSwitchMaxBytes,
    ),
    drainMigrate: bool(
      'OPENCODE_AUTH_LB_DRAIN_MIGRATE',
      DEFAULT_CONFIG.drainMigrate,
    ),
    drainMigrateMargin: num(
      'OPENCODE_AUTH_LB_DRAIN_MIGRATE_MARGIN',
      DEFAULT_CONFIG.drainMigrateMargin,
    ),
    maxWaitMs: num('OPENCODE_AUTH_LB_MAX_WAIT_MS', DEFAULT_CONFIG.maxWaitMs),
  }
}
