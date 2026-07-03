import type { UsageSnapshot, UsageWindow } from '../types'
import { clamp01, isFiniteNumber, secondsToMs } from '../util'

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

/**
 * Build a single `UsageWindow` from ONE raw usage-endpoint window, sharing the
 * three-step contract both providers' endpoint parsers need — only reached
 * AFTER the caller's own shape guard confirmed the response body is
 * recognizably the usage-endpoint shape (a genuinely broken/foreign body
 * never reaches here; the caller discards the whole poll instead):
 *
 *   - `w` absent (null/undefined): the server is deliberately reporting NO
 *     usage recorded in that window (e.g. right after an out-of-band quota
 *     reset wipes the record, or an idle account past the window) — a TRUE
 *     0%, not "unknown". Synthesize a zero window (`resetAt` 0 = no reset
 *     scheduled yet) so dashboards render "0%" instead of "-" ("-" stays
 *     reserved for never-polled accounts). Scoring is unaffected either way:
 *     `utilOf`/`weeklyUrgency` already read a missing window as 0.
 *   - `w` present but its utilization field is missing/non-finite: unusable —
 *     return `null` (NOT 0%) so the scheduler never treats a malformed
 *     response as "full headroom" and ranks the account first.
 *   - otherwise: `clamp01(util / divisor)` plus the provider's own reset
 *     parser (`resetOf`) — the one piece that genuinely differs between
 *     providers (Anthropic's ISO/epoch-seconds/epoch-ms heuristic vs OpenAI's
 *     plain-seconds `secondsToMs`), so it stays a caller-supplied callback
 *     rather than something this helper tries to unify too.
 */
export function endpointWindowFrom<W>(
  w: W | null | undefined,
  utilOf: (w: W) => unknown,
  divisor: number,
  resetOf: (w: W) => number,
): UsageWindow | null {
  if (!w) return { utilization: 0, resetAt: 0 }
  const util = utilOf(w)
  if (!isFiniteNumber(util)) return null
  return { utilization: clamp01(util / divisor), resetAt: resetOf(w) }
}
