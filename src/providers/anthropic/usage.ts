import type { PoolAccount, UsageSnapshot, UsageWindow } from '../../types'
import { isImplausiblyFarFuture } from '../../util'
import {
  endpointWindowFrom,
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
 * Non-positive values map to 0 ("no usable reset"), mirroring `secondsToMs`
 * (util.ts) so a garbage negative resets_at never becomes a negative epoch-ms
 * anchor in the pool.
 */
const msFromLoose = (n: number): number =>
  n <= 0 ? 0 : n > 1e12 ? n : n * 1000

/**
 * Reject a resolved epoch-ms candidate that is implausibly far in the future
 * (see `isImplausiblyFarFuture`, util.ts) before it becomes `resetAt` — a
 * broken server/proxy clock (or JSON `1e500`-style overflow already handled
 * by the finite guards below) must not permanently near-zero-rank an
 * otherwise-healthy account in `weeklyUrgency`. Applied to every branch's
 * result (number, numeric-string, ISO-date) so none of the three decode
 * paths can smuggle a far-future value past the bound.
 */
const boundedReset = (ms: number): number =>
  isImplausiblyFarFuture(ms) ? 0 : ms

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
    return boundedReset(msFromLoose(value))
  }
  const asNum = Number(value)
  if (Number.isFinite(asNum) && value.trim() !== '') {
    return boundedReset(msFromLoose(asNum))
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? boundedReset(parsed) : 0
}

/**
 * Only reached AFTER fetchUsage's shape guard confirmed the body carries at
 * least one window key — genuinely broken bodies (no window key at all) never
 * get here (the shape guard discards the whole poll and keeps the
 * last-known snapshot). The absent/malformed/clamp+reset contract itself
 * lives in the shared `endpointWindowFrom` (usage-headers.ts) — only the
 * field names (`utilization`/`resets_at`) and Anthropic's reset parser
 * (`parseResetAt`) are specific to this provider.
 */
function endpointWindow(
  w: UsageEndpointWindow | null | undefined,
): UsageWindow | null {
  return endpointWindowFrom(
    w,
    (win) => win.utilization,
    100, // endpoint is a percent
    (win) => parseResetAt(win.resets_at),
  )
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
