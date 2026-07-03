import type { PoolAccount } from '../../types'
import { secondsToMs } from '../../util'
import type { ModelFallback, ReactiveModelFallback } from '../types'
import {
  DEFAULT_OPUS_FALLBACK_MODEL,
  REPRESENTATIVE_CLAIM_HEADER,
  SEVEN_DAY_OPUS_CLAIM,
  UNIFIED_RESET_HEADER,
} from './constants'

/**
 * Opus model-tier fallback for Claude Max accounts.
 *
 * Max subscriptions have a SEPARATE weekly cap for Opus. When it is exhausted,
 * `/v1/messages` with an Opus model returns HTTP 429 carrying
 * `anthropic-ratelimit-unified-representative-claim: seven_day_opus` — even
 * though the account's aggregate 5h/7d windows (all the load balancer tracked)
 * still have headroom and NON-Opus models work fine. The old behavior cooled the
 * WHOLE account down 5 min and rotated, cascading every account into cooldown.
 *
 * Instead this module downgrades the request's `model` (Opus → the configured
 * fallback, default Sonnet) on the SAME account so the user keeps working, and
 * the fetch loop persists `PoolAccount.opusCooldownUntil` so later turns
 * downgrade PROACTIVELY (no wasted rejected round-trip). Verified against Claude
 * Code's `errors.ts` (headers, not the JSON body, are the authoritative signal).
 */

/**
 * When a rejected response omits a usable `unified-reset`, cool Opus down only
 * briefly so the account re-probes soon rather than downgrading for a full week
 * on a missing header. A real Opus weekly reset arrives on the next 429.
 */
const OPUS_RESET_FALLBACK_MS = 60 * 60 * 1000
/**
 * The Opus weekly window is ≤ 7 days; anything past this bound is a broken
 * server/proxy clock. Reject it (fall through to the brief default) exactly like
 * `fetch.ts`'s `RETRY_AFTER_MAX_MS` guard, so a bogus far-future reset can't pin
 * every Opus request onto the fallback model for years.
 */
const OPUS_RESET_MAX_MS = 8 * 24 * 60 * 60 * 1000

/** Hoisted so the proactive per-attempt path avoids re-creating the RegExp object per call. */
const OPUS_MODEL_RE = /opus/i

/**
 * One-slot memo keyed by the raw env value (same pattern as `resolveBaseUrl` in
 * transform.ts): the fallback model is a constant string for a session's life,
 * yet `downgradeModel` would otherwise re-read + re-branch `process.env` on
 * every proactive/reactive attempt.
 *
 * Semantics: env UNSET → the built-in default (feature ON); env EMPTY (after
 * trim) → `null` (feature DISABLED, revert to account-wide cooldown); otherwise
 * the trimmed id.
 */
let cachedModel: { raw: string | undefined; model: string | null } | null = null
export function resolveFallbackModel(): string | null {
  const raw = process.env.OPENCODE_AUTH_LB_ANTHROPIC_OPUS_FALLBACK_MODEL
  if (cachedModel && cachedModel.raw === raw) return cachedModel.model
  const model =
    raw === undefined ? DEFAULT_OPUS_FALLBACK_MODEL : raw.trim() || null
  cachedModel = { raw, model }
  return model
}

/**
 * Rewrite an Opus request body's `model` to the configured fallback. Returns the
 * rewritten body (+ the from/to ids for the toast) or null when: the feature is
 * disabled, the body is not JSON, `model` is absent/non-string, the model is not
 * an Opus model, or it already equals the fallback. Callers gate on a cheap
 * condition (stored `opusCooldownUntil` or a response header) BEFORE this parse.
 */
export function downgradeModel(body: string): ModelFallback | null {
  const fallback = resolveFallbackModel()
  if (!fallback) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  const from = parsed.model
  // Only downgrade Opus (the only tier with a fallback target), and never
  // rewrite a body already on the fallback model (Sonnet-tier 429s have no
  // cheaper first-party target — they fall through to normal account cooldown).
  if (
    typeof from !== 'string' ||
    !OPUS_MODEL_RE.test(from) ||
    from === fallback
  ) {
    return null
  }
  parsed.model = fallback
  return { body: JSON.stringify(parsed), fromModel: from, toModel: fallback }
}

/**
 * PROACTIVE: downgrade up front when this account's Opus tier is known-exhausted
 * (`opusCooldownUntil > now`). The cheap numeric gate runs before the JSON parse
 * in `downgradeModel`, so the steady-state (non-exhausted) path pays nothing.
 */
export function planProactiveFallback(
  body: string,
  account: PoolAccount,
  now: number,
): ModelFallback | null {
  if ((account.opusCooldownUntil ?? 0) <= now) return null
  return downgradeModel(body)
}

/** Decode the Opus tier reset (unix seconds header → epoch ms), clamped/defaulted. */
function parseOpusReset(res: Response, now: number): number {
  const ms = secondsToMs(Number(res.headers.get(UNIFIED_RESET_HEADER)))
  if (ms > now && ms - now <= OPUS_RESET_MAX_MS) return ms
  return now + OPUS_RESET_FALLBACK_MS
}

/**
 * REACTIVE: on a rejected response, when the binding limit is the Opus weekly cap
 * (`representative-claim: seven_day_opus`) and the sent body's model can fall
 * back, return the downgraded body to retry on the SAME account plus the tier
 * reset to persist. The header claim is checked BEFORE the body parse.
 */
export function planReactiveFallback(
  res: Response,
  body: string,
  now: number,
): ReactiveModelFallback | null {
  if (res.headers.get(REPRESENTATIVE_CLAIM_HEADER) !== SEVEN_DAY_OPUS_CLAIM) {
    return null
  }
  const fallback = downgradeModel(body)
  if (!fallback) return null
  return { resetAt: parseOpusReset(res, now), fallback }
}
