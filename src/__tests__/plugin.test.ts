import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-plugin-'))
const POOL = join(DIR, 'auth-load-balancer.json')

import { bestEffort, createLoadBalancedFetch } from '../fetch'
import {
  AnthropicLoadBalancerPlugin,
  AuthLoadBalancerStatusPlugin,
  OpenAILoadBalancerPlugin,
} from '../index'
import type { ToastClient } from '../notify'
import { LockTimeoutError } from '../pool/lock'
import { mutatePool, PoolWriteError, readPool } from '../pool/store'
import { primeInUse } from '../prime'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import { loadConfig } from '../scheduler/config'
import { SESSION_HEADER } from '../session'
import type { PoolAccount } from '../types'

const realFetch = globalThis.fetch
type Responder = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>
let respond: Responder

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(POOL, { force: true })
  respond = () => new Response('{}', { status: 200 })
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    return Promise.resolve(respond(url, init))
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

// Minimal structural views of the (untyped-in-public-API) hook shape.
interface AuthMethod {
  label: string
  type: string
  authorize: () => Promise<{
    url: string
    instructions: string
    method: string
    callback: (code: string) => Promise<{ type: string }>
  }>
}
interface PluginHooks {
  auth: {
    provider: string
    loader: (
      getAuth: () => Promise<{
        type: string
        access?: string
        refresh?: string
        expires?: number
      }>,
      provider: { models: Record<string, { cost: unknown }> },
    ) => Promise<{ apiKey: string; fetch: typeof fetch }>
    methods: AuthMethod[]
  }
  'chat.headers': (
    input: { sessionID?: string; model?: { providerID?: string } },
    output: { headers: Record<string, string> },
  ) => Promise<void>
}

interface ToolHooks {
  tool: {
    auth_lb_status: {
      description: string
      args: object
      execute: () => Promise<{ title: string; output: string }>
    }
    auth_lb_rename: {
      description: string
      args: object
      execute: (args: {
        account: string
        name: string
      }) => Promise<{ title: string; output: string }>
    }
  }
}

const noopClient: ToastClient = { tui: { showToast: async () => undefined } }

async function loadHooks<T = PluginHooks>(
  plugin: typeof AnthropicLoadBalancerPlugin,
  client: ToastClient = noopClient,
): Promise<T> {
  const factory = plugin as unknown as (input: {
    client: ToastClient
  }) => Promise<T>
  return factory({ client })
}

function account(over: Partial<PoolAccount> = {}): PoolAccount {
  return {
    id: 'A',
    providerID: 'anthropic',
    label: 'A',
    access: 'tokA',
    refresh: 'ref',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: null,
    usage: {
      hourly: null,
      weekly: { utilization: 0.1, resetAt: Date.now() + 30 * 60 * 60 * 1000 },
      status: null,
      capturedAt: Date.now(),
    },
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: Date.now(),
    lastUsedAt: 0,
    ...over,
  }
}

describe('plugin factory', () => {
  test('exposes auth + chat.headers for each provider', async () => {
    const a = await loadHooks(AnthropicLoadBalancerPlugin)
    expect(a.auth.provider).toBe('anthropic')
    expect(typeof a['chat.headers']).toBe('function')
    const o = await loadHooks(OpenAILoadBalancerPlugin)
    expect(o.auth.provider).toBe('openai')
  })

  test('loader seeds from existing auth, zeroes model cost, returns a fetch', async () => {
    const hooks = await loadHooks(AnthropicLoadBalancerPlugin)
    const provider: { models: Record<string, { cost: unknown }> } = {
      models: { 'claude-x': { cost: { input: 9 } } },
    }
    const opts = await hooks.auth.loader(
      async () => ({ type: 'api' }),
      provider,
    )
    expect(opts.apiKey).toBe('')
    expect(typeof opts.fetch).toBe('function')
    expect(provider.models['claude-x']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  test('oauth method authorize+callback appends an account to the pool', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    const hooks = await loadHooks(AnthropicLoadBalancerPlugin)
    const method = hooks.auth.methods[0]
    expect(method).toBeDefined()
    const flow = await method!.authorize()
    expect(flow.url).toContain('claude.ai/oauth/authorize')
    const state = new URL(flow.url).searchParams.get('state')
    const ok = await flow.callback(`https://cb?code=C&state=${state}`)
    expect(ok.type).toBe('success')
    expect((await readPool()).accounts).toHaveLength(1)
  })

  test('oauth callback reports failure on an unparsable code', async () => {
    const hooks = await loadHooks(AnthropicLoadBalancerPlugin)
    const flow = await hooks.auth.methods[0]!.authorize()
    expect((await flow.callback('garbage')).type).toBe('failed')
  })

  test('chat.headers stamps the session id only for the matching provider with a session', async () => {
    const hooks = await loadHooks(AnthropicLoadBalancerPlugin)
    const match: { headers: Record<string, string> } = { headers: {} }
    await hooks['chat.headers'](
      { sessionID: 's1', model: { providerID: 'anthropic' } },
      match,
    )
    expect(match.headers[SESSION_HEADER]).toBe('s1')

    const wrongProvider: { headers: Record<string, string> } = { headers: {} }
    await hooks['chat.headers'](
      { sessionID: 's1', model: { providerID: 'openai' } },
      wrongProvider,
    )
    expect(wrongProvider.headers[SESSION_HEADER]).toBeUndefined()

    const noSession: { headers: Record<string, string> } = { headers: {} }
    await hooks['chat.headers'](
      { model: { providerID: 'anthropic' } },
      noSession,
    )
    expect(noSession.headers[SESSION_HEADER]).toBeUndefined()
  })
})

describe('load-balanced fetch — edge paths', () => {
  test('returns a synthetic 401 (never leaks the empty x-api-key) when the pool has no accounts', async () => {
    // Pre-fix this path fell through to the global fetch, sending opencode's default
    // `x-api-key: ''` upstream and yielding a misleading "x-api-key header is required".
    // Now it returns a clean provider-shaped 401 WITHOUT touching the network.
    let hit = false
    respond = () => {
      hit = true
      return new Response('default', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(hit).toBe(false) // global fetch never called
    expect(res.status).toBe(401)
    const json = (await res.json()) as {
      error?: { type?: string; message?: string }
    }
    expect(json.error?.type).toBe('authentication_error')
    expect(json.error?.message).toContain('auth-load-balancer pool')
  })

  test('honors retry-after when cooling down a rate-limited account', async () => {
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '30' },
        })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    expect(cooled?.cooldownUntil).toBeGreaterThan(now + 25_000)
  })

  test('honors retry-after HTTP-date form (RFC 9110) when cooling down', async () => {
    const now = Date.now()
    // 90 minutes ahead — well outside both the 5 min ACCOUNT and 2 min AUTH fallback,
    // so a pre-fix code path (which only parses delay-seconds) would land near now+5min
    // and FAIL this assertion. Only the HTTP-date branch can satisfy the ±2s window.
    const futureMs = now + 90 * 60_000
    const httpDate = new Date(futureMs).toUTCString()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': httpDate },
        })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    // HTTP-date has second resolution; toUTCString truncates ms, so the cooled
    // value lands within one second below futureMs. Allow a ±2 s window.
    expect(cooled?.cooldownUntil).toBeGreaterThanOrEqual(futureMs - 2_000)
    expect(cooled?.cooldownUntil).toBeLessThanOrEqual(futureMs + 2_000)
  })

  test('falls back to default cooldown when retry-after is unparseable', async () => {
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': 'garbage' },
        })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooled?.cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooled?.cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
  })

  test('falls back to default cooldown when retry-after seconds overflow numeric precision', async () => {
    // Regression lock: `Number("1e308") = 1e308` is finite, but `1e308 * 1000`
    // exceeds Number.MAX_VALUE (~1.798e308) and collapses to +Infinity. Before
    // the fix in applyCooldown, that set cooldownUntil to +Infinity, and the
    // scheduler's `account.cooldownUntil > now` check then excluded the account
    // forever (only a process restart or manual pool-file edit could recover it).
    // Post-fix the overflowing delta falls through to the ACCOUNT_COOLDOWN_MS
    // (5 min) fallback, just like the unparseable-retry-after branch above.
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '1e308' },
        })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooled?.cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooled?.cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    // The locking assertion: a regression that re-introduces the overflow path
    // sets cooldownUntil to +Infinity, which fails Number.isFinite.
    expect(Number.isFinite(cooled?.cooldownUntil ?? Infinity)).toBe(true)
  })

  test('falls back to default cooldown when retry-after is "0" (server says retry immediately)', async () => {
    // Regression lock: `Number('0') = 0` is finite but `0 > 0` is false, so the
    // delay-seconds branch is skipped. `Date.parse('0')` either yields a finite
    // epoch-ms in the past (year 2000 on V8/Bun) or NaN depending on engine;
    // both paths fail the `Number.isFinite(httpDate) && httpDate > now` HTTP-date
    // gate, landing on the 5-min ACCOUNT_COOLDOWN_MS fallback. A regression that
    // flipped `httpDate > now` to `<` would silently pass the 'garbage' test
    // (NaN trips Number.isFinite first) but cool A out to the year 2000 here.
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooled?.cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooled?.cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    expect(Number.isFinite(cooled?.cooldownUntil ?? Infinity)).toBe(true)
  })

  test('falls back to default cooldown when retry-after is a negative integer', async () => {
    // Regression lock: `Number('-10') = -10` is finite but `> 0` is false, so
    // the delay-seconds branch is skipped. `Date.parse('-10')` yields a finite
    // epoch-ms in the past (or NaN), which fails the `httpDate > now` gate —
    // the parser falls through to ACCOUNT_COOLDOWN_MS. Same regression family as
    // the '0' case: a flipped comparison would cool A out to a past date.
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '-10' },
        })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooled?.cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooled?.cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    expect(Number.isFinite(cooled?.cooldownUntil ?? Infinity)).toBe(true)
  })

  test('honors retry-after for a large-but-valid delay-seconds (1 day)', async () => {
    // Regression lock: 86400 seconds (1 day) exercises the non-overflowing
    // finite-delta branch at the upper end of the practical range. The existing
    // '30' test pins behavior near the lower end; the '1e308' test pins the
    // OVERFLOW fallback; this test pins the accepted-finite-delta path itself.
    // A regression that ANDed `Number.isFinite(delta)` with `delta < some_cap`
    // would silently pass '30' but break '86400'.
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '86400' },
        })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    // The non-overflowing finite-delta path: `until = now + 86_400 * 1000`.
    // Allow ±2 s of clock drift.
    const expected = now + 86_400 * 1000
    expect(cooled?.cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooled?.cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    expect(Number.isFinite(cooled?.cooldownUntil ?? Infinity)).toBe(true)
  })

  test('on API 401 (cls=auth) cools the account for AUTH_COOLDOWN_MS and rotates to the next account', async () => {
    // Regression lock for the 'auth' branch of `if (cls === 'account' || cls === 'auth')`
    // in fetch.ts. Line+function coverage hit the inner ternary `cls === 'auth' ?
    // AUTH_COOLDOWN_MS : ACCOUNT_COOLDOWN_MS` only via the 'account' side in the existing
    // 429 retry-after tests; classifyError(401)=='auth' is unit-tested in isolation
    // (stateful.test.ts) but never wired through the load-balanced fetch loop. A
    // regression that (a) collapsed the ternary to a single constant, (b) flipped the
    // condition so AUTH and ACCOUNT cooldowns swapped, or (c) dropped the
    // `|| cls === 'auth'` clause entirely (turning 401 into a returned response with
    // transformResponse wrapping an auth-error stream and breaking rotation) would
    // still pass every existing test.
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let n = 0
    respond = () => {
      n += 1
      if (n === 1) return new Response('unauthorized', { status: 401 })
      return new Response('ok', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    // Rotation happened: the second account (B) served the request.
    expect(res.status).toBe(200)
    const cooled = (await readPool()).accounts.find((x) => x.id === 'A')
    // AUTH_COOLDOWN_MS = 2 * 60 * 1000 (2 min). Allow ±2 s of clock drift.
    const expectedAuth = now + 2 * 60_000
    expect(cooled?.cooldownUntil).toBeGreaterThanOrEqual(expectedAuth - 2_000)
    expect(cooled?.cooldownUntil).toBeLessThanOrEqual(expectedAuth + 2_000)
    // Locks the AUTH-vs-ACCOUNT distinction: ACCOUNT_COOLDOWN_MS is 5 min, so a
    // regression that swapped the two constants would cool A out to ~5 min and
    // fail this strict upper bound.
    expect(cooled?.cooldownUntil).toBeLessThan(now + 4 * 60_000)
  })

  test('a 5xx service-class response is returned untouched (no rotation, no cooldown)', async () => {
    // Regression lock: cls === 'service' is the ONLY classifyError outcome never
    // exercised end-to-end through createLoadBalancedFetch. The other three branches
    // ('account', 'auth', 'ok') each have a dedicated test in this file; 'service'
    // is unit-tested only via classifyError(503) in isolation (stateful.test.ts).
    // A regression that:
    //   - adds `|| cls === 'service'` to the rotation gate (rotating on transient
    //     5xx, draining the pool during a provider outage),
    //   - hoists `applyCooldown` out of the gate (cooling on every transient hiccup),
    //   - reclassifies 5xx as 'account' / 'auth',
    //   - or removes the 'service' arm of classifyError so 5xx falls through to
    //     a future 'ok' branch that might gain body-inspection / usage-only logic
    // would pass every existing test today while silently breaking the contract
    // that transient upstream issues are propagated to the caller (whose SDK has
    // its own retry policy) without sidelining accounts. The session pin is
    // asserted too: a 5xx pinned to the served account means the next turn retries
    // on the SAME account, preserving prompt cache.
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: null,
            weekly: { utilization: 0.5, resetAt: now + 30 * 60 * 60 * 1000 },
            status: null,
            capturedAt: now,
          },
        }),
      )
    })
    let calls = 0
    respond = () => {
      calls += 1
      return new Response('upstream down', { status: 503 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
      headers: { [SESSION_HEADER]: 'svc' },
    })
    // The 5xx is returned untouched to the caller (status preserved, no rotation).
    expect(res.status).toBe(503)
    // Only ONE upstream call — locks "no rotation onto B".
    expect(calls).toBe(1)
    // No cooldown stamp on either account — locks "no applyCooldown on service".
    const pool = await readPool()
    expect(pool.accounts.find((a) => a.id === 'A')?.cooldownUntil).toBe(0)
    expect(pool.accounts.find((a) => a.id === 'B')?.cooldownUntil).toBe(0)
    // Session IS pinned (the next turn retries on A, preserving prompt cache).
    expect(pool.sessions['s:svc']?.accountId).toBe('A')
  })

  test('cheapSwitchMaxBytes gate counts UTF-8 bytes (not UTF-16 code units) for non-ASCII bodies', async () => {
    // Regression lock: before the fix, the cost gate used `bodyStr.length` (UTF-16
    // code units), so a 10-character Korean body (which is 30 UTF-8 bytes on the
    // wire) was reported as 10 and slipped under a 20-byte gate. That is exactly the
    // "re-sending a huge context onto a fresh (uncached) account" the gate exists to
    // prevent — and it hits CJK / emoji conversations hardest (Hangul/Hanzi/Kana =
    // 3 UTF-8 bytes per UTF-16 unit, emoji surrogate pair = 4). The fix uses
    // `Buffer.byteLength(bodyStr, 'utf8')`, so 30 > 20 correctly fails the gate and
    // the session stays pinned to its account. A regression that reintroduces
    // `.length` would treat the request as cheap and migrate away (this test would
    // then see Bearer tokA instead of Bearer tokB).
    const now = Date.now()
    await mutatePool((pool) => {
      // A: healthy migration target (low weekly util, no hourly pressure).
      pool.accounts.push(account({ id: 'A', access: 'tokA', label: 'A' }))
      // B: pinned to session 's:cjk', past 5h migrateAt (0.96 > 0.95) so a non-forced
      //    proactive switch IS on the table — but only when the cost gate calls the
      //    moment cheap. maxUtil(B)=0.96 > maxUtil(A)=0.1 makes A a strictly better
      //    proactive target post-gate. B is NOT exhausted (0.96 < 0.999), so the
      //    switch decision is genuinely gated by the byte count, not forced.
      pool.accounts.push(
        account({
          id: 'B',
          access: 'tokB',
          label: 'B',
          usage: {
            hourly: { utilization: 0.96, resetAt: now + 2 * 60 * 60 * 1000 },
            weekly: {
              utilization: 0.5,
              resetAt: now + 5 * 24 * 60 * 60 * 1000,
            },
            status: null,
            capturedAt: now,
          },
        }),
      )
      pool.sessions['s:cjk'] = { accountId: 'B', updatedAt: now }
    })
    // 10 Hangul code points => 10 UTF-16 units, 30 UTF-8 bytes. Pin the invariant
    // here so a future tweak to the literal can't silently invalidate the test.
    const cjkBody = '안녕하세요반갑습니다'
    expect(cjkBody.length).toBe(10)
    expect(Buffer.byteLength(cjkBody, 'utf8')).toBe(30)
    const authHeaders: (string | null)[] = []
    respond = (_url, init) => {
      authHeaders.push(
        new Headers(init?.headers as HeadersInit | undefined).get(
          'authorization',
        ),
      )
      return new Response('ok', { status: 200 })
    }
    // Set the env BEFORE constructing the fetch — createLoadBalancedFetch snapshots
    // the config via loadConfig() exactly once at construction time.
    process.env.OPENCODE_AUTH_LB_CHEAP_SWITCH_MAX_BYTES = '20'
    try {
      const lb = createLoadBalancedFetch(anthropicAdapter)
      const res = await lb('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: cjkBody,
        headers: { [SESSION_HEADER]: 'cjk' },
      })
      expect(res.status).toBe(200)
    } finally {
      delete process.env.OPENCODE_AUTH_LB_CHEAP_SWITCH_MAX_BYTES
    }
    // Exactly one upstream call, on the pinned account B. Pre-fix the cheap gate
    // (10 <= 20) would have triggered the proactive migration to A and we'd see
    // Bearer tokA here instead.
    expect(authHeaders).toEqual(['Bearer tokB'])
  })

  test("rejects when the only account's request throws", async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'solo' }))
    })
    respond = () => {
      throw new Error('network down')
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    await expect(
      lb('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow()
  })

  test('a client-side abort propagates without cooling down or rotating accounts', async () => {
    // A request aborted by the caller (opencode restart / user cancels the turn) must NOT
    // be charged to the account: cooling it down would sideline a healthy account, and
    // retrying would re-send an abandoned request onto a fresh one. At shutdown this is
    // what otherwise cools EVERY in-flight account at once. Two accounts + a call counter
    // pin both invariants: no cooldown AND no rotation (tried exactly once).
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'acctA', label: 'acctA' }))
      pool.accounts.push(account({ id: 'acctB', label: 'acctB' }))
    })
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    respond = () => {
      calls++
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    await expect(
      lb('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
        signal: controller.signal,
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1) // tried exactly once — no rotation onto the second account
    const pool = await readPool()
    expect(pool.accounts.find((a) => a.id === 'acctA')?.cooldownUntil).toBe(0)
    expect(pool.accounts.find((a) => a.id === 'acctB')?.cooldownUntil).toBe(0)
  })

  test('assignSession prunes stale session-affinity entries past sessionTtlMs', async () => {
    // The TTL-prune branch in assignSession (`delete pool.sessions[key]` when
    // `now - value.updatedAt > ttlMs`) is line-covered only because the for-loop
    // body executes — a regression flipping `>` to `<`, swapping the subtraction
    // order, or omitting the prune entirely would still report 100% coverage.
    // This test pins the actual deletion behavior: the stale entry points at an
    // EXISTING account so the ONLY mechanism that can remove it is the TTL prune.
    const now = Date.now()
    const cfg = loadConfig()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', label: 'A' }))
      pool.sessions['s:stale'] = {
        accountId: 'A',
        updatedAt: now - cfg.sessionTtlMs - 60_000,
      }
      pool.sessions['s:fresh'] = { accountId: 'A', updatedAt: now }
    })
    respond = () => new Response('ok', { status: 200 })
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
      headers: { [SESSION_HEADER]: 'new' },
    })
    expect(res.status).toBe(200)
    const pool = await readPool()
    expect(pool.sessions['s:stale']).toBeUndefined()
    expect(pool.sessions['s:fresh']).toBeDefined()
    expect(pool.sessions['s:new']).toBeDefined()
  })
})

describe('toast on switch + status tool', () => {
  test("the loader's fetch toasts the in-use account on a successful request", async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'toast-acct', label: 'toast-acct' }))
    })
    const toasts: string[] = []
    const client: ToastClient = {
      tui: {
        showToast: async (o) => {
          toasts.push(o.body.message)
          return undefined
        },
      },
    }
    const hooks = await loadHooks(AnthropicLoadBalancerPlugin, client)
    const opts = await hooks.auth.loader(async () => ({ type: 'api' }), {
      models: {},
    })
    respond = () => new Response('ok', { status: 200 })
    await opts.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('toast-acct')
  })

  test('auth_lb_status tool renders the pool dashboard', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'dash', label: 'dash' }))
      pool.lastSelected.anthropic = 'dash'
    })
    const hooks = await loadHooks<ToolHooks>(AuthLoadBalancerStatusPlugin)
    const result = await hooks.tool.auth_lb_status.execute()
    expect(result.title).toBe('Auth Load Balancer')
    expect(result.output).toContain('dash')
    expect(result.output).toContain('in use')
  })

  test('auth_lb_rename: no matching account reports the available labels', async () => {
    const hooks = await loadHooks<ToolHooks>(AuthLoadBalancerStatusPlugin)
    // empty pool -> "(none)"
    const empty = await hooks.tool.auth_lb_rename.execute({
      account: 'ghost',
      name: 'x',
    })
    expect(empty.output).toContain('No account matching')
    expect(empty.output).toContain('(none)')

    await mutatePool((pool) => {
      pool.accounts.push(
        account({ id: 'r1', label: 'work', providerID: 'anthropic' }),
      )
    })
    const miss = await hooks.tool.auth_lb_rename.execute({
      account: 'nope',
      name: 'x',
    })
    expect(miss.output).toContain('No account matching')
    expect(miss.output).toContain('work (anthropic)')
  })

  test('auth_lb_rename: renames by label and by id, persisting the new label', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'r1', label: 'old-name' }))
    })
    const hooks = await loadHooks<ToolHooks>(AuthLoadBalancerStatusPlugin)

    const byLabel = await hooks.tool.auth_lb_rename.execute({
      account: 'old-name',
      name: 'mid-name',
    })
    expect(byLabel.title).toBe('Auth Load Balancer')
    expect(byLabel.output).toContain('old-name')
    expect(byLabel.output).toContain('mid-name')
    expect((await readPool()).accounts.find((a) => a.id === 'r1')?.label).toBe(
      'mid-name',
    )

    const byId = await hooks.tool.auth_lb_rename.execute({
      account: 'r1',
      name: 'final-name',
    })
    expect(byId.output).toContain('final-name')
    expect((await readPool()).accounts.find((a) => a.id === 'r1')?.label).toBe(
      'final-name',
    )
  })

  test('primeInUse points the in-use marker at the top-ranked (soonest-reset) account', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(
        account({
          id: 'fresh',
          usage: {
            hourly: null,
            weekly: {
              utilization: 0.05,
              resetAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
            },
            status: null,
            capturedAt: Date.now(),
          },
        }),
        account({
          id: 'soon',
          usage: {
            hourly: null,
            weekly: {
              utilization: 0.6,
              resetAt: Date.now() + 10 * 60 * 60 * 1000,
            },
            status: null,
            capturedAt: Date.now(),
          },
        }),
      )
      pool.lastSelected.anthropic = 'fresh' // stale "last used"
    })
    await primeInUse('anthropic', Date.now())
    // The soonest-resetting account (perishable quota) is ranked #1 and primed in.
    expect((await readPool()).lastSelected.anthropic).toBe('soon')
  })

  test('primeInUse is a no-op when the provider has no usable account', async () => {
    await primeInUse('anthropic', Date.now())
    expect((await readPool()).lastSelected.anthropic).toBeUndefined()
  })

  test('every entry export is a real plugin (a stray/broken export crashes opencode startup)', async () => {
    // opencode's loader treats EVERY value exported by the entry module as a plugin
    // (getLegacyPlugins -> Object.values -> invoke). A non-plugin export gets called
    // with the plugin input; if it resolves to `undefined`, that undefined is pushed
    // into the hook list and later dereferenced (`hook.config?.()`), which 500s
    // /config/providers. So EVERY export must be a function that, given the plugin
    // input, resolves to a hooks OBJECT. (This is exactly the bug a stray `export`ed
    // helper like primeInUse caused — locked here so it can't recur.)
    const mod = await import('../index')
    const exports = Object.values(mod)
    expect(exports.length).toBeGreaterThan(0)
    for (const value of exports) {
      expect(typeof value).toBe('function')
      const hooks = await (
        value as (input: { client: ToastClient }) => Promise<unknown>
      )({ client: noopClient })
      expect(hooks).toBeTypeOf('object')
      expect(hooks).not.toBeNull()
    }
  })
})

describe('bestEffort bookkeeping', () => {
  test('runs the op and resolves on success', async () => {
    let ran = false
    await bestEffort('x', async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test('swallows a LockTimeoutError (a served response is never lost to a bookkeeping lock timeout)', async () => {
    await expect(
      bestEffort('x', async () => {
        throw new LockTimeoutError('/tmp/pool.lock')
      }),
    ).resolves.toBeUndefined()
  })

  test('swallows a PoolWriteError', async () => {
    await expect(
      bestEffort('x', async () => {
        throw new PoolWriteError('/tmp/pool.json', new Error('disk full'))
      }),
    ).resolves.toBeUndefined()
  })

  test('rethrows a non-infrastructure error (a genuine bug must not be hidden)', async () => {
    await expect(
      bestEffort('x', async () => {
        throw new Error('genuine bug')
      }),
    ).rejects.toThrow('genuine bug')
  })
})
