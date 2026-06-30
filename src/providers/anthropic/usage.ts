import type {
  PoolAccount,
  UsageSnapshot,
  UsageStatus,
  UsageWindow,
} from '../../types'
import { clamp01, ignore, secondsToMs } from '../../util'
import { USAGE_HTTP_TIMEOUT_MS, USAGE_URL, USAGE_USER_AGENT } from './constants'

function mapStatus(raw: string | null): UsageStatus | null {
  if (!raw) return null
  if (raw === 'rejected') return 'rejected'
  if (raw === 'allowed') return 'allowed'
  return 'warning' // allowed_warning and any other non-rejected variant
}

/**
 * Build a single UsageWindow from the raw utilization + reset header strings.
 * Lifted from inside `parseUsageHeaders` so we don't reallocate a closure per
 * response on the inference hot path; symmetric with `openai/usage.ts`'s
 * module-level `windowFromPercent` helper. Captures NOTHING from its caller —
 * `clamp01` and `secondsToMs` are module-imported.
 *
 * `utilRaw` is `string` (NOT `string | null`): `parseUsageHeaders` short-
 * circuits on a null utilization header BEFORE calling, so the null branch
 * here would be dead code (and the matching `headers.get(...reset)` call
 * would have been a wasted map lookup for a value parseHeaderWindow would
 * immediately discard).
 */
function parseHeaderWindow(
  utilRaw: string,
  resetRaw: string | null,
): UsageWindow | null {
  const util = Number(utilRaw)
  if (!Number.isFinite(util)) return null
  // secondsToMs absorbs the non-finite / overflow guard (util.ts).
  return {
    utilization: clamp01(util),
    resetAt: secondsToMs(Number(resetRaw)),
  }
}

/**
 * Parse usage from /v1/messages response headers (free, on every response).
 * Header utilization is a 0..1 FRACTION; reset is epoch SECONDS.
 */
export function parseUsageHeaders(
  headers: Headers,
  now: number,
): Partial<UsageSnapshot> | null {
  const h5 = headers.get('anthropic-ratelimit-unified-5h-utilization')
  const h7 = headers.get('anthropic-ratelimit-unified-7d-utilization')
  const status = headers.get('anthropic-ratelimit-unified-status')
  if (h5 === null && h7 === null && status === null) return null

  const out: Partial<UsageSnapshot> = { capturedAt: now }
  // Short-circuit before `headers.get('...reset')` when the matching
  // utilization header is missing — `parseHeaderWindow` would only have
  // discarded the reset value via its now-removed null guard, so the
  // map lookup was wasted work on every response that reported only one
  // of the two windows.
  const hourly =
    h5 === null
      ? null
      : parseHeaderWindow(
          h5,
          headers.get('anthropic-ratelimit-unified-5h-reset'),
        )
  const weekly =
    h7 === null
      ? null
      : parseHeaderWindow(
          h7,
          headers.get('anthropic-ratelimit-unified-7d-reset'),
        )
  if (hourly) out.hourly = hourly
  if (weekly) out.weekly = weekly
  const mapped = mapStatus(status)
  if (mapped) out.status = mapped
  return out
}

/** A window from the usage endpoint: utilization is a 0..100 PERCENT; resets_at varies. */
interface UsageEndpointWindow {
  utilization: number
  resets_at: string | number
}

interface UsageEndpointResponse {
  five_hour: UsageEndpointWindow | null
  seven_day: UsageEndpointWindow | null
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

function endpointWindow(w: UsageEndpointWindow | null): UsageWindow | null {
  if (!w) return null
  // Symmetric with parseUsageHeaders() and the OpenAI endpoint helper:
  // a window without a finite utilization is unusable — return null so the
  // scheduler does NOT treat a malformed response as "0% used" and rank it first.
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
 * consuming inference quota. Returns null on any failure (caller keeps last-known).
 */
export async function fetchUsage(
  account: PoolAccount,
  now: number,
): Promise<UsageSnapshot | null> {
  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${account.access}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': USAGE_USER_AGENT,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(USAGE_HTTP_TIMEOUT_MS),
    })
  } catch {
    return null
  }

  if (!response.ok) {
    await response.body?.cancel().catch(ignore)
    return null
  }

  const json = (await response
    .json()
    .catch(() => null)) as UsageEndpointResponse | null
  if (!json) return null

  return {
    hourly: endpointWindow(json.five_hour),
    weekly: endpointWindow(json.seven_day),
    status: null,
    capturedAt: now,
  }
}
