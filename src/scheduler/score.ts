/**
 * Account scoring — re-exported from the dependency-free `score-core` module, which is
 * the single source of truth shared verbatim with the standalone TUI view (see
 * `score-core.ts`). Server-side callers pass the full `PoolAccount` / `SchedulerConfig`,
 * which structurally satisfy the core's `ScoreAccount` / `ScoreConfig`.
 */
export {
  displayUtil,
  isAvailable,
  isExhausted,
  maxUtil,
  overSoftThreshold,
  scoreAccount,
  weeklyUrgency,
} from './score-core'
