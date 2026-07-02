import { afterEach, describe, expect, test } from 'bun:test'

import {
  buildBillingHeaderValue,
  computeCCH,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from '../providers/anthropic/cch'
import { CLAUDE_CODE_IDENTITY } from '../providers/anthropic/constants'
import {
  createStrippedStream,
  mergeBetaHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
  stripToolPrefix,
} from '../providers/anthropic/transform'
import { generatePKCE } from '../providers/pkce'

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
    // Repeat call with the same raw header exercises the one-slot memo hit path.
    expect(
      mergeBetaHeaders(
        new Headers({ 'anthropic-beta': 'foo, oauth-2025-04-20' }),
      ),
    ).toBe(merged)
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

  test('does not double-prepend when a record system IS the identity', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({
          system: { type: 'text', text: CLAUDE_CODE_IDENTITY, extra: 'keep' },
        }),
      ),
    )
    const identityBlocks = out.system.filter(
      (b: { text: string }) => b.text === CLAUDE_CODE_IDENTITY,
    )
    expect(identityBlocks).toHaveLength(1)
    expect(identityBlocks[0].extra).toBe('keep')
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

  test('drops a string system that sanitizes to empty (Anthropic rejects empty text blocks)', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({ system: 'You are OpenCode, a coding agent.' }),
      ),
    )
    expect(out.system).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('drops a record system whose text sanitizes to empty', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({
          system: {
            type: 'text',
            text: 'You are OpenCode, a coding agent.',
            extra: 'x',
          },
        }),
      ),
    )
    expect(out.system).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('filters array system items that sanitize to empty, keeping the rest', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({
          system: [
            'You are OpenCode, a coding agent.',
            { type: 'text', text: 'keep me' },
          ],
        }),
      ),
    )
    expect(out.system).toEqual([
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: 'keep me' },
    ])
  })

  test('returns only the identity when EVERY array system item sanitizes to empty', () => {
    const out = JSON.parse(
      rewriteRequestBody(
        JSON.stringify({ system: ['You are OpenCode, a coding agent.'] }),
      ),
    )
    expect(out.system).toEqual([{ type: 'text', text: CLAUDE_CODE_IDENTITY }])
  })

  test('rewrites EVERY occurrence of a branded text-replacement phrase', () => {
    // The branded fingerprint phrase appears twice in the same paragraph. With
    // the first-occurrence `.replace`, the second copy survived and could trip
    // the Anthropic classifier on a disguised 400; `.replaceAll` rewrites both.
    const body = JSON.stringify({
      system:
        'Rule one: if OpenCode honestly cannot answer, say so. ' +
        'Rule two: if OpenCode honestly is unsure, say so.',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const sysText = JSON.stringify(JSON.parse(rewriteRequestBody(body)).system)
    expect(sysText).not.toContain('if OpenCode honestly')
    expect(sysText.split('if the assistant honestly').length - 1).toBe(2)
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
  test('forwards downstream cancel to the upstream reader', async () => {
    // Pre-fix: `new ReadableStream({ pull })` has no `cancel`, so cancelling
    // the wrapped stream leaves the underlying reader's lock held — the fetch
    // socket is never released. This sentinel fails on a no-op cancel and
    // passes once the cancel is forwarded.
    let cancelledWith: unknown = null
    const upstream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"name":"mcp_Read"}'))
      },
      cancel(reason) {
        cancelledWith = reason
      },
    })
    const res = new Response(upstream, { status: 200 })
    const out = createStrippedStream(res)
    await out.body!.cancel('aborted-by-test')
    expect(cancelledWith).toBe('aborted-by-test')
  })
  test('strips a tool prefix that straddles a chunk boundary', async () => {
    // Pre-fix: the `pull` callback in `createStrippedStream` (transform.ts
    // ~line 241) ran `stripToolPrefix` on each chunk in isolation, and the
    // regex `/"name"\s*:\s*"mcp_([^"]+)"/g` needs the full
    // `"name":"mcp_<name>"` literal — including the closing `"` — in ONE
    // call. The existing single-chunk test above never exercised that:
    // `new Response('{"name":"mcp_Read"}')` is delivered as one chunk, so
    // the pattern is always whole in the regex's view. But the HTTP transport
    // is free to fragment the body anywhere — short HTTP/1.1 chunked frames,
    // mid-event TCP boundaries, or gzip de-stream re-fragmentation can all
    // split this field. When that hits, the un-stripped `mcp_Bash` leaks
    // straight to the opencode SDK and breaks tool dispatch (the SDK can't
    // unwrap the prefix, so the call never reaches the tool). This test
    // locks the tail-buffer fix by feeding two chunks split mid-pattern.
    // The 300-byte 'A' padding around each chunk (> TAIL_MAX = 256) also
    // drives stripped > TAIL_MAX on both pulls, which exercises the
    // mid-stream emit branch (slice + enqueue) alongside the cross-chunk
    // tail-buffer behavior. 'A' is used (not 'x') because 'prefix' and
    // 'suffix' each already contain an 'x' — split('x') would over-count
    // the padding.
    const enc = new TextEncoder()
    const PAD = 'A'.repeat(300)
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(PAD + 'prefix-noise...{"name":"mcp_'))
        c.enqueue(enc.encode('Bash"}...suffix-noise' + PAD))
        c.close()
      },
    })
    const res = new Response(upstream, { status: 200 })
    const out = await createStrippedStream(res).text()
    expect(out).not.toContain('mcp_')
    expect(out).toContain('"name": "bash"')
    expect(out).toContain('prefix-noise...')
    expect(out).toContain('...suffix-noise')
    // All 600 'A' padding bytes are preserved verbatim (none of the
    // surrounding non-pattern bytes are dropped by the tail buffer).
    expect(out.split('A').length - 1).toBe(600)
  })
  test('flushes the TextDecoder at end-of-stream (final chunk ends mid-multibyte char)', async () => {
    // Pre-fix: every chunk was decoded with { stream: true } but the `done`
    // branch closed WITHOUT the terminal decoder.decode() flush the WHATWG
    // streaming contract requires. Bytes of a multi-byte UTF-8 character
    // straddling the FINAL chunk boundary stayed buffered in the decoder and
    // were silently dropped. Post-fix they surface as U+FFFD.
    const euro = new TextEncoder().encode('€') // 3 bytes: e2 82 ac
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data:ok'))
        c.enqueue(euro.slice(0, 2)) // incomplete sequence, then EOF
        c.close()
      },
    })
    const res = new Response(upstream, { status: 200 })
    const out = await createStrippedStream(res).text()
    expect(out).toBe('data:ok\uFFFD')
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
      'sdk-cli',
    )
    expect(v).toContain('cc_entrypoint=sdk-cli')
    expect(v).toContain('cc_version=')
    expect(v).toContain('cch=')
  })
})

describe('pkce', () => {
  test('generates a base64url verifier + challenge', async () => {
    const { verifier, challenge } = await generatePKCE()
    expect(verifier).not.toMatch(/[+/=]/)
    expect(challenge).not.toMatch(/[+/=]/)
    expect(verifier.length).toBeGreaterThan(40)
  })
})
