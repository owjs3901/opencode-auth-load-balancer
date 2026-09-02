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
 * `representative-claim` values that name a TIER-scoped window (a per-model
 * weekly/5h cap OR the premium/overage bucket — e.g. `seven_day_opus`,
 * `seven_day_fable`, `seven_day_overage_included`) rather than a bare
 * account-wide one (`five_hour` / `seven_day`). Used ONLY as a GATE by
 * `planReactiveFallback`; the captured suffix is NOT the cooldown key. Anthropic
 * emits non-model-family suffixes (`overage_included`) that no request's model
 * family ever equals, so keying on the suffix records a dead
 * `modelCooldownsUntil` entry the proactive skip can never consult — the cooldown
 * is keyed by the REQUEST's model family instead (see `planReactiveFallback`).
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
export const CLAUDE_CODE_ENTRYPOINT = 'sdk-cli'

/**
 * Version used when nothing better is known — the floor the resolver in
 * `version.ts` never goes below.
 *
 * Anthropic GATES NEW MODELS ON THE CLIENT VERSION we report (in the
 * `claude-cli/<version>` UA and the `cc_version=` billing header): requesting a
 * too-new model with a too-old version is rejected outright with
 * `{"error_code":"claude_code_version_too_old"}` — e.g. `claude-fable-5-1`
 * requires ≥ 2.1.251. A hard-pinned constant therefore BREAKS on every future
 * model launch, which is why the live value is resolved from the npm registry
 * (`version.ts`) and this is only the offline floor.
 *
 * Verified against the real API: `claude-fable-5-1` returns 400
 * (`claude_code_version_too_old`) at `2.1.87` and 200 at this value, using the
 * SAME `CCH_SALT`/`CCH_POSITIONS` above — the fingerprint algorithm did not
 * change across that range, so bumping the version string alone is sufficient.
 * Keep this at a version confirmed to work; the resolver only ever moves UP
 * from here.
 */
export const FALLBACK_CLAUDE_CODE_VERSION = '2.1.258'

/**
 * Pin the reported Claude Code version explicitly, bypassing BOTH the npm
 * lookup and the `FALLBACK_CLAUDE_CODE_VERSION` floor — the escape hatch for
 * the two directions the resolver cannot guess: pinning FORWARD to a version
 * npm has not tagged `latest` yet, or pinning BACK (e.g. to reproduce this
 * `claude_code_version_too_old` failure, or if a future release changes the
 * `cch` fingerprint algorithm and the newest version starts 400ing).
 */
export const CLAUDE_CODE_VERSION_ENV =
  'OPENCODE_AUTH_LB_ANTHROPIC_CLAUDE_CODE_VERSION'

/**
 * npm dist-tags for the Claude Code CLI — `{"latest":"2.1.258",…}`, ~56 bytes.
 * Deliberately NOT `/@anthropic-ai/claude-code/latest`, which returns the whole
 * 3.3 KB version packument for the one field we read.
 */
export const CLAUDE_CODE_REGISTRY_URL =
  'https://registry.npmjs.org/-/package/@anthropic-ai%2Fclaude-code/dist-tags'

/**
 * How long a registry answer stays authoritative on disk. Claude Code ships
 * roughly daily, and a stale-by-a-day version only matters on the day a new
 * model launches — so a day-long TTL keeps startup network-free almost always
 * while still converging well inside the window that matters.
 */
export const CLAUDE_CODE_VERSION_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Bound the registry lookup. Shorter than the 30 s OAuth/usage budgets because
 * nothing waits on this: it runs fire-and-forget at startup and a miss simply
 * leaves the previous (cached or fallback) version in place.
 */
export const REGISTRY_HTTP_TIMEOUT_MS = 10_000

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
