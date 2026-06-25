import { describe, expect, test } from 'bun:test'

import { extractAccountId } from '../providers/openai/jwt'
import { generatePKCE } from '../providers/openai/pkce'
import {
  applyAuth,
  rewriteRequestBody,
  rewriteUrl,
} from '../providers/openai/transform'
import type { PoolAccount } from '../types'

function acct(accountId: string | null): PoolAccount {
  return {
    id: 'x',
    providerID: 'openai',
    label: 'x',
    access: 'tokO',
    refresh: 'r',
    expires: 0,
    accountId,
    usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: 0,
    lastUsedAt: 0,
  }
}

function jwt(claims: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
}

describe('applyAuth', () => {
  test('sets bearer + codex headers and drops x-api-key', () => {
    const h = new Headers({ 'x-api-key': 'remove', authorization: 'old' })
    applyAuth(h, acct('acc_1'))
    expect(h.get('authorization')).toBe('Bearer tokO')
    expect(h.get('chatgpt-account-id')).toBe('acc_1')
    expect(h.get('openai-beta')).toBe('responses=experimental')
    expect(h.get('originator')).toBe('opencode')
    expect(h.get('user-agent')).toBeTruthy()
    expect(h.get('session-id')).toBeTruthy()
    expect(h.get('x-api-key')).toBeNull()
  })
  test('omits chatgpt-account-id when the account has none', () => {
    const h = new Headers()
    applyAuth(h, acct(null))
    expect(h.get('chatgpt-account-id')).toBeNull()
  })
})

describe('rewriteUrl', () => {
  test('routes /responses to the codex backend', () => {
    expect(
      rewriteUrl('https://api.openai.com/v1/responses').toString(),
    ).toContain('chatgpt.com/backend-api/codex/responses')
  })
  test('leaves non-/responses paths untouched', () => {
    const input = 'https://api.openai.com/v1/chat/completions'
    expect(rewriteUrl(input)).toBe(input)
  })
  test('rewrites a Request object', () => {
    const req = new Request('https://api.openai.com/v1/responses', {
      method: 'POST',
    })
    const out = rewriteUrl(req)
    expect(out).toBeInstanceOf(Request)
    expect((out as Request).url).toContain('codex/responses')
  })
  test('returns the input unchanged when already the codex endpoint', () => {
    const input = 'https://chatgpt.com/backend-api/codex/responses'
    expect(rewriteUrl(input)).toBe(input)
  })
  test('returns non-URL input untouched', () => {
    expect(rewriteUrl('nope')).toBe('nope')
  })
})

describe('rewriteRequestBody', () => {
  test('applies store:false, encrypted reasoning, lifts system into instructions, drops max tokens', () => {
    const body = JSON.stringify({
      input: [
        { type: 'message', role: 'system', content: 'be terse' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
      max_output_tokens: 1000,
    })
    const out = JSON.parse(rewriteRequestBody(body))
    expect(out.store).toBe(false)
    expect(out.include).toContain('reasoning.encrypted_content')
    expect(out.instructions).toBe('be terse')
    expect(out.max_output_tokens).toBeUndefined()
    expect(
      (out.input as { role?: string }[]).some((i) => i.role === 'system'),
    ).toBe(false)
  })

  test('concatenates existing instructions with lifted system text and dedupes include', () => {
    const body = JSON.stringify({
      instructions: 'base',
      include: ['reasoning.encrypted_content'],
      input: [
        { type: 'message', role: 'system', content: [{ text: 'extra' }] },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    })
    const out = JSON.parse(rewriteRequestBody(body))
    expect(out.instructions).toBe('base\n\nextra')
    expect(
      out.include.filter((i: string) => i === 'reasoning.encrypted_content'),
    ).toHaveLength(1)
  })

  test('falls back to a default instruction when none present', () => {
    const out = JSON.parse(rewriteRequestBody(JSON.stringify({})))
    expect(out.instructions).toBe('You are a helpful assistant.')
    expect(out.store).toBe(false)
  })

  test('handles non-text system content when lifting instructions', () => {
    const body = JSON.stringify({
      input: [
        { type: 'message', role: 'system', content: [{ type: 'image' }] }, // array, no text -> ""
        { type: 'message', role: 'system', content: 42 }, // neither string nor array -> ""
        { type: 'message', role: 'user', content: 'hi' },
      ],
    })
    const out = JSON.parse(rewriteRequestBody(body))
    expect(out.instructions).toBe('You are a helpful assistant.')
  })

  test('returns the original body on invalid JSON', () => {
    expect(rewriteRequestBody('{bad')).toBe('{bad')
  })
})

describe('extractAccountId', () => {
  test('reads the namespaced claim', () => {
    expect(
      extractAccountId(
        jwt({
          'https://api.openai.com/auth': { chatgpt_account_id: 'acc_ns' },
        }),
      ),
    ).toBe('acc_ns')
  })
  test('reads the top-level claim', () => {
    expect(extractAccountId(jwt({ chatgpt_account_id: 'acc_top' }))).toBe(
      'acc_top',
    )
  })
  test('falls back to the first organization id', () => {
    expect(extractAccountId(jwt({ organizations: [{ id: 'org_1' }] }))).toBe(
      'org_1',
    )
  })
  test('returns undefined when no account claim exists', () => {
    expect(extractAccountId(jwt({ sub: 'u' }))).toBeUndefined()
  })
  test('returns undefined for a malformed token', () => {
    expect(extractAccountId('not-a-jwt')).toBeUndefined()
    expect(extractAccountId('h.@@@.s')).toBeUndefined()
  })
})

describe('pkce', () => {
  test('generates a base64url verifier + challenge', async () => {
    const { verifier, challenge } = await generatePKCE()
    expect(verifier).not.toMatch(/[+/=]/)
    expect(challenge).not.toMatch(/[+/=]/)
  })
})
