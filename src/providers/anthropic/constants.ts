export const PROVIDER_ID = 'anthropic'

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'

export const CODE_CALLBACK_URL =
  'https://platform.claude.com/oauth/code/callback'

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

// Shared HTTP timeout budgets (single-sourced; see src/providers/http-timeouts.ts).
export { OAUTH_HTTP_TIMEOUT_MS, USAGE_HTTP_TIMEOUT_MS } from '../http-timeouts'

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

/**
 * Default target when auto-downgrading an Opus request whose account has hit its
 * Opus-specific weekly cap (429 with `anthropic-ratelimit-unified-representative-
 * claim: seven_day_opus`). Overridable via
 * `OPENCODE_AUTH_LB_ANTHROPIC_OPUS_FALLBACK_MODEL`; set that env to an empty
 * string to DISABLE the downgrade (revert to cooling the whole account down).
 * The current first-party Sonnet default id.
 */
export const DEFAULT_OPUS_FALLBACK_MODEL = 'claude-sonnet-4-6'

/** 429 header naming which rate-limit window is the binding constraint. */
export const REPRESENTATIVE_CLAIM_HEADER =
  'anthropic-ratelimit-unified-representative-claim'

/** `representative-claim` value meaning the Opus-specific weekly cap is exhausted. */
export const SEVEN_DAY_OPUS_CLAIM = 'seven_day_opus'

/** 429 header with the unix-seconds reset time of the binding window. */
export const UNIFIED_RESET_HEADER = 'anthropic-ratelimit-unified-reset'

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
