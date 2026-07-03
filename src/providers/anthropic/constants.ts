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
 * LAST-RESORT downgrade target when a MODEL-TIER weekly cap is exhausted and
 * the fallback LADDER cannot produce a candidate (the provider's model catalog
 * is empty or has no model in a lower family). The normal path walks
 * `DEFAULT_FAMILY_ORDER` through the catalog instead — see
 * `ladderTargetForFamily`/`downgradeModel` in fallback.ts. Also the historic
 * name of the override env (`OPENCODE_AUTH_LB_ANTHROPIC_OPUS_FALLBACK_MODEL`):
 * set it to a model id to PIN the downgrade target (bypassing the ladder), or
 * to an empty string to DISABLE downgrading (revert to cooling the whole
 * account down).
 */
export const DEFAULT_OPUS_FALLBACK_MODEL = 'claude-sonnet-4-6'

/**
 * Model FAMILIES best → worst: the fallback ladder for a tier-capped request
 * walks this order strictly BELOW the limited model's family and picks the
 * highest-versioned catalog model of the first family that has one (e.g. a
 * capped `claude-fable-5` prefers `claude-opus-4-9` over `claude-opus-4-8`;
 * if the whole Opus tier is capped too, the next pass lands on Sonnet). A
 * family NOT in this list (a future top tier) is treated as ABOVE the first
 * entry — new premium tiers historically appear at the top. Overridable via
 * `OPENCODE_AUTH_LB_ANTHROPIC_FAMILY_ORDER` (comma-separated, best first) so
 * future models need a config tweak, not a code change.
 */
export const DEFAULT_FAMILY_ORDER: readonly string[] = [
  'fable',
  'opus',
  'sonnet',
  'haiku',
]

/** 429 header naming which rate-limit window is the binding constraint. */
export const REPRESENTATIVE_CLAIM_HEADER =
  'anthropic-ratelimit-unified-representative-claim'

/**
 * `representative-claim` values that name a MODEL-TIER window (a per-model
 * weekly/5h cap, e.g. `seven_day_opus`, `seven_day_fable`) rather than an
 * account-wide one (bare `five_hour` / `seven_day`). The capture group is the
 * tier name — the key of `PoolAccount.modelCooldownsUntil`.
 */
export const MODEL_TIER_CLAIM_RE = /^(?:seven_day|five_hour)_(.+)$/

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
