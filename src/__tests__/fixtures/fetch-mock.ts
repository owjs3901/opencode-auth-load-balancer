/**
 * Shared `globalThis.fetch` test shim. Test files that stub the network with
 * a swappable per-test responder delegate here so the input→url extraction
 * (string | URL | Request) lives in ONE place. Each test file keeps its OWN
 * `let respond: Responder` (bun runs test files in one process — no shared
 * mutable state) and wires `globalThis.fetch = responderFetch(() => respond)`.
 */
export type Responder = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>

export function responderFetch(getRespond: () => Responder): typeof fetch {
  return ((input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    return Promise.resolve(getRespond()(url, init))
  }) as typeof fetch
}
