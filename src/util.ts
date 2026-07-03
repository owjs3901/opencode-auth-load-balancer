import { MAX_QUOTA_RESET_BOUND_MS } from './providers/http-timeouts'

/** Shared no-op for swallowing rejected promises / throwaway callbacks. */
export const ignore = (): undefined => undefined

/** Shared async sleep — used by the pool's lock-retry and atomic-rename loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Abortable sleep. Resolves after `ms`, or rejects with the signal's abort reason the
 * moment `signal` aborts — so a request waiting out a rate-limit cooldown (see fetch.ts)
 * wakes IMMEDIATELY when opencode cancels the turn instead of blocking the full delay.
 * Falls back to the plain `sleep` when no signal is given. The abort reason is propagated
 * untouched (a DOMException named `AbortError` by default), which fetch.ts recognizes as
 * a client abort and re-throws rather than treating as the account's fault.
 */
export function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  const delay = Math.max(0, ms)
  if (!signal) return sleep(delay)
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal.addEventListener('abort', onAbort, { once: true })
  })
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
 * Type guard: a real, finite number (rejects NaN/±Infinity AND non-numbers).
 * Shared by both providers' `endpointWindow` malformed-window checks, where
 * the `v is number` narrowing also handles optional fields. NOTE:
 * `tui/auth-load-balancer-tui.logic.ts` ships its OWN `isFiniteNumber` copy
 * by design — the TUI runtime cannot import `src/`.
 */
export function isFiniteNumber(v: unknown): v is number {
  return Number.isFinite(v)
}

/**
 * True for a plain JSON object (non-null `object`, not an array). Shared
 * trust-boundary predicate for the two consumers that accept arbitrary JSON
 * shapes: the user-editable pool file's `lastSelected` / `sessions`
 * containers and session rows (`pool/store.ts`), and the incoming `system`
 * prompt blocks in the Anthropic request transform
 * (`providers/anthropic/transform.ts`). NOTE:
 * `tui/auth-load-balancer-tui.logic.ts` ships its OWN `isPlainRecordValue`
 * copy by design — the TUI runtime cannot import `src/`.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Collect the `text` of every content block into one string. A message's
 * `content` arrives as either a plain string (passed through) or an array of
 * blocks (anything else → ''); each block contributes its `text` when it is a
 * string, and non-empty texts are joined with `separator`. Shared by the
 * session-key hasher (`session.ts`, `''` join) and the Codex instructions
 * lifter (`providers/openai/transform.ts`, `'\n'` join) — previously two
 * copy-pasted 15-line walkers. NOTE: `providers/anthropic/cch.ts`'s
 * `messageText` is deliberately different (FIRST text block only) — not this.
 */
export function joinBlockTexts(content: unknown, separator: string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const t =
      block &&
      typeof block === 'object' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : ''
    if (t) out = out ? out + separator + t : t
  }
  return out
}

/**
 * Set `key`→`value` on a bounded `Map`, clearing it first once it is already
 * at `max` — a "clear-on-full" cache eviction with no LRU bookkeeping,
 * appropriate for the three call sites that only need a rough memory cap, not
 * exact recency: `sanitizeCache` in `providers/anthropic/transform.ts`,
 * `cachedHeader` in `providers/anthropic/cch.ts`, and `lastFallbackToasted`
 * in `notify.ts`. The first two were previously the same 2-line
 * `if (map.size >= max) map.clear(); map.set(key, value)` block, each
 * commented as duplicating the other — this is that logic unified. Each call
 * site keeps its own cap constant and key/value semantics; only the eviction
 * mechanics are shared.
 */
export function setBounded<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  max: number,
): void {
  if (map.size >= max) map.clear()
  map.set(key, value)
}

/**
 * A single-slot memo keyed by a raw value compared with `===`. Returns a
 * closure that recomputes only when the key changes since the last call —
 * the "cache the value derived from a raw env/token string, keyed by that
 * string" pattern previously hand-rolled four separate times across the
 * Anthropic provider module (`mergeBetaHeaders`/`resolveBaseUrl` in
 * `providers/anthropic/transform.ts`, `resolveFamilyOrder`/
 * `resolveFallbackSetting` in `providers/anthropic/fallback.ts`). Each
 * caller keeps any fast-path early return (e.g. "no raw value at all")
 * BEFORE calling into this memo — the memo only covers the "check cache,
 * else compute and reseat" part. NOTE: `providers/openai/jwt.ts`'s
 * `resolveAccountId` needed a MULTI-slot `Map` variant instead of this
 * (a one-slot memo thrashes there because the plugin decodes MULTIPLE
 * OpenAI accounts' access tokens concurrently — see that file's own
 * `decodedAccountIdCache` doc comment). `src/scheduler/score-core.ts`
 * deliberately does NOT use this either — that file is byte-copied into
 * `tui/auth-load-balancer-scoring.ts` and must stay dependency-free.
 */
export function memoOne<K, V>(compute: (key: K) => V): (key: K) => V {
  let cache: { key: K; value: V } | null = null
  return (key: K): V => {
    if (cache && cache.key === key) return cache.value
    const value = compute(key)
    cache = { key, value }
    return value
  }
}

/**
 * True when `candidateMs` (an absolute epoch-ms reset timestamp) sits further
 * in the future than `MAX_QUOTA_RESET_BOUND_MS` past the real wall clock — used to
 * reject a FINITE-but-absurd reset (e.g. a corrupted proxy emitting
 * `99999999999` seconds ≈ year 5138) that would otherwise silently become the
 * account's `resetAt`, permanently near-zero-ranking it in `weeklyUrgency`
 * (days² in the denominator) and printing a nonsensical "115200d" countdown.
 * Shared by `secondsToMs` (below) and Anthropic's `parseResetAt`
 * (providers/anthropic/usage.ts), which cannot delegate to `secondsToMs`
 * itself (different seconds-vs-ms-vs-ISO-string semantics) but needs the
 * exact same "how far in the future is too far" guard. Reads the REAL wall
 * clock (not an injected `now`) because every caller parses a response/
 * endpoint payload at essentially the moment it arrives — there is no
 * meaningful test-injectable `now` to thread through the provider
 * `parseUsageHeaders`/endpoint-parsing call chain the way `cooldownUntilFrom`
 * (fetch.ts) threads an already-captured `now`. A value in the PAST always
 * passes (returns false) — an elapsed reset is simply "expired", handled
 * elsewhere (`isWindowExpired`), not a broken-clock symptom.
 */
export function isImplausiblyFarFuture(candidateMs: number): boolean {
  return candidateMs - Date.now() > MAX_QUOTA_RESET_BOUND_MS
}

/**
 * Convert epoch-seconds → epoch-ms while rejecting non-finite/zero/negative inputs,
 * the `Number.MAX_VALUE`-overflow case (`1e308` is finite but `1e308 * 1000`
 * collapses to +Infinity), AND a finite-but-implausibly-far-future reset (see
 * `isImplausiblyFarFuture`) — any of which would silently commit a corrupt value to
 * `pool.usage.{hourly,weekly}.resetAt`, breaking `isWindowExpired`, `weeklyUrgency`,
 * and `relTime` rendering. Returns 0 to signal "no usable reset". Mirrors
 * `cooldownUntilFrom`'s retry-after guard in `fetch.ts` (cooldown's
 * `until = now + delta` shape differs, so it is NOT folded in here). Used by both
 * provider header parsers and the OpenAI endpoint helper. Anthropic's `parseResetAt`
 * ms-vs-seconds heuristic (`value > 1e12`) intentionally stays separate — different
 * semantics.
 */
export function secondsToMs(resetSec: number): number {
  if (!Number.isFinite(resetSec) || resetSec <= 0) return 0
  const ms = resetSec * 1000
  if (!Number.isFinite(ms)) return 0
  return isImplausiblyFarFuture(ms) ? 0 : ms
}
