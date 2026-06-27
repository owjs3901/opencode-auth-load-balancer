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
