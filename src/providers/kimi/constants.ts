// Shared HTTP timeout budget (single-sourced; see src/providers/http-timeouts.ts).
export { USAGE_HTTP_TIMEOUT_MS } from '../http-timeouts'

/**
 * One Kimi Code deployment. kimi.com and kimi.ai are separate hosts with
 * separate accounts, and opencode's models.dev catalog lists each as its own
 * provider — so each gets its own adapter, and its own pool.
 */
export interface KimiDeployment {
  /** opencode provider id (models.dev). */
  readonly id: string
  /** OpenAI-compatible API base (the catalog's `api`); `/usages` lives here too. */
  readonly baseUrl: string
  /** Console page where a subscriber creates the API key the login asks for. */
  readonly consoleUrl: string
}

export const KIMI_CODE: KimiDeployment = {
  id: 'kimi-code-plan-cn',
  baseUrl: 'https://api.kimi.com/coding/v1',
  consoleUrl: 'https://www.kimi.com/code/console',
}

export const KIMI_CODE_GLOBAL: KimiDeployment = {
  id: 'kimi-code-plan-global',
  baseUrl: 'https://api.kimi.ai/coding/v1',
  consoleUrl: 'https://www.kimi.ai/code/console',
}

/**
 * `expires` stamped on a static-key row: a key does not expire client-side,
 * so `needsRefresh` must never fire. Finite, so the pool store's
 * `Number.isFinite(expires)` normalization keeps it.
 */
export const STATIC_KEY_EXPIRES = Number.MAX_SAFE_INTEGER
