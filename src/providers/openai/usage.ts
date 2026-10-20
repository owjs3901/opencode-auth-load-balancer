import type {
  PoolAccount,
  UsageCredits,
  UsageSnapshot,
  UsageWindow,
} from '../../types'
import { isPlainObject, secondsToMs } from '../../util'
import {
  endpointWindowFrom,
  parseWindowPairHeaders,
  type WindowPairHeaderSpec,
} from '../usage-headers'
import { fetchUsageJson } from '../usage-http'
import { USAGE_HTTP_TIMEOUT_MS, USAGE_URL, USAGE_USER_AGENT } from './constants'
import { resolveAccountId } from './jwt'

const WEEK_MINUTES = 7 * 24 * 60

/**
 * Whether a window of `minutes` is the WEEKLY one.
 *
 * `primary`/`secondary` are POSITIONS, not durations: Codex reports whichever
 * limits apply to the plan, and on the current ChatGPT Pro shape the seven-day
 * general limit arrives as the sole `primary_window` with no secondary at all.
 * Reading positionally there filed the weekly number as 5h usage and left
 * `weekly` at a permanent 0% — a number that never moves however much quota is
 * spent, and that tells the scheduler an all-but-exhausted account still has
 * full weekly headroom. So classify by DURATION.
 *
 * The ±5% band (not an equality test) mirrors the official Codex CLI's own
 * classifier — `is_approximate_window` / `get_limits_duration` in
 * `codex-rs/tui/src/chatwidget/rate_limits.rs`, which accepts 9576..10584
 * minutes as "weekly" — so a backend that rounds the window length differently
 * cannot silently fall back to the positional reading this exists to prevent.
 */
function isWeeklyMinutes(minutes: number): boolean {
  return minutes >= WEEK_MINUTES * 0.95 && minutes <= WEEK_MINUTES * 1.05
}

/** Duration of the primary response-header window, in minutes (Codex sends it alongside the pair). */
const PRIMARY_WINDOW_MINUTES_HEADER = 'x-codex-primary-window-minutes'

/** used-percent is 0..100 (divisor 100); reset-at is epoch SECONDS. */
const HEADER_SPEC: WindowPairHeaderSpec = {
  hourlyUtil: 'x-codex-primary-used-percent',
  hourlyReset: 'x-codex-primary-reset-at',
  weeklyUtil: 'x-codex-secondary-used-percent',
  weeklyReset: 'x-codex-secondary-reset-at',
  divisor: 100,
}

/** The same header pair with the two roles exchanged (primary IS the weekly window). */
const WEEKLY_PRIMARY_HEADER_SPEC: WindowPairHeaderSpec = {
  hourlyUtil: HEADER_SPEC.weeklyUtil,
  hourlyReset: HEADER_SPEC.weeklyReset,
  weeklyUtil: HEADER_SPEC.hourlyUtil,
  weeklyReset: HEADER_SPEC.hourlyReset,
  divisor: HEADER_SPEC.divisor,
}

/**
 * Credits as Codex reports them (`has_credits` + `unlimited` + an optional
 * decimal-string `balance`): both flags are required, as in the Codex CLI's
 * `parse_credits_snapshot`, and an unparsable balance is simply unknown. Only
 * the usage endpoint reports `overage_limit_reached`.
 */
function creditsFrom(
  hasCredits: unknown,
  unlimited: unknown,
  balance: unknown,
  limitReached?: unknown,
): UsageCredits | undefined {
  if (typeof hasCredits !== 'boolean' || typeof unlimited !== 'boolean')
    return undefined
  const amount =
    typeof balance === 'string' && balance.trim() !== ''
      ? Number(balance)
      : Number.NaN
  return {
    hasCredits,
    unlimited,
    ...(Number.isFinite(amount) ? { balance: amount } : {}),
    ...(limitReached === true ? { limitReached } : {}),
  }
}

function headerBool(raw: string | null): boolean | undefined {
  const value = raw?.toLowerCase()
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  return undefined
}

/**
 * Parse usage from Codex response headers (x-codex-{primary,secondary}-*).
 * The historical default is primary = ~5h and secondary = weekly; when the
 * primary-window-minutes header identifies a seven-day primary, swap the pair
 * before using the shared parser (see `isWeeklyMinutes`). An absent/
 * unparsable duration header keeps the historical default — `Number(null)` is
 * NaN, and every comparison against NaN is false. The parse itself (null-short-circuit,
 * "no capturedAt", "`{}` collapses to null") lives in the shared
 * `parseWindowPairHeaders` — only the header names, the percent scale, and
 * this role detection are Codex-specific. The credits headers
 * (x-codex-credits-*) ride along, even on a response without windows.
 */
export function parseUsageHeaders(
  headers: Headers,
): Partial<UsageSnapshot> | null {
  const primaryWindowMinutes = Number(
    headers.get(PRIMARY_WINDOW_MINUTES_HEADER),
  )
  const spec = isWeeklyMinutes(primaryWindowMinutes)
    ? WEEKLY_PRIMARY_HEADER_SPEC
    : HEADER_SPEC
  const windows = parseWindowPairHeaders(headers, spec)
  const credits = creditsFrom(
    headerBool(headers.get('x-codex-credits-has-credits')),
    headerBool(headers.get('x-codex-credits-unlimited')),
    headers.get('x-codex-credits-balance'),
  )
  return credits ? { ...windows, credits } : windows
}

/**
 * One rate-limit window from /wham/usage. The real ChatGPT/Codex shape is
 * snake_case: `used_percent` (0..100 integer) + `reset_at` (epoch SECONDS),
 * plus `limit_window_seconds` — the window's DURATION, which is what actually
 * identifies it as the 5h or the 7d window (see `isWeeklyMinutes`).
 */
interface UsageEndpointWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

/**
 * /wham/usage response (Codex `RateLimitStatusPayload`). The windows live under a
 * singular `rate_limit`. Older payloads use primary (~5h) + secondary (weekly),
 * while current plans may return the weekly general limit as the SOLE primary
 * window (`secondary_window: null`).
 */
interface UsageEndpointResponse {
  rate_limit?: {
    primary_window?: UsageEndpointWindow | null
    secondary_window?: UsageEndpointWindow | null
  } | null
  credits?: unknown
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
 * Poll GET /wham/usage for authoritative 5h + weekly utilization (and the
 * credits spent past them) without
 * consuming inference quota, assigning each returned window to its role BY
 * DURATION (see `isWeeklyMinutes`) rather than by position. A 401 is surfaced
 * for bounded OAuth recovery; other failures return null.
 * Sends the Codex CLI's `codex-cli` UA and the `chatgpt-account-id` (from the
 * stored id or, as a fallback, decoded from the access-token JWT) — required
 * for team/workspace accounts.
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
  // Shape guard: the `rate_limit` envelope must be a plain OBJECT. A truthy
  // non-object (`rate_limit: []` / `42` / `"x"` from schema drift or a proxy
  // page) would otherwise read both windows as `undefined` and record a
  // fabricated 0% over the last-known snapshot — the very "garbage as full
  // headroom" the window mapping below is careful to avoid.
  const rateLimit = json?.rate_limit
  if (!isPlainObject(rateLimit)) return null

  const { primary_window: primary, secondary_window: secondary } = rateLimit
  // Seconds → minutes with the same CEIL rounding the Codex CLI applies
  // (`window_minutes_from_seconds` in codex-rs/backend-client), so both the
  // header and the endpoint path feed `isWeeklyMinutes` the same units.
  const primaryIsWeekly = isWeeklyMinutes(
    Math.ceil(Number(primary?.limit_window_seconds) / 60),
  )
  const reported = json?.credits
  const credits = isPlainObject(reported)
    ? creditsFrom(
        reported.has_credits,
        reported.unlimited,
        reported.balance,
        reported.overage_limit_reached,
      )
    : undefined

  return {
    hourly: endpointWindow(primaryIsWeekly ? secondary : primary),
    weekly: endpointWindow(primaryIsWeekly ? primary : secondary),
    capturedAt: now,
    ...(credits ? { credits } : {}),
  }
}
