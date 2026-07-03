import { arch, platform, release } from 'node:os'

export const PROVIDER_ID = 'openai'

export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

export const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const REDIRECT_URI = 'http://localhost:1455/auth/callback'

// Shared HTTP timeout budgets (single-sourced; see src/providers/http-timeouts.ts).
export { OAUTH_HTTP_TIMEOUT_MS, USAGE_HTTP_TIMEOUT_MS } from '../http-timeouts'

export const OAUTH_SCOPES = ['openid', 'profile', 'email', 'offline_access']

/** ChatGPT-OAuth Codex inference endpoint. */
export const CODEX_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses'

/** Dedicated usage endpoint for ChatGPT OAuth (no inference required). */
export const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** User-Agent for the usage endpoint — the Codex CLI sends `codex-cli`. */
export const USAGE_USER_AGENT = 'codex-cli'

export const ORIGINATOR = 'opencode'
export const OPENAI_BETA = 'responses=experimental'

export const USER_AGENT = `opencode/0.2.0 (${platform()} ${release()}; ${arch()})`

/** Stable per-process session id sent as the `session-id` header. */
export const SESSION_ID = crypto.randomUUID()
