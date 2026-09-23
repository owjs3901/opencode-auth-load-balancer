// Shared HTTP timeout budgets (single-sourced; see src/providers/http-timeouts.ts).
export { OAUTH_HTTP_TIMEOUT_MS, USAGE_HTTP_TIMEOUT_MS } from '../http-timeouts'

/**
 * One Kimi Code deployment. kimi.com and kimi.ai are separate hosts with
 * separate accounts, and opencode's models.dev catalog lists each as its own
 * provider — so each gets its own adapter, and its own pool.
 */
export interface KimiDeployment {
  /** opencode provider id (models.dev). */
  readonly id: string
  /** OpenAI-compatible API base (the catalog's `api`); `/usages` and `/me` live here too. */
  readonly baseUrl: string
  /** OAuth host for the device-code login and token refresh. */
  readonly oauthHost: string
  /** Console page where a subscriber creates the API key the key login asks for. */
  readonly consoleUrl: string
}

export const KIMI_CODE: KimiDeployment = {
  id: 'kimi-code-plan-cn',
  baseUrl: 'https://api.kimi.com/coding/v1',
  oauthHost: 'https://auth.kimi.com',
  consoleUrl: 'https://www.kimi.com/code/console',
}

export const KIMI_CODE_GLOBAL: KimiDeployment = {
  id: 'kimi-code-plan-global',
  baseUrl: 'https://api.kimi.ai/coding/v1',
  oauthHost: 'https://auth.kimi.ai',
  consoleUrl: 'https://www.kimi.ai/code/console',
}

/** Kimi Code's public OAuth client, shared by both deployments (no secret). */
export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098'

/**
 * `X-Msh-Platform` / `X-Msh-Version` sent to the OAuth host. Kimi's SDK asks
 * every host to name itself rather than borrow its CLI's `kimi_code_cli`, so
 * this names the plugin; the version is this integration's, bumped when its
 * handling of the login protocol changes.
 */
export const KIMI_DEVICE_PLATFORM = 'opencode_auth_load_balancer'
export const KIMI_DEVICE_VERSION = '1'

/** Local wall-clock budget for one device-code login (Kimi's own clients use 15 min). */
export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * `expires` stamped on a static-key row: a key does not expire client-side,
 * so `needsRefresh` must never fire. Finite, so the pool store's
 * `Number.isFinite(expires)` normalization keeps it.
 */
export const STATIC_KEY_EXPIRES = Number.MAX_SAFE_INTEGER
