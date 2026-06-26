import type { PoolAccount, UsageSnapshot, UsageWindow } from '../../types'
import { ignore } from '../../util'
import { USAGE_HTTP_TIMEOUT_MS, USAGE_URL, USAGE_USER_AGENT } from './constants'
import { extractAccountId } from './jwt'

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Build a window from a percent (0..100) + reset epoch seconds. */
function windowFromPercent(
  percentRaw: string | null,
  resetSecRaw: string | null,
): UsageWindow | null {
  if (percentRaw === null) return null
  const percent = Number(percentRaw)
  if (!Number.isFinite(percent)) return null
  const resetSec = Number(resetSecRaw)
  // Mirror applyCooldown's overflow guard (fetch.ts): `1e308` is finite but
  // `1e308 * 1000` overflows to +Infinity, which would commit Infinity to
  // pool.usage.{hourly,weekly}.resetAt — silently breaking isWindowExpired,
  // weeklyUrgency, and relTime rendering. Lock the product to a finite ms.
  const resetMs = resetSec * 1000
  return {
    utilization: clamp01(percent / 100),
    resetAt:
      Number.isFinite(resetSec) && resetSec > 0 && Number.isFinite(resetMs)
        ? resetMs
        : 0,
  }
}

/**
 * Parse usage from Codex response headers (x-codex-{primary,secondary}-*).
 * primary = ~5h window (hourly), secondary = weekly window.
 * used-percent is 0..100; reset-at is epoch seconds.
 */
export function parseUsageHeaders(
  headers: Headers,
  now: number,
): Partial<UsageSnapshot> | null {
  const p = headers.get('x-codex-primary-used-percent')
  const s = headers.get('x-codex-secondary-used-percent')
  if (p === null && s === null) return null

  const out: Partial<UsageSnapshot> = { capturedAt: now }
  const hourly = windowFromPercent(p, headers.get('x-codex-primary-reset-at'))
  const weekly = windowFromPercent(s, headers.get('x-codex-secondary-reset-at'))
  if (hourly) out.hourly = hourly
  if (weekly) out.weekly = weekly
  return out
}

/**
 * One rate-limit window from /wham/usage. The real ChatGPT/Codex shape is
 * snake_case: `used_percent` (0..100 integer) + `reset_at` (epoch SECONDS).
 */
interface UsageEndpointWindow {
  used_percent?: number
  reset_at?: number
}

/**
 * /wham/usage response (Codex `RateLimitStatusPayload`). The windows live under a
 * singular `rate_limit`, with `primary_window` (~5h) and `secondary_window` (weekly).
 */
interface UsageEndpointResponse {
  rate_limit?: {
    primary_window?: UsageEndpointWindow | null
    secondary_window?: UsageEndpointWindow | null
  } | null
}

function endpointWindow(
  w: UsageEndpointWindow | null | undefined,
): UsageWindow | null {
  // Symmetric with parseUsageHeaders() / windowFromPercent above and the
  // Anthropic endpoint helper: a non-finite `used_percent` (e.g. JSON `1e500`
  // → Infinity) passes the typeof gate but then `clamp01(Infinity/100)` falls
  // into the `!Number.isFinite ⇒ 0` branch in score-core, ranking the
  // malformed account as "0% used" → selected first. Reject it as null so
  // the scheduler keeps the last-known snapshot instead.
  if (
    !w ||
    typeof w.used_percent !== 'number' ||
    !Number.isFinite(w.used_percent)
  )
    return null
  const resetSec = typeof w.reset_at === 'number' ? w.reset_at : 0
  // Mirror applyCooldown's overflow guard (fetch.ts): JSON `1e308` is finite
  // but `1e308 * 1000` overflows to +Infinity, which would commit Infinity to
  // pool.usage.{hourly,weekly}.resetAt — silently breaking isWindowExpired,
  // weeklyUrgency, and relTime rendering. Lock the product to a finite ms.
  const resetMs = resetSec * 1000
  return {
    utilization: clamp01(w.used_percent / 100),
    resetAt: resetSec > 0 && Number.isFinite(resetMs) ? resetMs : 0,
  }
}

/**
 * Poll GET /wham/usage for authoritative 5h (primary) + weekly (secondary)
 * utilization without consuming inference quota. Null on failure. Sends the Codex
 * CLI's `codex-cli` UA and the `chatgpt-account-id` (from the stored id or, as a
 * fallback, decoded from the access-token JWT) — required for team/workspace accounts.
 */
export async function fetchUsage(
  account: PoolAccount,
  now: number,
): Promise<UsageSnapshot | null> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${account.access}`,
    'user-agent': USAGE_USER_AGENT,
    accept: 'application/json',
  }
  const accountId = account.accountId ?? extractAccountId(account.access)
  if (accountId) headers['chatgpt-account-id'] = accountId

  let response: Response
  try {
    response = await fetch(USAGE_URL, {
      headers,
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
  if (!json?.rate_limit) return null

  return {
    hourly: endpointWindow(json.rate_limit.primary_window),
    weekly: endpointWindow(json.rate_limit.secondary_window),
    status: null,
    capturedAt: now,
  }
}
