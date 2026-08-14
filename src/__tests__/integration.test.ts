import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

// Point the pool file at an isolated temp dir BEFORE the store reads it.
const POOL_DIR = mkdtempSync(join(tmpdir(), 'auth-lb-'))
process.env.OPENCODE_AUTH_LB_DIR = POOL_DIR

import { createLoadBalancedFetch } from '../fetch'
import { mutatePool, readPool } from '../pool/store'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import { openaiAdapter } from '../providers/openai/adapter'
import { SESSION_HEADER } from '../session'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'
import { responderFetch } from './fixtures/fetch-mock'

const HOUR = 60 * 60 * 1000

function acct(o: {
  id: string
  providerID: string
  access: string
  weeklyUtil: number
  accountId?: string
}): PoolAccount {
  const now = Date.now()
  return testAccount({
    id: o.id,
    providerID: o.providerID,
    label: o.id,
    access: o.access,
    refresh: `ref-${o.id}`,
    expires: now + HOUR, // not expired -> no refresh
    accountId: o.accountId ?? null,
    usage: {
      hourly: null,
      weekly: { utilization: o.weeklyUtil, resetAt: now + 30 * HOUR },
      capturedAt: now, // fresh -> background seeding skips it
    },
  })
}

async function seed(accounts: PoolAccount[]): Promise<void> {
  await mutatePool((pool) => {
    pool.accounts = accounts
    pool.lastSelected = {}
  })
}

interface Call {
  url: string
  headers: Headers
  body: string | null
}

// The input→url extraction lives in the shared responderFetch fixture; this
// wrapper only adds the per-test call recording on top of it.
function mockFetch(handler: (url: string) => Response): Call[] {
  const calls: Call[] = []
  globalThis.fetch = responderFetch(() => (url, init) => {
    const headers =
      init?.headers instanceof Headers
        ? init.headers
        : new Headers(init?.headers)
    calls.push({
      url,
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return handler(url)
  })
  return calls
}

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})
beforeEach(() => {
  process.env.OPENCODE_AUTH_LB_DIR = POOL_DIR
  globalThis.fetch = realFetch
})

describe('anthropic end-to-end', () => {
  test('picks lowest-weekly, rotates on 429, transforms body+url+response, records usage & cooldown', async () => {
    const now = Date.now()
    await seed([
      acct({
        id: 'A',
        providerID: 'anthropic',
        access: 'tokA',
        weeklyUtil: 0.2,
      }),
      acct({
        id: 'B',
        providerID: 'anthropic',
        access: 'tokB',
        weeklyUtil: 0.7,
      }),
    ])

    let messages = 0
    const calls = mockFetch((url) => {
      const headers = new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.10',
        'anthropic-ratelimit-unified-5h-reset': String(
          Math.floor((now + 5 * HOUR) / 1000),
        ),
        'anthropic-ratelimit-unified-7d-utilization': '0.72',
        'anthropic-ratelimit-unified-7d-reset': String(
          Math.floor((now + 30 * HOUR) / 1000),
        ),
        'anthropic-ratelimit-unified-status': 'allowed',
      })
      if (url.includes('/v1/messages')) {
        messages++
        if (messages === 1)
          return new Response('rate limited', { status: 429, headers })
        return new Response(JSON.stringify({ name: 'mcp_Bash' }), {
          status: 200,
          headers,
        })
      }
      return new Response('{}', { status: 200 })
    })

    const lbFetch = createLoadBalancedFetch(anthropicAdapter)
    const reqBody = JSON.stringify({
      system:
        'You are OpenCode, a coding agent.\n\nSee https://opencode.ai/docs for help.',
      tools: [{ name: 'bash' }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    const res = await lbFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: reqBody,
      headers: { 'x-api-key': 'should-be-removed' },
    })

    expect(res.status).toBe(200)

    const msgCalls = calls.filter((c) => c.url.includes('/v1/messages'))
    expect(msgCalls.length).toBe(2)
    // weekly-primary: A (0.2) chosen first, then rotates to B after 429
    expect(msgCalls[0]?.headers.get('authorization')).toBe('Bearer tokA')
    expect(msgCalls[1]?.headers.get('authorization')).toBe('Bearer tokB')
    // OAuth headers applied; x-api-key stripped
    expect(msgCalls[1]?.headers.get('x-api-key')).toBeNull()
    expect(msgCalls[1]?.headers.get('anthropic-beta')).toContain(
      'oauth-2025-04-20',
    )
    // URL rewritten with ?beta=true
    expect(msgCalls[1]?.url).toContain('beta=true')

    // body transformed: Claude Code identity present, OpenCode anchors stripped, tools prefixed
    const sent = JSON.parse(msgCalls[1]?.body ?? '{}')
    expect(JSON.stringify(sent.system)).toContain('Claude Agent SDK')
    expect(JSON.stringify(sent.system)).not.toContain('opencode.ai/docs')
    expect(sent.tools[0].name).toBe('mcp_Bash')

    // response stream un-prefixed
    const text = await res.text()
    expect(text).toContain('"name": "bash"')

    // pool state: A cooled down, B usage recorded, lastSelected = B
    const pool = await readPool()
    const A = pool.accounts.find((a) => a.id === 'A')
    const B = pool.accounts.find((a) => a.id === 'B')
    expect(A?.cooldownUntil).toBeGreaterThan(now)
    expect(B?.usage.weekly?.utilization).toBeCloseTo(0.72, 5)
    expect(pool.lastSelected.anthropic).toBe('B')
    // session affinity persisted: the conversation is now pinned to the account that served it (B)
    expect(Object.values(pool.sessions).some((s) => s.accountId === 'B')).toBe(
      true,
    )
  })

  test('a follow-up turn of the same session sticks to the assigned account (no switch)', async () => {
    await seed([
      acct({
        id: 'A',
        providerID: 'anthropic',
        access: 'tokA',
        weeklyUtil: 0.2,
      }),
      acct({
        id: 'B',
        providerID: 'anthropic',
        access: 'tokB',
        weeklyUtil: 0.7,
      }),
    ])
    // Pin this session to B (the higher-utilization account) up front.
    await mutatePool((pool) => {
      pool.sessions['anthropic:s:fixed'] = {
        accountId: 'B',
        updatedAt: Date.now(),
      }
    })

    const calls = mockFetch(
      () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    const lbFetch = createLoadBalancedFetch(anthropicAdapter)
    await lbFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'next turn' }],
      }),
      headers: { [SESSION_HEADER]: 'fixed' },
    })

    const msgCalls = calls.filter((c) => c.url.includes('/v1/messages'))
    // Even though A has far more weekly headroom, the session stays pinned to B.
    expect(msgCalls[0]?.headers.get('authorization')).toBe('Bearer tokB')
    // internal routing header must not leak upstream
    expect(msgCalls[0]?.headers.get(SESSION_HEADER)).toBeNull()
  })

  test('a successful serve clears a STALE long cooldown on the account that served it (active-workhorse self-heal)', async () => {
    // The endpoint-poll reconciliation (usage-refresh) SKIPS an account whose
    // usage was just captured — exactly a continuously (degraded-)served
    // account — so a stale weekly-reset cooldown latch on the pool's active
    // workhorse would never clear there. `A` is the only account (so it is
    // degraded-selected and serves), has full headroom, but carries a days-out
    // stale cooldown. Its 2xx's fresh headers prove headroom, so recordSuccess
    // must drop the latch and let it rejoin normal selection.
    const now = Date.now()
    await seed([
      testAccount({
        id: 'A',
        providerID: 'anthropic',
        label: 'A',
        access: 'tokA',
        refresh: 'ref-A',
        expires: now + HOUR,
        usage: {
          hourly: null,
          weekly: { utilization: 0.02, resetAt: now + 3 * 24 * HOUR },
          capturedAt: now,
        },
        cooldownUntil: now + 3 * 24 * HOUR, // stale latch ~ weekly reset
      }),
    ])
    mockFetch(() => {
      const headers = new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.09',
        'anthropic-ratelimit-unified-5h-reset': String(
          Math.floor((now + 5 * HOUR) / 1000),
        ),
        'anthropic-ratelimit-unified-7d-utilization': '0.02',
        'anthropic-ratelimit-unified-7d-reset': String(
          Math.floor((now + 3 * 24 * HOUR) / 1000),
        ),
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers,
      })
    })
    const lbFetch = createLoadBalancedFetch(anthropicAdapter)
    const res = await lbFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    const A = (await readPool()).accounts.find((x) => x.id === 'A')
    expect(A?.cooldownUntil).toBe(0)
  })

  test('a successful serve does NOT clear the cooldown when the fresh headers still show exhaustion (safety gate)', async () => {
    // The !isExhausted gate: if the 2xx's own usage headers show the account is
    // still at/over the exhaustion threshold, the long cooldown is real and
    // must stand — only genuine headroom clears it.
    const now = Date.now()
    await seed([
      testAccount({
        id: 'A',
        providerID: 'anthropic',
        label: 'A',
        access: 'tokA',
        refresh: 'ref-A',
        expires: now + HOUR,
        usage: {
          hourly: null,
          weekly: { utilization: 0.5, resetAt: now + 3 * 24 * HOUR },
          capturedAt: now,
        },
        cooldownUntil: now + 3 * 24 * HOUR,
      }),
    ])
    mockFetch(() => {
      const headers = new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.10',
        'anthropic-ratelimit-unified-5h-reset': String(
          Math.floor((now + 5 * HOUR) / 1000),
        ),
        'anthropic-ratelimit-unified-7d-utilization': '1', // still exhausted
        'anthropic-ratelimit-unified-7d-reset': String(
          Math.floor((now + 3 * 24 * HOUR) / 1000),
        ),
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers,
      })
    })
    const lbFetch = createLoadBalancedFetch(anthropicAdapter)
    await lbFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    const A = (await readPool()).accounts.find((x) => x.id === 'A')
    expect(A?.cooldownUntil).toBeGreaterThan(now)
  })
})

describe('openai/codex end-to-end', () => {
  test('rewrites to codex endpoint, applies codex headers + body quirks, records x-codex usage', async () => {
    const now = Date.now()
    await seed([
      acct({
        id: 'O',
        providerID: 'openai',
        access: 'tokO',
        weeklyUtil: 0.3,
        accountId: 'acc_123',
      }),
    ])

    const calls = mockFetch(() => {
      const headers = new Headers({
        'x-codex-primary-used-percent': '12.5',
        'x-codex-primary-reset-at': String(Math.floor((now + 5 * HOUR) / 1000)),
        'x-codex-secondary-used-percent': '40',
        'x-codex-secondary-reset-at': String(
          Math.floor((now + 7 * 24 * HOUR) / 1000),
        ),
      })
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers,
      })
    })

    const lbFetch = createLoadBalancedFetch(openaiAdapter)
    const reqBody = JSON.stringify({
      input: [
        { type: 'message', role: 'system', content: 'be helpful' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
      max_output_tokens: 1000,
    })
    const res = await lbFetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: reqBody,
    })
    expect(res.status).toBe(200)

    const call = calls.find((c) => c.url.includes('/responses'))
    expect(call?.url).toContain('chatgpt.com/backend-api/codex/responses')
    expect(call?.headers.get('authorization')).toBe('Bearer tokO')
    expect(call?.headers.get('chatgpt-account-id')).toBe('acc_123')
    expect(call?.headers.get('openai-beta')).toBe('responses=experimental')
    expect(call?.headers.get('originator')).toBe('opencode')

    const sent = JSON.parse(call?.body ?? '{}')
    expect(sent.store).toBe(false)
    expect(sent.include).toContain('reasoning.encrypted_content')
    expect(sent.instructions).toBe('be helpful') // lifted from the system message
    expect(sent.max_output_tokens).toBeUndefined()
    expect(
      (sent.input as { role?: string }[]).some((i) => i.role === 'system'),
    ).toBe(false)

    const pool = await readPool()
    const O = pool.accounts.find((a) => a.id === 'O')
    expect(O?.usage.hourly?.utilization).toBeCloseTo(0.125, 5)
    expect(O?.usage.weekly?.utilization).toBeCloseTo(0.4, 5)
  })
})
