import { ignore } from '../util'

/**
 * Shared HTTP shell for the plugin's read-only JSON GETs — the provider usage
 * endpoints (Anthropic `/usage`, OpenAI `/wham/usage`) and the npm dist-tags
 * lookup behind `providers/anthropic/version.ts`. GET with a timeout, null on
 * ANY failure — network throw/timeout, non-ok status (body cancelled so the
 * connection is released), or a 200 whose body is not JSON. Callers keep only
 * their own headers and shape guards; the transport contract lives here ONCE.
 */
async function request(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }
}

async function readJson<T>(response: Response | null): Promise<T | null> {
  if (!response) return null
  if (!response.ok) {
    await response.body?.cancel().catch(ignore)
    return null
  }

  return (await response.json().catch(() => null)) as T | null
}

export async function fetchJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T | null> {
  return readJson<T>(await request(url, headers, timeoutMs))
}

export class UsageAuthenticationError extends Error {
  readonly status = 401

  constructor() {
    super('Usage endpoint rejected the access token (401)')
    this.name = 'UsageAuthenticationError'
  }
}

export async function fetchUsageJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T | null> {
  const response = await request(url, headers, timeoutMs)
  if (response?.status === 401) {
    await response.body?.cancel().catch(ignore)
    throw new UsageAuthenticationError()
  }
  return readJson<T>(response)
}
