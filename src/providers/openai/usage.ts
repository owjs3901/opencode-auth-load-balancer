import type { PoolAccount, UsageSnapshot, UsageWindow } from '../../types'
import { isPlainObject, secondsToMs } from '../../util'
import {
  endpointWindowFrom,
  parseWindowPairHeaders,
  type WindowPairHeaderSpec,
} from '../usage-headers'
import { fetchUsageJson } from '../usage-http'
import { USAGE_HTTP_TIMEOUT_MS, USAGE_URL, USAGE_USER_AGENT } from './constants'
import { resolveAccountId } from './jwt'

const WEEK_SECONDS = 7 * 24 * 60 * 60
const WEEK_MINUTES = WEEK_SECONDS / 60
const PRIMARY_WINDOW_MINUTES_HEADER = 'x-codex-primary-window-minutes'

/** used-percent is 0..100 (divisor 100); reset-at is epoch SECONDS. */
const HEADER_SPEC: WindowPairHeaderSpec = {
  hourlyUtil: 'x-codex-primary-used-percent',
  hourlyReset: 'x-codex-primary-reset-at',
  weeklyUtil: 'x-codex-secondary-used-percent',
  weeklyReset: 'x-codex-secondary-reset-at',
  divisor: 100,
}

const WEEKLY_PRIMARY_HEADER_SPEC: WindowPairHeaderSpec = {
  hourlyUtil: HEADER_SPEC.weeklyUtil,
  hourlyReset: HEADER_SPEC.weeklyReset,
  weeklyUtil: HEADER_SPEC.hourlyUtil,
  weeklyReset: HEADER_SPEC.hourlyReset,
  divisor: HEADER_SPEC.divisor,
}

/**
 * Parse usage from Codex response headers (x-codex-{primary,secondary}-*).
 * The historical default is primary = ~5h and secondary = weekly; when the
 * official primary-window-minutes header identifies a seven-day primary, swap
 * the pair before using the shared parser. The parse itself (null-short-circuit,
 * "no capturedAt", "`{}` collapses to null") lives in `parseWindowPairHeaders`.
 */
export function parseUsageHeaders(
  headers: Headers,
): Partial<UsageSnapshot> | null {
  const primaryWindowMinutes = Number(
    headers.get(PRIMARY_WINDOW_MINUTES_HEADER),
  )
  if (primaryWindowMinutes === WEEK_MINUTES) {
    return parseWindowPairHeaders(headers, WEEKLY_PRIMARY_HEADER_SPEC)
  }
  return parseWindowPairHeaders(headers, HEADER_SPEC)
}

/**
 * One rate-limit window from /wham/usage. The real ChatGPT/Codex shape is
 * snake_case: `used_percent` (0..100 integer) + `reset_at` (epoch SECONDS).
 */
interface UsageEndpointWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

/**
 * /wham/usage response (Codex `RateLimitStatusPayload`). The windows live under a
 * singular `rate_limit`. Older payloads use primary (~5h) + secondary (weekly),
 * while newer plans may return the weekly general limit as the sole primary window.
 */
interface UsageEndpointResponse {
  rate_limit?: {
    primary_window?: UsageEndpointWindow | null
    secondary_window?: UsageEndpointWindow | null
  } | null
}

/**
 * A null/absent window inside a valid `rate_limit` payload is AUTHORITATIVE
 * "no usage recorded in this window" (fresh account, out-of-band quota reset,
 * or idle past the window); genuinely broken bodies never get here (the
 * `rate_limit` envelope check in `fetchUsage` is the shape guard, discarding
 * the poll entirely and keeping the last-known snapshot). The absent/
 * malformed/clamp+reset contract itself lives in the shared
 * `endpointWindowFrom` (usage-headers.ts, mirrors the Anthropic endpoint
 * helper) — only the field names (`used_percent`/`reset_at`) and Codex's
 * plain-seconds reset parser (`secondsToMs`, which absorbs the non-finite /
 * overflow guard) are specific to this provider.
 */
function endpointWindow(
  w: UsageEndpointWindow | null | undefined,
): UsageWindow | null {
  return endpointWindowFrom(
    w,
    (win) => win.used_percent,
    100,
    (win) => secondsToMs(Number(win.reset_at ?? 0)),
  )
}

/**
 * Poll GET /wham/usage for authoritative 5h + weekly utilization without consuming
 * inference quota. Null on failure. Sends the Codex
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
  const accountId = resolveAccountId(account)
  if (accountId) headers['chatgpt-account-id'] = accountId

  const json = await fetchUsageJson<UsageEndpointResponse>(
    USAGE_URL,
    headers,
    USAGE_HTTP_TIMEOUT_MS,
  )
  const rateLimit = json?.rate_limit
  if (!isPlainObject(rateLimit)) return null

  const { primary_window: primary, secondary_window: secondary } = rateLimit
  const primaryIsWeekly = primary?.limit_window_seconds === WEEK_SECONDS

  return {
    hourly: endpointWindow(primaryIsWeekly ? secondary : primary),
    weekly: endpointWindow(primaryIsWeekly ? primary : secondary),
    capturedAt: now,
  }
}
