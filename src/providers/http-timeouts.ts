/**
 * HTTP timeout budgets shared by BOTH provider adapters. These are not
 * provider-specific values that happen to coincide — the invariants they
 * encode (stay below the refresh lock's stale window; bound fire-and-forget
 * usage polls) apply identically to the Anthropic and OpenAI paths, so they
 * are single-sourced here (like `pkce.ts` / `oauth-callback.ts` /
 * `usage-http.ts`) and re-exported from each provider's `constants.ts`.
 */

/**
 * Bound every OAuth token-endpoint call (exchange/refresh) so a hung network never
 * holds the per-account refresh lock for its full stale window. Must stay below the
 * refresh lock's stale timeout (120s) so the lock is released by the abort first.
 */
export const OAUTH_HTTP_TIMEOUT_MS = 30_000

/**
 * Bound every usage-endpoint poll so a hung usage server never accumulates
 * fire-and-forget sockets. `fetchUsage` is called fire-and-forget from
 * `refreshUsageInBackground`; the `lastPoll` throttle prevents same-account
 * re-poll within SEED_TTL_MS but does NOT cancel an in-flight hung fetch.
 * Symmetric with `OAUTH_HTTP_TIMEOUT_MS` (30 s).
 */
export const USAGE_HTTP_TIMEOUT_MS = 30_000
