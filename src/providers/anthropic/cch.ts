import { createHash } from 'node:crypto'

import { setBounded } from '../../util'
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
      // `typeof … === 'string'` (not `|| ''`): a truthy non-string `text`
      // (e.g. `{type:'text', text: 5}`) would flow into
      // `createHash().update(5)` and throw inside computeCCH — the same
      // swallowed-TypeError transform-disable failure as a null block.
      if (block?.type === 'text')
        return typeof block.text === 'string' ? block.text : ''
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
  text: string,
  version: string = CLAUDE_CODE_VERSION,
): string {
  const chars = CCH_POSITIONS.map((index) => text[index] || '0').join('')
  return createHash('sha256')
    .update(`${CCH_SALT}${chars}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Bounded memo (same eviction helper as `sanitizeCache` in
 * `providers/anthropic/transform.ts`): the header is fully determined by the
 * FIRST user message's text — constant across every turn of a conversation —
 * and the entrypoint, yet each request would otherwise re-run two SHA-256
 * hashes (one over the full message text, which can be pasted-file-sized). A
 * `Map` (not a one-slot memo) because this plugin load-balances MULTIPLE
 * concurrent sessions/accounts through one process — an orchestrator session
 * plus parallel subagent sessions all issue requests through the same
 * process, each with a different first-user-message text. A one-slot cache
 * would thrash to ~0% hit rate under that interleaving; the `\u0000`-joined
 * key keeps `entrypoint` and `text` from colliding across the boundary. Tiny
 * cap with clear-on-full keeps worst-case memory bounded (mirrors
 * `sanitizeCache`'s cap of 8 and `notify.ts`'s `lastFallbackToasted` cap of
 * 256).
 */
const CACHED_HEADER_MAX = 32
const cachedHeader = new Map<string, string>()

/**
 * Build the complete billing header string for insertion into system[0], or
 * null when no user-role message exists (the single prefix scan here is both
 * the has-user-message gate and the text-extraction source).
 * A user message that exists but yields empty text still produces a header.
 * Closure-free loop (not Array.find) — runs once per Anthropic request.
 */
export function buildBillingHeaderValue(
  // Elements may be null/undefined: the array comes straight from an untrusted
  // JSON.parse'd body, and a null element would otherwise throw at
  // `message.role` BEFORE any guard — swallowed by rewriteRequestBody's catch,
  // silently disabling the whole Claude-Code transform (opaque upstream 400).
  messages: (Message | null | undefined)[],
  entrypoint: string,
): string | null {
  let userMsg: Message | undefined
  for (const message of messages) {
    if (message?.role === 'user') {
      userMsg = message
      break
    }
  }
  if (!userMsg) return null

  const text = messageText(userMsg)
  const key = `${entrypoint}\u0000${text}`
  const hit = cachedHeader.get(key)
  if (hit !== undefined) return hit
  const suffix = computeVersionSuffix(text)
  const cch = computeCCH(text)
  const value =
    'x-anthropic-billing-header: ' +
    `cc_version=${CLAUDE_CODE_VERSION}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=${cch};`
  setBounded(cachedHeader, key, value, CACHED_HEADER_MAX)
  return value
}
