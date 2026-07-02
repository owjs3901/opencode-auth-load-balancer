export const PROVIDER_ID = 'anthropic'

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'

export const CODE_CALLBACK_URL =
  'https://platform.claude.com/oauth/code/callback'

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

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

/** Dedicated usage endpoint — returns 5h + 7d utilization without consuming quota. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

export const OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]

export const TOOL_PREFIX = 'mcp_'

export const REQUIRED_BETAS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
]

export const OPENCODE_IDENTITY_PREFIX = 'You are OpenCode'
export const CLAUDE_CODE_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export const CCH_SALT = '59cf53e54c78'
export const CCH_POSITIONS = [4, 7, 20]
export const CLAUDE_CODE_VERSION = '2.1.87'
export const CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'

/** User-Agent for /v1/messages (matches the reference plugin's validated value). */
export const USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`

/**
 * User-Agent for the /api/oauth/usage endpoint. This endpoint hard-rejects
 * (429) requests whose UA is not `claude-code/<version>`.
 */
export const USAGE_USER_AGENT = `claude-code/${CLAUDE_CODE_VERSION}`

export const PARAGRAPH_REMOVAL_ANCHORS = [
  'github.com/anomalyco/opencode',
  'opencode.ai/docs',
]

export const TEXT_REPLACEMENTS: { match: string; replacement: string }[] = [
  { match: 'if OpenCode honestly', replacement: 'if the assistant honestly' },
  {
    match:
      'Here is some useful information about the environment you are running in:',
    replacement: 'Environment context you are running in:',
  },
]
