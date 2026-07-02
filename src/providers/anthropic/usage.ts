import type { PoolAccount, UsageSnapshot, UsageWindow } from '../../types'
import { clamp01 } from '../../util'
import {
  parseWindowPairHeaders,
  type WindowPairHeaderSpec,
} from '../usage-headers'
import { fetchUsageJson } from '../usage-http'
import { USAGE_HTTP_TIMEOUT_MS, USAGE_URL, USAGE_USER_AGENT } from './constants'

/** Header utilization is a 0..1 FRACTION (divisor 1); reset is epoch SECONDS. */
const HEADER_SPEC: WindowPairHeaderSpec = {
  hourlyUtil: 'anthropic-ratelimit-unified-5h-utilization',
  hourlyReset: 'anthropic-ratelimit-unified-5h-reset',
  weeklyUtil: 'anthropic-ratelimit-unified-7d-utilization',
  weeklyReset: 'anthropic-ratelimit-unified-7d-reset',
  divisor: 1,
}

/**
 * Parse usage from /v1/messages response headers (free, on every response).
 * The parse itself (null-short-circuit, "no capturedAt", "`{}` collapses to
 * null") lives in the shared `parseWindowPairHeaders` — only the header names
 * and the fraction scale are Anthropic-specific.
 */
export function parseUsageHeaders(
  headers: Headers,
): Partial<UsageSnapshot> | null {
  return parseWindowPairHeaders(headers, HEADER_SPEC)
}

/** A window from the usage endpoint: utilization is a 0..100 PERCENT; resets_at varies. */
interface UsageEndpointWindow {
  utilization: number
  resets_at: string | number
}

interface UsageEndpointResponse {
  five_hour?: UsageEndpointWindow | null
  seven_day?: UsageEndpointWindow | null
}

/**
 * Map a finite, already-validated numeric reset value to epoch-ms. Anthropic has
 * shipped both epoch-seconds and epoch-ms; values past 1e12 (≈ 2001 in ms) are
 * already ms, smaller ones are seconds. Shared by the number and numeric-string
 * branches of parseResetAt so the threshold lives in ONE place.
 *
 * Deliberately NOT delegated to `util.ts`'s `secondsToMs` (the reciprocal of the
 * note there): `secondsToMs` ALWAYS multiplies by 1000, so it cannot accept the
 * already-ms inputs this `> 1e12` heuristic must pass through unchanged. The two
 * have different semantics (seconds-only vs seconds-or-ms) — do not unify them.
 */
const msFromLoose = (n: number): number => (n > 1e12 ? n : n * 1000)

/** Decode resets_at which Anthropic has shipped as ISO string, epoch seconds, or epoch ms. */
function parseResetAt(value: string | number | null | undefined): number {
  // Defensive nullish guard. The endpoint contract documents `string | number`,
  // but `response.json()` legally yields `null` for a nullable field, and the
  // pre-fix code then threw `TypeError` here: `typeof null !== 'number'` skips
  // the number branch, `Number(null) === 0` is finite, and the
  // `&& value.trim() !== ''` guard then executed `null.trim()`. The throw
  // escaped `endpointWindow` → `fetchUsage` and was silenced by
  // `refreshUsageInBackground`'s outer `try { ... } catch { /* ignore */ }`,
  // dropping the entire usage snapshot (the return-object literal in
  // `fetchUsage` runs `hourly: endpointWindow(...)` first, so a single null on
  // the 5h side also lost the 7d window). Symmetric with the OpenAI sibling
  // `endpointWindow` (openai/usage.ts), which already maps any non-number
  // `reset_at` to 0. `undefined` was already safe (`Number(undefined) === NaN`
  // short-circuits the `&&`), but the same early return is the clean fix.
  if (value == null) return 0
  if (typeof value === 'number') {
    // Symmetric with parseUsageHeaders() (above), the OpenAI endpointWindow
    // helper, and applyCooldown (fetch.ts): `JSON.parse('1e500')` yields
    // Infinity (and similarly for ±Infinity / NaN). Without this guard
    // `Infinity > 1e12` is true and we'd commit Infinity straight to
    // pool.usage.{hourly,weekly}.resetAt — silently breaking isWindowExpired,
    // weeklyUrgency (drainable / Infinity = 0 urgency), and relTime rendering.
    if (!Number.isFinite(value)) return 0
    return msFromLoose(value)
  }
  const asNum = Number(value)
  if (Number.isFinite(asNum) && value.trim() !== '') {
    return msFromLoose(asNum)
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function endpointWindow(
  w: UsageEndpointWindow | null | undefined,
): UsageWindow | null {
  // Only reached AFTER fetchUsage's shape guard confirmed the body carries at
  // least one window key — so a null/absent window here is the server
  // deliberately reporting NO usage recorded in that window (e.g. right after
  // Anthropic's out-of-band promotional weekly reset wipes the weekly record,
  // or an account idle past the window). That is a true 0%, not "unknown":
  // synthesize a zero window (resetAt 0 = no reset scheduled yet) so dashboards
  // render "0%" instead of "-" ("-" stays reserved for never-polled accounts).
  // Genuinely broken bodies (no window key at all) never get here — the shape
  // guard discards the whole poll and keeps the last-known snapshot. Scoring is
  // unaffected: utilOf/weeklyUrgency already read a missing window as 0.
  if (!w) return { utilization: 0, resetAt: 0 }
  // Symmetric with parseUsageHeaders() and the OpenAI endpoint helper: a window
  // that is PRESENT but malformed (missing / non-finite utilization) is unusable
  // — return null (NOT 0%) so the scheduler does not treat a malformed response
  // as "full headroom" and rank the account first.
  if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) {
    return null
  }
  return {
    utilization: clamp01(w.utilization / 100), // endpoint is a percent
    resetAt: parseResetAt(w.resets_at),
  }
}

/**
 * Poll the dedicated usage endpoint for authoritative 5h + 7d utilization without
 * consuming inference quota. Returns null on any failure — including a 200 whose
 * body is not the usage shape — so the caller keeps the last-known snapshot.
 */
export async function fetchUsage(
  account: PoolAccount,
  now: number,
): Promise<UsageSnapshot | null> {
  const json = await fetchUsageJson<UsageEndpointResponse>(
    USAGE_URL,
    {
      authorization: `Bearer ${account.access}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': USAGE_USER_AGENT,
      'content-type': 'application/json',
    },
    USAGE_HTTP_TIMEOUT_MS,
  )
  if (!json) return null
  // Shape guard: a 200 whose body carries NEITHER window key is NOT the usage
  // endpoint's shape (schema drift, an error payload, a proxy page that
  // happens to be JSON). Such a body must never be read as "0% used" — discard
  // the poll and keep the last-known snapshot. An EXPLICIT `five_hour: null` /
  // `seven_day: null` (or one key present while the sibling is absent) still
  // validates the shape, so a genuine "no usage recorded" maps to 0% below.
  // (Property access is safe on JSON primitives, so `42` / `"x"` / `[]` all
  // fall into this guard too.)
  if (json.five_hour === undefined && json.seven_day === undefined) return null

  return {
    hourly: endpointWindow(json.five_hour),
    weekly: endpointWindow(json.seven_day),
    capturedAt: now,
  }
}
