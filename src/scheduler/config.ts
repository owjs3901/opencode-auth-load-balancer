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
   * always allow the switch. Forced switches (hard exhaustion) ignore this gate.
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
}

export const DEFAULT_CONFIG: SchedulerConfig = {
  ...SCORE_DEFAULTS,
  sessionTtlMs: 6 * 60 * 60 * 1000, // 6 hours
  cheapSwitchMaxBytes: 0, // gate disabled by default -> migrate at migrateAt regardless of size
  drainMigrate: false,
  drainMigrateMargin: 1.5,
}

/** Read overrides from env (OPENCODE_AUTH_LB_*), falling back to defaults. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): SchedulerConfig {
  const num = (key: string, dflt: number): number => {
    const raw = env[key]
    if (raw === undefined) return dflt
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
  }
}
