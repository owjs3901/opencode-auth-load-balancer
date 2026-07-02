import { ignore } from '../util'

/**
 * Shared HTTP shell for the provider usage endpoints (Anthropic `/usage`,
 * OpenAI `/wham/usage`): GET with a timeout, null on ANY failure — network
 * throw/timeout, non-ok status (body cancelled so the connection is released),
 * or a 200 whose body is not JSON. Providers keep only their own headers,
 * shape guards, and window mapping; the transport contract lives here ONCE.
 */
export async function fetchUsageJson<T>(
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
