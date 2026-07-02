import { createHash } from 'node:crypto'

import { joinBlockTexts } from './util'

/**
 * Header carrying opencode's session id. Injected by the plugin's `chat.headers`
 * hook (which has the real sessionID) and read back here in the load-balanced
 * fetch. Stripped before the request leaves for the provider.
 */
export const SESSION_HEADER = 'x-allb-session'

/**
 * Find the first user message's text in a messages/input list. Lifted to module
 * scope (like `parseHeaderWindow` / `windowFromPercent`) so we don't reallocate a
 * closure per call. Captures NOTHING from its caller — only its `list` argument
 * and the shared `joinBlockTexts`.
 */
function firstUserFromList(list: unknown): string | null {
  if (!Array.isArray(list)) return null
  const messages = list as { role?: string; content?: unknown }[]
  // Closure-free first-match loop (not `.find`) — same convention as the
  // walkers in cch.ts / select.ts; runs per request on the body-hash fallback.
  for (const m of messages) {
    if (m && m.role === 'user') return joinBlockTexts(m.content, '')
  }
  return null
}

/** Extract the first user message text from an Anthropic or OpenAI-Responses body. */
function firstUserText(parsed: Record<string, unknown>): string {
  return (
    firstUserFromList(parsed.messages) ?? firstUserFromList(parsed.input) ?? ''
  )
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
    const sys = parsed.system
    let systemText: string
    if (typeof sys === 'string') systemText = sys
    else if (typeof parsed.instructions === 'string')
      systemText = parsed.instructions
    else systemText = JSON.stringify(sys ?? '')
    const hash = createHash('sha256')
      .update(systemText)
      .update('\u0000')
      .update(firstUserText(parsed))
      .digest('hex')
      .slice(0, 16)
    return `b:${hash}`
  } catch {
    return null
  }
}
