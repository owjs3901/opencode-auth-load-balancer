import { createHash } from 'node:crypto'

/**
 * Header carrying opencode's session id. Injected by the plugin's `chat.headers`
 * hook (which has the real sessionID) and read back here in the load-balanced
 * fetch. Stripped before the request leaves for the provider.
 */
export const SESSION_HEADER = 'x-allb-session'

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) =>
      b &&
      typeof b === 'object' &&
      typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : '',
    )
    .join('')
}

/** Extract the first user message text from an Anthropic or OpenAI-Responses body. */
function firstUserText(parsed: Record<string, unknown>): string {
  const lists = [parsed.messages, parsed.input].filter(Array.isArray) as Array<
    { role?: string; content?: unknown }[]
  >
  for (const list of lists) {
    const user = list.find((m) => m && m.role === 'user')
    if (user) return textOf(user.content)
  }
  return ''
}

/**
 * Derive a stable key identifying the conversation a request belongs to.
 *
 * Prefers the real opencode session id (via the SESSION_HEADER). Falls back to a
 * hash of the request's stable prefix (system prompt + first user message), which
 * is constant across the turns of one conversation. Returns null when neither is
 * available (selection then proceeds without affinity).
 */
export function deriveSessionKey(
  headers: Headers,
  body: string | undefined,
): string | null {
  const fromHeader = headers.get(SESSION_HEADER)
  if (fromHeader) return `s:${fromHeader}`
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const system =
      typeof parsed.system === 'string'
        ? parsed.system
        : typeof parsed.instructions === 'string'
          ? parsed.instructions
          : JSON.stringify(parsed.system ?? '')
    const hash = createHash('sha256')
      .update(system)
      .update('\u0000')
      .update(firstUserText(parsed))
      .digest('hex')
      .slice(0, 16)
    return `b:${hash}`
  } catch {
    return null
  }
}
