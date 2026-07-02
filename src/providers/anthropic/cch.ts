import { createHash } from 'node:crypto'

import { CCH_POSITIONS, CCH_SALT, CLAUDE_CODE_VERSION } from './constants'

interface Message {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

/** Extract text from a message's first text block. */
function messageText({ content }: Message): string {
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    // Closure-free loop (not Array.find): this runs once per Anthropic request
    // via rewriteRequestBody — same hot-path convention as selectAccount /
    // findPinned. Semantics preserved exactly: the FIRST text-type block
    // decides (a later block's text must not win when the first one is empty).
    // `block?.type`, not `block.type`: the body is JSON.parse'd from an
    // untrusted string, so a `null` element here would throw a TypeError
    // that rewriteRequestBody's catch swallows — silently disabling the
    // WHOLE Claude-Code transform for that request (no identity block, no
    // billing header, no tool prefixing → opaque upstream 400). Matches the
    // `block?.type` guard in transform.ts's prefixToolNames.
    for (const block of content) {
      if (block?.type === 'text') return block.text || ''
    }
  }

  return ''
}

/** Compute cch: first 5 hex characters of SHA-256(messageText). */
export function computeCCH(messageText: string): string {
  return createHash('sha256').update(messageText).digest('hex').slice(0, 5)
}

/** Compute the 3-char version suffix from the sampled message characters. */
export function computeVersionSuffix(
  messageText: string,
  version: string = CLAUDE_CODE_VERSION,
): string {
  const chars = CCH_POSITIONS.map((index) => messageText[index] || '0').join('')
  return createHash('sha256')
    .update(`${CCH_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * One-slot memo (same pattern as `cachedDecode` in openai/jwt.ts): the header
 * is fully determined by the FIRST user message's text — constant across every
 * turn of a conversation — and the entrypoint, yet each request would
 * otherwise re-run two SHA-256 hashes (one over the full message text, which
 * can be pasted-file-sized). The keying string compare is O(n) but ~10× cheaper
 * per byte than hashing, and hits on every follow-up turn.
 */
let cachedHeader: { text: string; entrypoint: string; value: string } | null =
  null

/**
 * Build the complete billing header string for insertion into system[0], or
 * null when no user-role message exists (the single prefix scan here is both
 * the has-user-message gate and the text-extraction source).
 * A user message that exists but yields empty text still produces a header.
 * Closure-free loop (not Array.find) — runs once per Anthropic request.
 */
export function buildBillingHeaderValue(
  messages: Message[],
  entrypoint: string,
): string | null {
  let userMsg: Message | undefined
  for (const message of messages) {
    if (message.role === 'user') {
      userMsg = message
      break
    }
  }
  if (!userMsg) return null

  const text = messageText(userMsg)
  if (
    cachedHeader &&
    cachedHeader.text === text &&
    cachedHeader.entrypoint === entrypoint
  )
    return cachedHeader.value
  const suffix = computeVersionSuffix(text)
  const cch = computeCCH(text)
  const value =
    'x-anthropic-billing-header: ' +
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=${cch};`
  cachedHeader = { text, entrypoint, value }
  return value
}
