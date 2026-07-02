import { describe, expect, test } from 'bun:test'

import { extractAccountId } from '../providers/openai/jwt'
import {
  applyAuth,
  rewriteRequestBody,
  rewriteUrl,
} from '../providers/openai/transform'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'

function acct(accountId: string | null): PoolAccount {
  return testAccount({ providerID: 'openai', access: 'tokO', accountId })
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
  test('applyAuth falls back to extracting chatgpt-account-id from the access-token JWT when account.accountId is null', () => {
    const h = new Headers()
    applyAuth(h, {
      ...acct(null),
      access: jwt({ chatgpt_account_id: 'acc_jwt' }),
    })
    expect(h.get('chatgpt-account-id')).toBe('acc_jwt')
  })
  test('memoizes the JWT accountId decode across attempts with the same access token', () => {
    // Repeat call with the same access token exercises the one-slot memo hit
    // path in resolveAccountId (same pattern as the mergeBetaHeaders memo);
    // a DIFFERENT token must miss the memo and re-decode.
    const account = { ...acct(null), access: jwt({ chatgpt_account_id: 'm1' }) }
    const h1 = new Headers()
    applyAuth(h1, account)
    const h2 = new Headers()
    applyAuth(h2, account)
    expect(h2.get('chatgpt-account-id')).toBe('m1')
    const h3 = new Headers()
    applyAuth(h3, { ...account, access: jwt({ chatgpt_account_id: 'm2' }) })
    expect(h3.get('chatgpt-account-id')).toBe('m2')
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
    // Lock: stray system messages whose content yields NO extractable text must
    // STILL be removed from `input` — the function's docstring promises to "Lift
    // any system messages out of the input array". Pre-fix the `if
    // (systemTexts.length > 0)` gate guarded BOTH the instructions concat AND the
    // `obj.input = remaining` assignment, so a request with ONLY empty-text
    // systems left them in `input` alongside the user message, leaking stray
    // system entries to the Codex backend.
    expect(
      (out.input as { role?: string }[]).some((i) => i.role === 'system'),
    ).toBe(false)
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
  test('rejects an organizations fallback with a non-string id or no entries', () => {
    // A numeric/object id must NOT be coerced into the chatgpt-account-id
    // header ("[object Object]" / "42" would guarantee a 401 loop).
    expect(
      extractAccountId(jwt({ organizations: [{ id: 42 }] })),
    ).toBeUndefined()
    expect(extractAccountId(jwt({ organizations: [] }))).toBeUndefined()
  })
  test('returns undefined when no account claim exists', () => {
    expect(extractAccountId(jwt({ sub: 'u' }))).toBeUndefined()
  })
  test('returns undefined for a malformed token', () => {
    expect(extractAccountId('not-a-jwt')).toBeUndefined()
    expect(extractAccountId('h.@@@.s')).toBeUndefined()
  })
})
