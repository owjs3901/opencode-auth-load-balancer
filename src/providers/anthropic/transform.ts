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
  // `parsed` is freshly produced by `JSON.parse(body)` in `rewriteRequestBody`
  // (sole caller, codegraph verified) and never aliased, so mutating its
  // `tools` / `messages` / `content` arrays in place is safe. The PREVIOUS
  // shape allocated a brand new outer `tools` array (with a fresh shallow-copy
  // per tool, even when `tool.name` was missing), a brand new outer `messages`
  // array, AND a brand new `content` array per message (via `.map`) even when
  // no block needed renaming — per request on the inference hot path. Now the
  // only remaining allocation is the shallow clone of each tool_use block that
  // actually needs a renamed copy (element REPLACEMENT in the content array,
  // never mutation of the block object itself — mutating `block.name` would
  // rename the upstream assistant turn's recorded tool name).
  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools as {
      name?: string
      [k: string]: unknown
    }[]) {
      if (tool.name) tool.name = prefixName(tool.name)
    }
  }

  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages as {
      content?: Array<{ type: string; name?: string; [k: string]: unknown }>
      [k: string]: unknown
    }[]) {
      if (Array.isArray(msg.content)) {
        const content = msg.content
        for (let i = 0; i < content.length; i++) {
          const block = content[i]
          if (block?.type === 'tool_use' && block.name)
            content[i] = { ...block, name: prefixName(block.name) }
        }
      }
    }
  }

  return JSON.stringify(parsed)
}

/**
 * Runs once per SSE chunk (createStrippedStream's pull loop), so the regex is
 * hoisted to module scope to avoid re-creating the RegExp object per chunk.
 * Sharing one `/g` instance is safe here: `String.prototype.replace` resets
 * `lastIndex` before scanning, leaving no cross-call state.
 */
const MCP_TOOL_NAME_RE = /"name"\s*:\s*"mcp_([^"]+)"/g

/** Strip the tool prefix from tool names in streaming response text. */
export function stripToolPrefix(text: string): string {
  return text.replace(
    MCP_TOOL_NAME_RE,
    (_m, name: string) => `"name": "${unprefixName(name)}"`,
  )
}

/**
 * `rewriteUrl` calls this on EVERY Anthropic request (sole call site, codegraph
 * verified), and the result is fully determined by the raw `ANTHROPIC_BASE_URL`
 * string. Cache the parsed URL keyed by that raw value so the hot path skips a
 * `new URL(...)` + validation per request whenever the env hasn't changed. The
 * cache also stores `raw === undefined` so an UNSET env caches a `null` result
 * (no re-trim per request). Invalidation is the natural consequence of keying
 * by `raw` — if the env value changes (including being cleared), the next
 * lookup misses and reseats the cache. `rewriteUrl` only reads
 * `baseUrl.protocol` / `baseUrl.host` (never mutates), so sharing one cached
 * `URL` instance across calls is safe.
 */
let cachedBase: { raw: string | undefined; url: URL | null } | null = null
function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (cachedBase && cachedBase.raw === raw) return cachedBase.url
  let url: URL | null = null
  if (raw) {
    try {
      const baseUrl = new URL(raw)
      if (
        (baseUrl.protocol === 'http:' || baseUrl.protocol === 'https:') &&
        !baseUrl.username &&
        !baseUrl.password
      ) {
        url = baseUrl
      }
    } catch {
      /* invalid URL → cached as null */
    }
  }
  cachedBase = { raw, url }
  return url
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

/**
 * Hoisted to module scope (same rationale as `MCP_TOOL_NAME_RE` above):
 * `sanitizeSystemText` runs once per system block per Anthropic request, and an
 * inline literal re-creates the RegExp object on every call. No `/g` flag, so
 * `split` leaves no cross-call state and sharing one instance is safe.
 */
const PARAGRAPH_SPLIT_RE = /\n\n+/

function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(PARAGRAPH_SPLIT_RE)
  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) return false
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }
    return true
  })

  let result = filtered.join('\n\n')
  for (const rule of TEXT_REPLACEMENTS)
    // replaceAll (not replace) so EVERY occurrence of each branded fingerprint
    // phrase is rewritten — matching the upstream reference's `allOccurrences`
    // semantics. A system prompt mentioning the branded phrase twice would
    // otherwise leave the second copy intact and risk a disguised 400.
    // `rule.match` is a literal string, so this is a safe global literal replace.
    result = result.replaceAll(rule.match, rule.replacement)
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
    const block: SystemBlock = {
      ...system,
      type,
      text: sanitizeSystemText(text),
    }
    // Identity dedup, symmetric with the string branch above and the array
    // branch below: a single object already carrying the identity text must
    // not have a second identity block prepended. Keep the caller's extra
    // fields (array-branch semantics).
    if (block.text === CLAUDE_CODE_IDENTITY) return [block]
    return [identityBlock, block]
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
        ? buildBillingHeaderValue(messages, CLAUDE_CODE_ENTRYPOINT)
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

  // Longer than any "name":"mcp_<name>" literal opencode produces today
  // (incl. mcp_StructuredOutput at 28 chars). The regex requires the closing
  // `"` — so a tail of this many chars at each chunk boundary guarantees a
  // straddled pattern lands fully buffered for the next iteration's strip.
  const TAIL_MAX = 64
  let tail = ''

  const stream = new ReadableStream({
    async pull(controller) {
      // Pull MUST emit or close on every invocation: per the WHATWG Streams
      // spec, when pull resolves without enqueueing/closing, the controller
      // only re-calls it if `pullAgain` was set during the pull — which only
      // happens if a NEW read request arrives mid-pull. With one consumer
      // (the SSE reader), the pending read request that triggered THIS pull
      // does not re-arm pullAgain, so a no-op return would deadlock the
      // stream. Hence the read loop: keep draining the upstream until we
      // either have enough buffered to emit (stripped > TAIL_MAX) or the
      // upstream signals done.
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          // Terminal flush (WHATWG streaming contract): every chunk above was
          // decoded with { stream: true }, so bytes of a multi-byte UTF-8
          // character straddling the FINAL chunk boundary are still buffered
          // in the decoder. Flushing surfaces them (as U+FFFD for an
          // incomplete sequence) instead of silently dropping them.
          tail += decoder.decode()
          if (tail) controller.enqueue(encoder.encode(tail))
          tail = ''
          controller.close()
          return
        }
        const stripped = stripToolPrefix(
          tail + decoder.decode(value, { stream: true }),
        )
        if (stripped.length > TAIL_MAX) {
          const emit = stripped.slice(0, stripped.length - TAIL_MAX)
          tail = stripped.slice(stripped.length - TAIL_MAX)
          controller.enqueue(encoder.encode(emit))
          return
        }
        tail = stripped
      }
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
