import type { PoolAccount, UsageSnapshot, UsageWindow } from '../../types'
import { clamp01, isFiniteNumber, secondsToMs } from '../../util'
import {
  parseWindowPairHeaders,
  type WindowPairHeaderSpec,
} from '../usage-headers'
import { fetchUsageJson } from '../usage-http'
import { USAGE_HTTP_TIMEOUT_MS, USAGE_URL, USAGE_USER_AGENT } from './constants'
import { resolveAccountId } from './jwt'

/** used-percent is 0..100 (divisor 100); reset-at is epoch SECONDS. */
const HEADER_SPEC: WindowPairHeaderSpec = {
  hourlyUtil: 'x-codex-primary-used-percent',
  hourlyReset: 'x-codex-primary-reset-at',
  weeklyUtil: 'x-codex-secondary-used-percent',
  weeklyReset: 'x-codex-secondary-reset-at',
  divisor: 100,
}

/**
 * Parse usage from Codex response headers (x-codex-{primary,secondary}-*).
 * primary = ~5h window (hourly), secondary = weekly window. The parse itself
 * (null-short-circuit, "no capturedAt", "`{}` collapses to null") lives in the
 * shared `parseWindowPairHeaders` — only the header names and the percent
 * scale are Codex-specific.
 */
export function parseUsageHeaders(
  headers: Headers,
): Partial<UsageSnapshot> | null {
  return parseWindowPairHeaders(headers, HEADER_SPEC)
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
  // A null/absent window inside a valid `rate_limit` payload is AUTHORITATIVE
  // "no usage recorded in this window" (fresh account, out-of-band quota reset,
  // or idle past the window) — a true 0%, not "unknown". Synthesize a zero
  // window so dashboards render "0%" instead of "-" (mirrors the Anthropic
  // endpoint helper; "-" stays reserved for never-polled accounts). Genuinely
  // broken bodies never get here: the `rate_limit` envelope check in
  // `fetchUsage` is the shape guard (its absence discards the poll entirely,
  // keeping the last-known snapshot). Scoring is unaffected:
  // utilOf/weeklyUrgency already read a missing window as 0.
  if (!w) return { utilization: 0, resetAt: 0 }
  // Symmetric with parseUsageHeaders() / windowFromPercent above and the
  // Anthropic endpoint helper: a window that is PRESENT but malformed is
  // unusable. A non-finite `used_percent` (e.g. JSON `1e500` → Infinity)
  // would otherwise hit `clamp01(Infinity/100)`'s `!Number.isFinite ⇒ 0`
  // branch in score-core, ranking the malformed account as "0% used" →
  // selected first. Reject it as null (NOT 0%) so the scheduler keeps the
  // last-known snapshot instead.
  if (!isFiniteNumber(w.used_percent)) return null
  // secondsToMs absorbs the non-finite / overflow guard (util.ts); a missing /
  // non-number reset_at coerces to 0 → secondsToMs(0) → 0.
  return {
    utilization: clamp01(w.used_percent / 100),
    resetAt: secondsToMs(Number(w.reset_at ?? 0)),
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
  const accountId = resolveAccountId(account)
  if (accountId) headers['chatgpt-account-id'] = accountId

  const json = await fetchUsageJson<UsageEndpointResponse>(
    USAGE_URL,
    headers,
    USAGE_HTTP_TIMEOUT_MS,
  )
  if (!json?.rate_limit) return null

  return {
    hourly: endpointWindow(json.rate_limit.primary_window),
    weekly: endpointWindow(json.rate_limit.secondary_window),
    capturedAt: now,
  }
}
