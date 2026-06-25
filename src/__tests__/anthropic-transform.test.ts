import { afterEach, describe, expect, test } from 'bun:test'

import {
  buildBillingHeaderValue,
  computeCCH,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from '../providers/anthropic/cch'
import { CLAUDE_CODE_IDENTITY } from '../providers/anthropic/constants'
import { generatePKCE } from '../providers/anthropic/pkce'
import {
  createStrippedStream,
  mergeBetaHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
  stripToolPrefix,
} from '../providers/anthropic/transform'

afterEach(() => {
  delete process.env.ANTHROPIC_BASE_URL
})

describe('mergeBetaHeaders / setOAuthHeaders', () => {
  test('required betas are always present', () => {
    expect(mergeBetaHeaders(new Headers())).toContain('oauth-2025-04-20')
  })

  test('incoming betas are merged and de-duplicated', () => {
    const merged = mergeBetaHeaders(
      new Headers({ 'anthropic-beta': 'foo, oauth-2025-04-20' }),
    )
    expect(
      merged.split(',').filter((b) => b === 'oauth-2025-04-20'),
    ).toHaveLength(1)
    expect(merged).toContain('foo')
  })

  test('setOAuthHeaders sets bearer + beta + UA and drops x-api-key', () => {
    const h = new Headers({ 'x-api-key': 'remove-me' })
    setOAuthHeaders(h, 'tok123')
    expect(h.get('authorization')).toBe('Bearer tok123')
    expect(h.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(h.get('user-agent')).toBeTruthy()
    expect(h.get('x-api-key')).toBeNull()
  })
})

describe('stripToolPrefix', () => {
  test('strips the mcp_ prefix and restores leading case', () => {
    expect(stripToolPrefix('{"name":"mcp_Bash"}')).toBe('{"name": "bash"}')
  })
  test('keeps StructuredOutput as-is', () => {
    expect(stripToolPrefix('{"name":"mcp_StructuredOutput"}')).toBe(
      '{"name": "StructuredOutput"}',
    )
  })
})

describe('rewriteUrl', () => {
  test('adds ?beta=true for /v1/messages', () => {
    const out = rewriteUrl('https://api.anthropic.com/v1/messages')
    expect(out.toString()).toContain('beta=true')
  })
  test('returns the input unchanged when beta=true already present', () => {
    const input = 'https://api.anthropic.com/v1/messages?beta=true'
    expect(rewriteUrl(input)).toBe(input)
  })
  test('rewrites a Request object', () => {
    const req = new Request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
    })
    const out = rewriteUrl(req)
    expect(out).toBeInstanceOf(Request)
    expect((out as Request).url).toContain('beta=true')
  })
  test('returns non-URL input untouched', () => {
    expect(rewriteUrl('not a url')).toBe('not a url')
  })
  test('honors ANTHROPIC_BASE_URL override', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example'
    expect(
      rewriteUrl('https://api.anthropic.com/v1/messages').toString(),
    ).toContain('proxy.example')
  })
  test('ignores a base URL with credentials', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://user:pass@proxy.example'
    expect(
      rewriteUrl('https://api.anthropic.com/v1/messages').toString(),
    ).toContain('api.anthropic.com')
  })
  test('ignores a non-http base URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'ftp://proxy.example'
    expect(
      rewriteUrl('https://api.anthropic.com/v1/messages').toString(),
    ).toContain('api.anthropic.com')
  })
  test('ignores an unparseable base URL', () => {
    process.env.ANTHROPIC_BASE_URL = '::::'
    expect(
      rewriteUrl('https://api.anthropic.com/v1/messages').toString(),
    ).toContain('api.anthropic.com')
  })
})

describe('rewriteRequestBody', () => {
  test('sanitizes a string system prompt, prepends identity + billing, prefixes tools', () => {
    const body = JSON.stringify({
      system:
        'You are OpenCode, a coding agent.\n\nSee https://opencode.ai/docs for help.',
      tools: [{ name: 'bash' }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const out = JSON.parse(rewriteRequestBody(body))
    expect(out.system[0].text).toContain('x-anthropic-billing-header')
    expect(JSON.stringify(out.system)).toContain('Claude Agent SDK')
    expect(JSON.stringify(out.system)).not.toContain('opencode.ai/docs')
    expect(out.tools[0].name).toBe('mcp_Bash')
  })

  test('handles an array system prompt and prefixes tool_use blocks', () => {
    const body = JSON.stringify({
      system: ['keep me', { type: 'text', text: 'block' }],
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'read' },
            { type: 'text', text: 'hi' },
          ],
        },
      ],
    })
    const out = JSON.parse(rewriteRequestBody(body))
    expect(out.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(out.messages[0].content[0].name).toBe('mcp_Read')
    expect(out.messages[0].content[1].text).toBe('hi')
  })

  test('handles a record system prompt', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({ system: { type: 'text', text: 'hi' } }),
      ),
    )
    expect(out.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(out.system[1].text).toBe('hi')
  })

  test('handles null system and no user message (no billing header)', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }] }),
      ),
    )
    expect(out.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(JSON.stringify(out.system)).not.toContain(
      'x-anthropic-billing-header',
    )
  })

  test('handles a non-string/record/array system value', () => {
    const out = JSON.parse(
      rewriteRequestBody(JSON.stringify({ system: 5, messages: [] })),
    )
    expect(out.system).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('does not double-prepend when identity is already first', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({
          system: [{ type: 'text', text: CLAUDE_CODE_IDENTITY }],
        }),
      ),
    )
    expect(
      out.system.filter(
        (b: { text: string }) => b.text === CLAUDE_CODE_IDENTITY,
      ),
    ).toHaveLength(1)
  })

  test('coerces non-text array system items via String()', () => {
    const out = JSON.parse(
      rewriteRequestBody(JSON.stringify({ system: [42, { type: 'image' }] })),
    )
    expect(out.system[0].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(out.system.map((b: { text: string }) => b.text)).toContain('42')
    expect(out.system.map((b: { text: string }) => b.text)).toContain(
      '[object Object]',
    )
  })

  test('returns the original body on invalid JSON', () => {
    expect(rewriteRequestBody('{not json')).toBe('{not json')
  })
})

describe('createStrippedStream', () => {
  test('strips tool prefixes from a streamed body', async () => {
    const res = new Response('{"name":"mcp_Read"}', { status: 200 })
    const out = createStrippedStream(res)
    expect(await out.text()).toContain('"name": "read"')
  })
  test('returns the response unchanged when there is no body', () => {
    const res = new Response(null, { status: 204 })
    expect(createStrippedStream(res)).toBe(res)
  })
})

describe('cch billing header', () => {
  test('extractFirstUserMessageText handles string, array, missing, and non-text content', () => {
    expect(
      extractFirstUserMessageText([{ role: 'user', content: 'hello' }]),
    ).toBe('hello')
    expect(
      extractFirstUserMessageText([
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ]),
    ).toBe('hi')
    expect(
      extractFirstUserMessageText([{ role: 'assistant', content: 'x' }]),
    ).toBe('')
    expect(
      extractFirstUserMessageText([
        { role: 'user', content: [{ type: 'image' }] },
      ]),
    ).toBe('')
  })
  test('computeCCH / computeVersionSuffix produce fixed-length hex', () => {
    expect(computeCCH('hello')).toHaveLength(5)
    expect(computeVersionSuffix('hello')).toHaveLength(3)
    expect(computeVersionSuffix('hello', '9.9.9')).toHaveLength(3)
  })
  test('buildBillingHeaderValue embeds version, entrypoint, and cch', () => {
    const v = buildBillingHeaderValue(
      [{ role: 'user', content: 'hi' }],
      undefined,
      'sdk-cli',
    )
    expect(v).toContain('cc_entrypoint=sdk-cli')
    expect(v).toContain('cc_version=')
    expect(v).toContain('cch=')
  })
})

describe('pkce', () => {
  test('generates a base64url verifier + challenge', async () => {
    const { verifier, challenge, method } = await generatePKCE()
    expect(method).toBe('S256')
    expect(verifier).not.toMatch(/[+/=]/)
    expect(challenge).not.toMatch(/[+/=]/)
    expect(verifier.length).toBeGreaterThan(40)
  })
})
