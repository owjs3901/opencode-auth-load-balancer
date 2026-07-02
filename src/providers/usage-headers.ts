import type { UsageSnapshot, UsageWindow } from '../types'
import { clamp01, secondsToMs } from '../util'

/**
 * Header names + scale for one provider's hourly/weekly rate-limit header pair.
 * `divisor` maps the utilization header onto the normalized 0..1 fraction:
 * 1 when the header already IS a fraction (Anthropic), 100 when it is a
 * percent (Codex).
 */
export interface WindowPairHeaderSpec {
  hourlyUtil: string
  hourlyReset: string
  weeklyUtil: string
  weeklyReset: string
  divisor: number
}

/**
 * Build a single UsageWindow from the raw utilization + reset header strings.
 * Module-level (not a per-call closure) — this runs on the inference hot path,
 * once per response.
 *
 * `utilRaw` is `string` (NOT `string | null`): `parseWindowPairHeaders` short-
 * circuits on a null utilization header BEFORE calling, so a null branch here
 * would be dead code (and the matching `headers.get(...reset)` call would have
 * been a wasted map lookup for a value this function would immediately discard).
 */
function headerWindow(
  utilRaw: string,
  resetRaw: string | null,
  divisor: number,
): UsageWindow | null {
  const util = Number(utilRaw)
  if (!Number.isFinite(util)) return null
  // secondsToMs absorbs the non-finite / overflow guard (util.ts).
  return {
    utilization: clamp01(util / divisor),
    resetAt: secondsToMs(Number(resetRaw)),
  }
}

/**
 * Parse an hourly/weekly usage pair from response headers (free, on every
 * response). Shared by both providers — the parse is structurally identical,
 * only the header names and the utilization scale (`spec`) differ.
 *
 * Deliberately NO `capturedAt` here: `applyUsagePartial` (fetch.ts) stamps its
 * own timestamp, and ONLY when a weekly window arrived — the staleness gate
 * `refreshUsageInBackground` relies on. A parser-side stamp would be dead data
 * at best and, if a future consumer trusted it, would resurrect the
 * weekly-less-partial-marks-fresh bug locked by plugin.test.ts.
 *
 * Returns null when no utilization header is present, AND when headers were
 * present but NEITHER window parsed (e.g. a malformed utilization value) — the
 * contract consumers gate on (`if (partial)`) is "null = nothing usable",
 * never a truthy empty `{}`.
 */
export function parseWindowPairHeaders(
  headers: Headers,
  spec: WindowPairHeaderSpec,
): Partial<UsageSnapshot> | null {
  const h = headers.get(spec.hourlyUtil)
  const w = headers.get(spec.weeklyUtil)
  if (h === null && w === null) return null

  const out: Partial<UsageSnapshot> = {}
  // Short-circuit before `headers.get(spec.*Reset)` when the matching
  // utilization header is missing — the map lookup would be wasted work on
  // every response that reported only one of the two windows.
  const hourly =
    h === null
      ? null
      : headerWindow(h, headers.get(spec.hourlyReset), spec.divisor)
  const weekly =
    w === null
      ? null
      : headerWindow(w, headers.get(spec.weeklyReset), spec.divisor)
  if (hourly) out.hourly = hourly
  if (weekly) out.weekly = weekly
  return hourly || weekly ? out : null
}
