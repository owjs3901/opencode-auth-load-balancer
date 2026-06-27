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

  const window = (
    utilRaw: string | null,
    resetRaw: string | null,
  ): UsageWindow | null => {
    if (utilRaw === null) return null
    const util = Number(utilRaw)
    if (!Number.isFinite(util)) return null
    // secondsToMs absorbs the non-finite / overflow guard (util.ts).
    return {
      utilization: clamp01(util),
      resetAt: secondsToMs(Number(resetRaw)),
    }
  }

  const out: Partial<UsageSnapshot> = { capturedAt: now }
  const hourly = window(h5, headers.get('anthropic-ratelimit-unified-5h-reset'))
  const weekly = window(h7, headers.get('anthropic-ratelimit-unified-7d-reset'))
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
    return value > 1e12 ? value : value * 1000 // ms vs seconds heuristic
  }
  const asNum = Number(value)
  if (Number.isFinite(asNum) && value.trim() !== '') {
    return asNum > 1e12 ? asNum : asNum * 1000
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
