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
  /** Organization the credential acts for (Anthropic), when known: see `PoolAccount.orgId`. */
  orgId?: string
  /**
   * A long-lived bearer that only serves inference (Claude's `claude
   * setup-token`). It joins a row as its `inferenceToken` instead of
   * replacing the row's OAuth login.
   */
  inferenceOnly?: boolean
  /** epoch ms the OAuth login itself expires: see `PoolAccount.refreshExpires`. */
  refreshExpires?: number
  /**
   * Usage measured while logging in (a setup-token's validation probe, an
   * OAuth login's first poll). It seeds the row, and its weekly reset anchor
   * tells pairing which row the login belongs to.
   */
  usage?: UsageSnapshot
}

/** When and why a login stopped working. */
export interface LostLogin {
  at: number
  reason: string
}

/**
 * The logins of a row the provider refused for good: `oauth` when its
 * refresh was refused (invalid_grant), `token` when its static credential (a
 * setup-token or API key) answered 401.
 */
export interface LostLogins {
  oauth?: LostLogin
  token?: LostLogin
}

/**
 * `expires` stamped on a static credential (a Kimi API key, a Claude
 * setup-token): it has no refresh token behind it, so `needsRefresh` must
 * never fire — one that stops working answers 401 instead. Finite, so the
 * pool store's `Number.isFinite(expires)` normalization keeps it.
 */
export const STATIC_CREDENTIAL_EXPIRES = Number.MAX_SAFE_INTEGER

/** One pooled credential. */
export type CooldownKind = 'quota' | 'auth' | 'transient'

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
  /**
   * A long-lived inference-only bearer (Claude's `claude setup-token`). When
   * set it serves every request, and the row's OAuth login (`access` +
   * `refresh`), if any, only polls usage — so an OAuth logout no longer stops
   * inference. On a row without an OAuth login, `access` mirrors it with
   * `refresh: ''` and a never-due expiry, like any static credential.
   */
  inferenceToken?: string
  /**
   * epoch ms `inferenceToken` lapses, known only for a token the plugin
   * minted from the row's OAuth login (`src/token-mint.ts`), which renews it
   * ahead of time. A pasted token's lifetime is unknown, so it has none.
   */
  inferenceExpires?: number
  /**
   * Logins of this row the provider refused for good, each kept with when
   * and why until that login is replaced. While the row's other login still
   * works the row keeps serving on it, and the lost one shows as `oauth
   * re-login` / `token re-login` — distinct from a whole-row `re-login`,
   * which is what remains when nothing works.
   */
  lostLogins?: LostLogins
  /**
   * epoch ms the row's OAuth login itself expires — its refresh token, from
   * `refresh_token_expires_in` or else Claude Code's own 30-day assumption at
   * login. Refreshes do not extend it, so the dashboards warn in its last
   * days, as Claude Code does.
   */
  refreshExpires?: number
  /**
   * Organization the row's credentials act for (Anthropic), when known. A
   * setup-token carries no account identity — only the organization its
   * responses report — so this is the key that pairs it with its account's
   * OAuth login on one row.
   */
  orgId?: string
  usage: UsageSnapshot
  /** epoch ms; the account is skipped until this time. 0 = no cooldown. */
  cooldownUntil: number
  /** Why the active account-wide cooldown was written. Absent on legacy rows. */
  cooldownKind?: CooldownKind
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
  /**
   * Non-null when the scheduler skips this account. Two sources, both gated by
   * `isAvailable`: the automatic `invalid_grant: re-login required (…)` reason
   * written on a revoked refresh token (`src/refresh.ts`), and the manual
   * `MANUAL_DISABLED_REASON` sentinel written by the disable action (TUI menu /
   * `auth_lb_disable` tool). The dashboards distinguish the two to render
   * `disabled` (a user turned it off) vs `re-login` (needs a fresh OAuth login),
   * and the usage poll skips only `re-login` — a disabled account's usage stays
   * current.
   */
  disabledReason: string | null
}

/**
 * Sentinel `disabledReason` written by the MANUAL disable action (the TUI
 * sidebar menu and the `auth_lb_disable` tool), distinct from the automatic
 * `invalid_grant: re-login required (…)` reason `src/refresh.ts` writes when a
 * refresh token is revoked. Both are non-null so `isAvailable` skips the
 * account; the value is kept distinct so the dashboards can render `disabled`
 * (a user turned it off) rather than `re-login` (needs a fresh login), and so
 * the usage poll keeps refreshing a disabled account (its credential still
 * works) without a successful token rotation ever re-enabling it.
 */
export const MANUAL_DISABLED_REASON = 'manually disabled'

/**
 * Re-login intents expire after ten minutes. A bounded lifetime prevents an
 * abandoned TUI OAuth flow from redirecting a later, unrelated provider login
 * onto the account row that happened to be clicked earlier.
 */
export const RELOGIN_TTL_MS = 600_000

export interface ReloginIntent {
  /** `PoolAccount.id` the freshly exchanged tokens must land on. */
  accountId: string
  /** Provider the re-login was started for; an intent for another provider is ignored. */
  providerID: string
  /** epoch ms after which the intent is stale and dropped at the read boundary. */
  expiresAt: number
}

/** A conversation's sticky account assignment (preserves prompt cache across turns). */
export interface SessionAssignment {
  accountId: string
  updatedAt: number
  /**
   * Set when THIS session's most recent successful request was served on an
   * auto-downgraded fallback model (the requested model tier's weekly cap is
   * exhausted pool-wide, so the request descended the fallback ladder). Read by
   * the TUI bottom bar to PERSISTENTLY surface the degrade — the `onModelFallback`
   * toast is transient and gone by the next turn, yet the session keeps running
   * on the fallback model. `from`/`to` are the raw model ids (original requested
   * model → served model), matching the toast wording. The whole session row is
   * overwritten on every success, so the next request served on the requested
   * model naturally clears this back to `undefined`.
   */
  fallback?: { from: string; to: string }
}

export interface PoolFile {
  version: 1
  accounts: PoolAccount[]
  /**
   * Short-lived TUI → server handshake consumed by the first `addAccount` for
   * this provider. It identifies the clicked pool row when a provider rotates
   * refresh tokens and exposes no stable account id (Anthropic); without it a
   * completed re-login appends a duplicate while leaving the revoked row
   * behind. Absent in the steady state so `JSON.stringify` keeps the pool file
   * compact.
   */
  relogin?: ReloginIntent
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
