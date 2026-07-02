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
    initHeaders.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (Array.isArray(initHeaders)) {
    for (const entry of initHeaders) {
      const [key, value] = entry as [string, unknown]
      if (value !== undefined) headers.set(key, String(value))
    }
  } else {
    for (const [key, value] of Object.entries(initHeaders)) {
      if (value !== undefined) headers.set(key, String(value))
    }
  }

  return headers
}
