import { memoOne, secondsToMs } from '../../util'
import { MAX_QUOTA_RESET_BOUND_MS } from '../http-timeouts'
import type { ModelFallback, ReactiveModelFallback } from '../types'
import {
  DEFAULT_FAMILY_ORDER,
  DEFAULT_OPUS_FALLBACK_MODEL,
  MODEL_TIER_CLAIM_RE,
  REPRESENTATIVE_CLAIM_HEADER,
  UNIFIED_RESET_HEADER,
} from './constants'

/**
 * Model-tier fallback for Claude Max accounts.
 *
 * Max subscriptions have SEPARATE weekly caps per premium model tier (Fable,
 * Opus, …). When one is exhausted, `/v1/messages` with that tier's model
 * returns HTTP 429 carrying a tier-scoped
 * `anthropic-ratelimit-unified-representative-claim` (e.g. `seven_day_opus`,
 * `seven_day_fable`) — even though the account's aggregate 5h/7d windows (all
 * the load balancer tracked) still have headroom and every OTHER model works
 * fine. The old behavior cooled the WHOLE account down 5 min and rotated,
 * cascading every account into cooldown and blocking non-limited models too.
 *
 * Instead this module classifies the tier from the claim header and rewrites
 * the request's `model` one rung DOWN the fallback ladder: the family order
 * (`DEFAULT_FAMILY_ORDER`, env-overridable) is walked strictly below the
 * limited model's family, and the highest-versioned model of the first family
 * present in the provider's catalog wins (a capped `claude-fable-5` becomes
 * `claude-opus-4-9` when the catalog has it, `claude-opus-4-8` otherwise).
 * Each rewrite descends at least one family, so a request can chain
 * fable → opus → sonnet as tiers prove capped, and always terminates. The
 * fetch loop persists each tier reset in
 * `PoolAccount.modelCooldownsUntil[tier]` so later requests for that tier
 * PREFER an account with tier headroom (skip, not cooldown) and only
 * downgrade when the whole pool is tier-limited. Verified against Claude
 * Code's `errors.ts` (headers, not the JSON body, are the authoritative
 * signal).
 */

/**
 * When a rejected response omits a usable `unified-reset`, cool the tier down
 * only briefly so the account re-probes soon rather than downgrading for a
 * full week on a missing header. A real tier weekly reset arrives on the next
 * 429.
 */
const TIER_RESET_FALLBACK_MS = 60 * 60 * 1000
/**
 * A tier weekly window is ≤ 7 days; anything past this bound is a broken
 * server/proxy clock. Reject it (fall through to the brief default) exactly
 * like `fetch.ts`'s `RETRY_AFTER_MAX_MS` guard, so a bogus far-future reset
 * can't pin every request for that tier onto the fallback model for years.
 * Single-sourced with that guard via `MAX_QUOTA_RESET_BOUND_MS`.
 */
const TIER_RESET_MAX_MS = MAX_QUOTA_RESET_BOUND_MS

/** Matches a purely alphabetic model-id segment (`opus`, `fable`, `sonnet`). */
const ALPHA_SEGMENT_RE = /^[a-z]+$/
/** Matches a purely numeric model-id segment (`4`, `9`, `20250929`). */
const DIGIT_SEGMENT_RE = /^\d+$/

/**
 * The model FAMILY of a first-party model id — the tier name its per-model cap
 * is keyed by: `claude-opus-4-7` → "opus", `claude-fable-5` → "fable",
 * `claude-3-5-sonnet-latest` → "sonnet". The first alphabetic dash-segment
 * after the vendor prefix; null when no such segment exists (unknown /
 * non-first-party ids never participate in tier logic).
 */
export function modelFamily(model: string): string | null {
  for (const segment of model.toLowerCase().split('-')) {
    if (segment !== 'claude' && ALPHA_SEGMENT_RE.test(segment)) return segment
  }
  return null
}

/**
 * The tier a request body asks for (the `modelCooldownsUntil` key to consult
 * before sending), or null when the body is not JSON / has no string model /
 * the model has no recognizable family.
 */
export function requestModelTier(body: string): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  const model = parsed.model
  return typeof model === 'string' ? modelFamily(model) : null
}

/**
 * All numeric dash-segments of a model id, in order — its comparable version
 * vector. Works for both id styles: `claude-opus-4-9` → [4,9] and
 * `claude-3-5-sonnet-latest` → [3,5] (non-numeric segments like `latest` are
 * ignored), and dated snapshots simply extend the vector
 * (`claude-sonnet-4-5-20250929` → [4,5,20250929]).
 */
function versionVector(model: string): number[] {
  const out: number[] = []
  for (const segment of model.split('-')) {
    if (DIGIT_SEGMENT_RE.test(segment)) out.push(Number(segment))
  }
  return out
}

/**
 * Element-wise version comparison (> 0 = `a` newer). A missing element
 * compares as -1, so `4-6` beats `4-5-20250929` on the second element and a
 * dated snapshot beats its own undated alias (more specific wins a tie).
 */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d !== 0) return d
  }
  return 0
}

/** The highest-versioned catalog model of `family`, or null when it has none. */
function bestOfFamily(
  models: readonly string[],
  family: string,
): string | null {
  let best: string | null = null
  let bestVersion: number[] = []
  for (const model of models) {
    if (modelFamily(model) !== family) continue
    const version = versionVector(model)
    if (best === null || compareVersions(version, bestVersion) > 0) {
      best = model
      bestVersion = version
    }
  }
  return best
}

/**
 * One-slot memo for the family order, keyed by the raw env value (same
 * pattern as `resolveFallbackSetting` below). Env semantics: unset/blank →
 * `DEFAULT_FAMILY_ORDER`; otherwise a comma-separated best→worst list
 * (entries trimmed + lowercased, empties dropped).
 */
const computeFamilyOrder = memoOne(
  (raw: string | undefined): readonly string[] => {
    const parsed = (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
    return parsed.length > 0 ? parsed : DEFAULT_FAMILY_ORDER
  },
)
export function resolveFamilyOrder(): readonly string[] {
  return computeFamilyOrder(process.env.OPENCODE_AUTH_LB_ANTHROPIC_FAMILY_ORDER)
}

/**
 * How the downgrade target is chosen:
 *  - `ladder` (env unset): walk the family order through the catalog.
 *  - `pinned` (env = a model id): always that model, bypassing the ladder.
 *  - `disabled` (env = empty/blank): no downgrade — account-wide cooldown.
 */
type FallbackSetting =
  { kind: 'ladder' } | { kind: 'pinned'; model: string } | { kind: 'disabled' }

/**
 * One-slot memo keyed by the raw env value (same pattern as `resolveBaseUrl`
 * in transform.ts): the setting is a constant for a session's life, yet
 * `downgradeModel` would otherwise re-read + re-branch `process.env` on every
 * skip/reactive attempt.
 */
const computeFallbackSetting = memoOne(
  (raw: string | undefined): FallbackSetting => {
    const trimmed = raw?.trim()
    return raw === undefined
      ? { kind: 'ladder' }
      : trimmed
        ? { kind: 'pinned', model: trimmed }
        : { kind: 'disabled' }
  },
)
export function resolveFallbackSetting(): FallbackSetting {
  return computeFallbackSetting(
    process.env.OPENCODE_AUTH_LB_ANTHROPIC_OPUS_FALLBACK_MODEL,
  )
}

/**
 * The ladder pick for a capped model whose family is already known: the best
 * catalog model of the first family strictly BELOW `fromFamily` in the
 * configured order. A family not in the order at all (a future top tier —
 * historically new premium tiers appear at the top) starts the walk from the
 * order's first entry. Null `fromFamily` (unknown family) also starts the
 * walk from the order's first entry. Null when no lower family has a catalog
 * model (the caller falls back to the static last-resort default). Takes the
 * family directly so callers that already computed it (e.g. `downgradeModel`)
 * don't re-derive it from the raw model id.
 */
function ladderTargetForFamily(
  fromFamily: string | null,
  models: readonly string[],
): string | null {
  const order = resolveFamilyOrder()
  // indexOf -1 (unknown family) + 1 = 0 — the walk covers the whole order.
  const start = order.indexOf(fromFamily ?? '') + 1
  for (let i = start; i < order.length; i++) {
    const family = order[i]
    if (family === undefined) continue
    const best = bestOfFamily(models, family)
    if (best !== null) return best
  }
  return null
}

/**
 * Rewrite a request body's `model` one rung down the fallback ladder (or to
 * the pinned override). Returns the rewritten body (+ the from/to ids for the
 * toast) or null when: the feature is disabled, the body is not JSON, `model`
 * is absent/non-string/family-less, or the chosen target lands in the SAME
 * family (a same-tier rewrite cannot escape that tier's cap — e.g. a
 * Sonnet-tier 429 with no lower catalog family has no cheaper first-party
 * target, so it falls through to the normal account cooldown). Callers gate
 * on a cheap condition (a stored tier cooldown or a response header) BEFORE
 * this parse.
 */
export function downgradeModel(
  body: string,
  models: readonly string[],
): ModelFallback | null {
  const setting = resolveFallbackSetting()
  if (setting.kind === 'disabled') return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  const from = parsed.model
  if (typeof from !== 'string') return null
  const fromFamily = modelFamily(from)
  if (fromFamily === null) return null
  const target =
    setting.kind === 'pinned'
      ? setting.model
      : (ladderTargetForFamily(fromFamily, models) ??
        DEFAULT_OPUS_FALLBACK_MODEL)
  if (modelFamily(target) === fromFamily) return null
  parsed.model = target
  return {
    body: JSON.stringify(parsed),
    fromModel: from,
    toModel: target,
    // The tier that triggered this downgrade — already computed above as
    // `fromFamily` — threaded through so `notifyModelFallback`'s de-dupe key
    // can scope to the SPECIFIC tier instead of scanning for the max active
    // cooldown (see `ModelFallback.fromTier`'s doc comment).
    fromTier: fromFamily,
  }
}

/** Decode the tier reset (unix seconds header → epoch ms), clamped/defaulted. */
function parseTierReset(res: Response, now: number): number {
  const ms = secondsToMs(Number(res.headers.get(UNIFIED_RESET_HEADER)))
  if (ms > now && ms - now <= TIER_RESET_MAX_MS) return ms
  return now + TIER_RESET_FALLBACK_MS
}

/**
 * REACTIVE: on a rejected response, when the binding limit is a MODEL-TIER cap
 * (`representative-claim: seven_day_<tier>` / `five_hour_<tier>`) and the sent
 * body's model can fall down the ladder, return the tier to persist, the tier
 * reset, and the downgraded body (adopted only once the whole pool proves
 * tier-limited). The header claim is checked BEFORE the body parse.
 */
export function planReactiveFallback(
  res: Response,
  body: string,
  now: number,
  models: readonly string[],
): ReactiveModelFallback | null {
  const claim = res.headers.get(REPRESENTATIVE_CLAIM_HEADER)
  const tier = claim ? MODEL_TIER_CLAIM_RE.exec(claim)?.[1] : undefined
  if (!tier) return null
  const fallback = downgradeModel(body, models)
  if (!fallback) return null
  return { tier, resetAt: parseTierReset(res, now), fallback }
}
