import { ignore } from '../util'

/**
 * Shared HTTP shell for the plugin's read-only JSON GETs — the provider usage
 * endpoints (Anthropic `/usage`, OpenAI `/wham/usage`) and the npm dist-tags
 * lookup behind `providers/anthropic/version.ts`. GET with a timeout, null on
 * ANY failure — network throw/timeout, non-ok status (body cancelled so the
 * connection is released), or a 200 whose body is not JSON. Callers keep only
 * their own headers and shape guards; the transport contract lives here ONCE.
 */
export async function fetchJson<T>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<T | null> {
  let response: Response
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    return null
  }

  if (!response.ok) {
    await response.body?.cancel().catch(ignore)
    return null
  }

  return (await response.json().catch(() => null)) as T | null
}
