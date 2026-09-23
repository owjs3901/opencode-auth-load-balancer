import type { PoolAccount, UsageSnapshot, UsageWindow } from '../../types'
import { clamp01, isImplausiblyFarFuture, isPlainObject } from '../../util'
import { fetchJson } from '../usage-http'
import { USAGE_HTTP_TIMEOUT_MS } from './constants'

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/** proto3 `TimeUnit` enum names → milliseconds per unit. */
const UNIT_MS = new Map([
  ['TIME_UNIT_SECOND', 1000],
  ['TIME_UNIT_MINUTE', 60_000],
  ['TIME_UNIT_HOUR', 3_600_000],
  ['TIME_UNIT_DAY', 86_400_000],
])

/** A proto3 JSON number: int64 fields arrive as decimal strings, doubles as numbers. */
function toNumber(value: unknown): number | null {
  const n =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** An ISO-8601 reset time → epoch ms; 0 when absent, unparsable, or implausibly far out. */
function resetAt(value: unknown): number {
  if (typeof value !== 'string') return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms > 0 && !isImplausiblyFarFuture(ms) ? ms : 0
}

/** `usages.limit_5h` / `usages.limit_7d` — `{ used_ratio, reset_time }`, what Kimi's own client reads. */
function ratioWindow(raw: unknown): UsageWindow | null {
  if (!isPlainObject(raw)) return null
  const ratio = toNumber(raw.used_ratio)
  if (ratio === null) return null
  return { utilization: clamp01(ratio), resetAt: resetAt(raw.reset_time) }
}

/**
 * The older counter shape still shipped beside `usages` — `usage` (weekly)
 * and each `limits[].detail`: `{ limit, used, remaining, resetTime }` with the
 * int64 counters as strings. proto3 JSON omits zero-valued fields, so an
 * unused window has no `used` and an exhausted one no `remaining`.
 */
function counterWindow(raw: unknown): UsageWindow | null {
  if (!isPlainObject(raw)) return null
  const limit = toNumber(raw.limit)
  if (limit === null || limit <= 0) return null
  const remaining = toNumber(raw.remaining)
  const used =
    toNumber(raw.used) ?? (remaining === null ? 0 : limit - remaining)
  return { utilization: clamp01(used / limit), resetAt: resetAt(raw.resetTime) }
}

/** The `limits[]` entry whose window lasts five hours — matched by duration, not position. */
function fiveHourCounters(limits: unknown): UsageWindow | null {
  if (!Array.isArray(limits)) return null
  for (const entry of limits) {
    if (!isPlainObject(entry) || !isPlainObject(entry.window)) continue
    const unitMs = UNIT_MS.get(String(entry.window.timeUnit))
    const duration = toNumber(entry.window.duration)
    if (
      unitMs !== undefined &&
      duration !== null &&
      duration * unitMs === FIVE_HOURS_MS
    )
      return counterWindow(entry.detail)
  }
  return null
}

/**
 * Parse `GET /usages` into the pool's snapshot, one window at a time: the
 * ratio shape (`usages.limit_5h` / `limit_7d`) first, the counter shape as
 * that window's fallback. Null when neither window parses, so a foreign or
 * broken body keeps the last-known snapshot instead of reading as 0% used.
 */
export function parseUsages(json: unknown, now: number): UsageSnapshot | null {
  if (!isPlainObject(json)) return null
  const ratios: Record<string, unknown> = isPlainObject(json.usages)
    ? json.usages
    : {}
  const hourly = ratioWindow(ratios.limit_5h) ?? fiveHourCounters(json.limits)
  const weekly = ratioWindow(ratios.limit_7d) ?? counterWindow(json.usage)
  return hourly || weekly ? { hourly, weekly, capturedAt: now } : null
}

/** `GET {baseUrl}/usages` — free, spends no quota. Null on any failure. */
export function getUsages(baseUrl: string, key: string): Promise<unknown> {
  return fetchJson<unknown>(
    `${baseUrl}/usages`,
    { authorization: `Bearer ${key}`, accept: 'application/json' },
    USAGE_HTTP_TIMEOUT_MS,
  )
}

/** The adapter's `fetchUsage` for one deployment. */
export function usageFetcher(
  baseUrl: string,
): (account: PoolAccount, now: number) => Promise<UsageSnapshot | null> {
  return async (account, now) =>
    parseUsages(await getUsages(baseUrl, account.access), now)
}
