/** Shared no-op for swallowing rejected promises / throwaway callbacks. */
export const ignore = (): undefined => undefined

/** Shared async sleep — used by the pool's lock-retry and atomic-rename loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Clamp a number into [0, 1], treating NaN/Infinity as 0. Used by both provider
 * usage parsers to normalize header/endpoint utilization into the contract the
 * scheduler expects (a finite fraction). NOTE: `src/scheduler/score-core.ts` ships
 * its OWN identical clamp01 by design — that file is byte-copied into
 * `tui/auth-load-balancer-scoring.ts` and MUST stay dependency-free (enforced by
 * `tui-scoring-sync.test.ts`), so this helper covers the providers only.
 */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Convert epoch-seconds → epoch-ms while rejecting non-finite/zero/negative inputs
 * AND the `Number.MAX_VALUE`-overflow case: `1e308` is finite but `1e308 * 1000`
 * collapses to +Infinity, which would silently commit Infinity to
 * `pool.usage.{hourly,weekly}.resetAt` — breaking `isWindowExpired` (never
 * expires), `weeklyUrgency` (drainable / Infinity = 0 urgency, account sidelined
 * forever), and `relTime` rendering ('InfinitydNaNh' in the TUI / CLI). Returns
 * 0 to signal "no usable reset". Mirrors `applyCooldown`'s retry-after guard in
 * `fetch.ts` (cooldown's `until = now + delta` shape differs, so it is NOT
 * folded in here). Used by both provider header parsers and the OpenAI endpoint
 * helper. Anthropic's `parseResetAt` ms-vs-seconds heuristic (`value > 1e12`)
 * intentionally stays separate — different semantics.
 */
export function secondsToMs(resetSec: number): number {
  if (!Number.isFinite(resetSec) || resetSec <= 0) return 0
  const ms = resetSec * 1000
  return Number.isFinite(ms) ? ms : 0
}
