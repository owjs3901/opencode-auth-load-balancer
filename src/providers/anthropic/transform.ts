import { ignore } from '../../util'
import type { FetchInput } from '../types'
import { buildBillingHeaderValue } from './cch'
import {
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
  USER_AGENT,
} from './constants'

/**
 * Claude Code request shaping, vendored from ex-machina-co/opencode-anthropic-auth.
 *
 * OAuth (subscription) requests to /v1/messages are only accepted when they look
 * like they came from Claude Code: the system prompt must lead with the exact
 * Claude Code identity block, tool names are prefixed, and OpenCode-identifying
 * strings are stripped. Without these the API returns opaque 400s.
 */

function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function unprefixName(name: string): string {
  if (name === 'StructuredOutput') return name
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

/** Merge incoming beta headers with the required OAuth betas, deduplicating. */
export function mergeBetaHeaders(headers: Headers): string {
  const incoming = (headers.get('anthropic-beta') || '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)
  return [...new Set([...REQUIRED_BETAS, ...incoming])].join(',')
}

/** Set OAuth auth + Claude Code headers; remove x-api-key (we use Bearer). */
export function setOAuthHeaders(headers: Headers, accessToken: string): void {
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('anthropic-beta', mergeBetaHeaders(headers))
  headers.set('user-agent', USER_AGENT)
  headers.delete('x-api-key')
}

function prefixToolNames(parsed: Record<string, unknown>): string {
  if (Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(
      (tool: { name?: string; [k: string]: unknown }) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }),
    )
  }

  if (Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(
      (msg: {
        content?: Array<{ type: string; name?: string; [k: string]: unknown }>
        [k: string]: unknown
      }) => {
        if (Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) =>
            block.type === 'tool_use' && block.name
              ? { ...block, name: prefixName(block.name) }
              : block,
          )
        }
        return msg
      },
    )
  }

  return JSON.stringify(parsed)
}

/** Strip the tool prefix from tool names in streaming response text. */
export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_m, name: string) => `"name": "${unprefixName(name)}"`,
  )
}

function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const baseUrl = new URL(raw)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

/** Add ?beta=true for /v1/messages, and honor ANTHROPIC_BASE_URL overrides. */
export function rewriteUrl(input: FetchInput): FetchInput {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }
  if (!requestUrl) return input

  const originalHref = requestUrl.href
  const baseUrl = resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
  }
  if (
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }
  if (requestUrl.href === originalHref) return input

  return input instanceof Request
    ? new Request(requestUrl.toString(), input)
    : requestUrl
}

function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/)
  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) return false
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }
    return true
  })

  let result = filtered.join('\n\n')
  for (const rule of TEXT_REPLACEMENTS)
    result = result.replace(rule.match, rule.replacement)
  return result.trim()
}

interface SystemBlock {
  type: string
  text: string
  [k: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }
  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    const type = typeof system.type === 'string' ? system.type : 'text'
    const text = typeof system.text === 'string' ? system.text : ''
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === 'string')
      return { type: 'text', text: sanitizeSystemText(item) }
    if (
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      return { ...item, type: 'text', text: sanitizeSystemText(item.text) }
    }
    return { type: 'text', text: String(item) }
  })

  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) return sanitized
  return [identityBlock, ...sanitized]
}

/** Rewrite the request body: sanitize system prompt, inject billing header, prefix tools. */
export function rewriteRequestBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const messages = Array.isArray(parsed.messages)
      ? (parsed.messages as { role?: string }[])
      : null
    const billingHeader =
      messages && messages.some((m) => m.role === 'user')
        ? buildBillingHeaderValue(messages, undefined, CLAUDE_CODE_ENTRYPOINT)
        : null

    const system = prependClaudeCodeIdentity(parsed.system)
    if (billingHeader) system.unshift({ type: 'text', text: billingHeader })
    parsed.system = system

    return prefixToolNames(parsed)
  } catch {
    return body
  }
}

/** Wrap a streaming response so tool prefixes are stripped from emitted text. */
export function createStrippedStream(response: Response): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      const text = stripToolPrefix(decoder.decode(value, { stream: true }))
      controller.enqueue(encoder.encode(text))
    },
    cancel(reason) {
      // Without this, a downstream cancel (opencode aborting the turn, the
      // session ending, the user pressing Esc mid-stream) leaves the upstream
      // reader's lock held — the fetch socket stays open until GC or upstream
      // timeout. Forwarding it releases the connection promptly.
      void reader.cancel(reason).catch(ignore)
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
