import type { FetchInput } from './types'

/**
 * Merge headers from a Request object and/or a RequestInit headers value into a
 * single Headers instance. Provider-agnostic; used by the core fetch before
 * handing the Headers to an adapter's applyAuth.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers =
    input instanceof Request ? new Headers(input.headers) : new Headers()

  const initHeaders = init?.headers
  if (!initHeaders) return headers

  if (initHeaders instanceof Headers) {
    // Closure-free loop on the per-request hot path (see src/session.ts) —
    // Headers is iterable per WHATWG fetch, yielding [name, value] pairs.
    for (const [key, value] of initHeaders) headers.set(key, value)
  } else if (Array.isArray(initHeaders)) {
    // `Array.isArray` narrows to `string[][]`; under noUncheckedIndexedAccess
    // destructuring gives `string | undefined` for both positions, so a plain
    // undefined guard types cleanly — no cast, no String() re-coercion.
    for (const [key, value] of initHeaders) {
      if (key !== undefined && value !== undefined) headers.set(key, value)
    }
  } else {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (value !== undefined) headers.set(key, String(value))
    }
  }

  return headers
}
