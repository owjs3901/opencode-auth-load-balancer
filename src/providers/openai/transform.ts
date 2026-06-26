import type { PoolAccount } from '../../types'
import type { FetchInput } from '../types'
import {
  CODEX_RESPONSES_URL,
  OPENAI_BETA,
  ORIGINATOR,
  SESSION_ID,
  USER_AGENT,
} from './constants'
import { extractAccountId } from './jwt'

/**
 * Codex (ChatGPT-OAuth) request shaping, distilled from the openai/codex CLI,
 * anomalyco/opencode's codex plugin, and the openresponses Go middleware.
 */

/** Set OAuth auth + Codex headers; drop the SDK's dummy key/x-api-key. */
export function applyAuth(headers: Headers, account: PoolAccount): void {
  headers.delete('authorization')
  headers.delete('Authorization')
  headers.delete('x-api-key')
  headers.set('authorization', `Bearer ${account.access}`)
  const accountId = account.accountId ?? extractAccountId(account.access)
  if (accountId) headers.set('chatgpt-account-id', accountId)
  headers.set('openai-beta', OPENAI_BETA)
  headers.set('originator', ORIGINATOR)
  headers.set('user-agent', USER_AGENT)
  headers.set('session-id', SESSION_ID)
}

/** Rewrite Responses-API requests to the Codex backend; leave others untouched. */
export function rewriteUrl(input: FetchInput): FetchInput {
  let url: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL)
      url = new URL(input.toString())
    else if (input instanceof Request) url = new URL(input.url)
  } catch {
    return input
  }
  if (!url) return input
  if (!url.pathname.includes('/responses')) return input

  const target = new URL(CODEX_RESPONSES_URL)
  if (url.href === target.href) return input
  return input instanceof Request
    ? new Request(target.toString(), input)
    : target
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block &&
      typeof block === 'object' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? (block as { text: string }).text
        : '',
    )
    .filter(Boolean)
    .join('\n')
}

interface InputItem {
  type?: string
  role?: string
  content?: unknown
}

/**
 * The Codex backend rejects empty `instructions`. Lift any system messages out of
 * the `input` array into a non-empty `instructions` string.
 */
function applyInstructions(obj: Record<string, unknown>): void {
  let instructions =
    typeof obj.instructions === 'string' ? obj.instructions : ''

  if (Array.isArray(obj.input)) {
    const systemTexts: string[] = []
    const remaining: InputItem[] = []
    for (const raw of obj.input as InputItem[]) {
      if (raw && raw.type === 'message' && raw.role === 'system') {
        const text = extractText(raw.content)
        if (text) systemTexts.push(text)
      } else {
        remaining.push(raw)
      }
    }
    if (systemTexts.length > 0) {
      instructions = [instructions, ...systemTexts].filter(Boolean).join('\n\n')
    }
    obj.input = remaining
  }

  obj.instructions = instructions.trim() || 'You are a helpful assistant.'
}

/**
 * Apply the mandatory Codex backend body quirks:
 *   - store: false                 (backend rejects true)
 *   - include += reasoning.encrypted_content  (preserve CoT across turns)
 *   - non-empty instructions
 *   - drop max_output_tokens       (match codex cli)
 */
export function rewriteRequestBody(body: string): string {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>

    obj.store = false

    const include = Array.isArray(obj.include) ? (obj.include as string[]) : []
    obj.include = [...new Set([...include, 'reasoning.encrypted_content'])]

    applyInstructions(obj)
    delete obj.max_output_tokens

    return JSON.stringify(obj)
  } catch {
    return body
  }
}
