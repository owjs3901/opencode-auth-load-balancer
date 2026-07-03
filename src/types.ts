/**
 * Provider-agnostic data model shared by the scheduler, pool store, and adapters.
 *
 * Both Anthropic and OpenAI usage is normalized into the same shape so a single
 * scheduler can rank accounts regardless of provider.
 */

/** A single rate-limit window. utilization in [0,1]; resetAt is epoch ms (0 = unknown). */
export interface UsageWindow {
  utilization: number
  resetAt: number
}

/** Normalized usage snapshot for one account. */
export interface UsageSnapshot {
  /** Short rolling window (~5h for both Anthropic and Codex). */
  hourly: UsageWindow | null
  /** Weekly (7-day rolling) window — the PRIMARY scheduling signal. */
  weekly: UsageWindow | null
  /**
   * epoch ms when the WEEKLY window was last captured (0 = never). Deliberately
   * weekly-scoped: this is the staleness gate for the usage-endpoint re-poll
   * (`refreshUsageInBackground`), and weekly is the primary signal that poll
   * backfills — a response that updates only hourly must not mark the
   * snapshot fresh, or an out-of-band weekly reset is never picked up.
   */
  capturedAt: number
}

export function emptyUsage(): UsageSnapshot {
  return { hourly: null, weekly: null, capturedAt: 0 }
}

/** Result of an OAuth authorization-code exchange or refresh. */
export interface TokenSet {
  access: string
  refresh: string
  /** epoch ms expiry of the access token. */
  expires: number
  /** Provider account id (e.g. chatgpt-account-id), when present. */
  accountId?: string
}

/** One pooled credential. */
export interface PoolAccount {
  /** Stable internal id (uuid). */
  id: string
  /** opencode provider id, e.g. "anthropic" | "openai". */
  providerID: string
  /** User-facing label (email / nickname). Editable in the pool file. */
  label: string
  access: string
  refresh: string
  /** Access-token expiry, epoch ms. */
  expires: number
  /**
   * Monotonic token-rotation generation. Bumped on every successful refresh so a
   * cross-process refresher that lost the single-use-token race can tell its token
   * was superseded — and adopt the winner's token instead of permanently disabling
   * a now-valid account. Absent on legacy pool files (read as 0).
   */
  tokenGen?: number
  /** Provider account id (e.g. chatgpt-account-id), or null. */
  accountId: string | null
  usage: UsageSnapshot
  /** epoch ms; the account is skipped until this time. 0 = no cooldown. */
  cooldownUntil: number
  /**
   * Per MODEL-TIER cooldowns: tier name (e.g. "opus", "fable") → epoch ms until
   * that tier's separate weekly cap resets. While an entry is `> now`, requests
   * for that tier's models avoid this account (another account with tier
   * headroom is preferred) and — when the WHOLE pool is tier-limited — are
   * auto-downgraded to the fallback model (see
   * `OPENCODE_AUTH_LB_ANTHROPIC_OPUS_FALLBACK_MODEL`) instead of cooling the
   * account down: the account still serves every other model. Distinct from
   * `cooldownUntil` (account-wide) and NOT a scheduling signal: scoring /
   * `isAvailable` ignore it, so it never sidelines the account. Absent = no
   * tier is known-exhausted. Anthropic-only; absent for OpenAI accounts.
   */
  modelCooldownsUntil?: Record<string, number>
  /**
   * LEGACY (pre-tier-map) Opus-only cooldown. Folded into
   * `modelCooldownsUntil.opus` and deleted by the pool-store normalizer on
   * every read; never written anymore. Kept in the type so old pool files
   * parse without a cast.
   */
  opusCooldownUntil?: number
  /** Non-null when the account needs manual re-login (e.g. revoked refresh token). */
  disabledReason: string | null
}

/** A conversation's sticky account assignment (preserves prompt cache across turns). */
export interface SessionAssignment {
  accountId: string
  updatedAt: number
}

export interface PoolFile {
  version: 1
  accounts: PoolAccount[]
  /**
   * providerID -> account that most recently served a request. Drives the ▶
   * "in use" marker in the status tool/CLI and the TUI bottom bar/sidebar;
   * written on every fetch success and by `primeInUse` at startup. Never read
   * by scheduling.
   */
  lastSelected: Record<string, string>
  /** sessionKey -> assignment. Keeps a conversation pinned to one account. */
  sessions: Record<string, SessionAssignment>
}
