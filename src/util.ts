/** Shared no-op for swallowing rejected promises / throwaway callbacks. */
export const ignore = (): undefined => undefined

/** Shared async sleep — used by the pool's lock-retry and atomic-rename loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
