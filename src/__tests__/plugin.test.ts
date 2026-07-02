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
import {
  mutatePool,
  PoolReadError,
  PoolWriteError,
  readPool,
} from '../pool/store'
import { primeInUse } from '../prime'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import { openaiAdapter } from '../providers/openai/adapter'
import { loadConfig } from '../scheduler/config'
import { SESSION_HEADER } from '../session'
import type { PoolAccount } from '../types'
import { refreshUsageInBackground } from '../usage-refresh'
import { testAccount } from './fixtures/account'
import { type Responder, responderFetch } from './fixtures/fetch-mock'

const realFetch = globalThis.fetch
let respond: Responder

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(POOL, { force: true })
  respond = () => new Response('{}', { status: 200 })
  globalThis.fetch = responderFetch(() => respond)
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
  return testAccount({
    id: 'A',
    label: 'A',
    access: 'tokA',
    refresh: 'ref',
    expires: Date.now() + 60 * 60 * 1000,
    usage: {
      hourly: null,
      weekly: { utilization: 0.1, resetAt: Date.now() + 30 * 60 * 60 * 1000 },
      capturedAt: Date.now(),
    },
    createdAt: Date.now(),
    ...over,
  })
}

/**
 * Shared two-account fixture for the rotation/cooldown tests: account A
 * (fresh, usage-less) plus account B (weekly 50%, resets in 30 h) so the
 * scheduler tries A first and has B to rotate onto.
 */
async function seedAB(now: number): Promise<void> {
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
          capturedAt: now,
        },
      }),
    )
  })
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

  test('the empty-pool 401 uses the OpenAI envelope ({ error }, no Anthropic wrapper) for the openai adapter', async () => {
    // Locks the provider-shape ternary in noUsableAccountResponse: only the
    // Anthropic branch wraps the body as { type: 'error', error }; the Codex
    // SDK expects a bare { error }. A regression that always emitted the
    // Anthropic envelope would pass the anthropic-only test above.
    let hit = false
    respond = () => {
      hit = true
      return new Response('default', { status: 200 })
    }
    const lb = createLoadBalancedFetch(openaiAdapter)
    const res = await lb('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      body: '{}',
    })
    expect(hit).toBe(false) // global fetch never called
    expect(res.status).toBe(401)
    const json = (await res.json()) as {
      type?: string
      error?: { type?: string; message?: string }
    }
    expect(json.type).toBeUndefined() // no Anthropic { type: 'error' } wrapper
    expect(json.error?.type).toBe('authentication_error')
    expect(json.error?.message).toContain('auth-load-balancer pool')
  })

  test('all accounts 429 within maxWaitMs: waits out the cooldown, then auto-resumes', async () => {
    // The user-reported failure: the only account returns 429, so pre-fix the request
    // died abruptly. Now the fetch waits out the (Retry-After) cooldown and retries,
    // instead of throwing. retry-after 0.12 s -> ~120 ms cooldown, well inside the 2 s budget.
    process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS = '2000'
    try {
      await mutatePool((pool) => {
        pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      })
      let n = 0
      respond = () => {
        n += 1
        if (n === 1)
          return new Response('limited', {
            status: 429,
            headers: { 'retry-after': '0.12' },
          })
        return new Response('ok', { status: 200 })
      }
      const lb = createLoadBalancedFetch(anthropicAdapter)
      const start = Date.now()
      const res = await lb('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      })
      expect(res.status).toBe(200)
      expect(n).toBe(2) // 429, then (after waiting) the successful retry
      expect(Date.now() - start).toBeGreaterThanOrEqual(50) // it actually waited
    } finally {
      delete process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS
    }
  })

  test('fails fast (no wait) when the soonest cooldown is beyond maxWaitMs', async () => {
    // A quota-reset 429 (Retry-After 5 s) with a tiny 20 ms budget: blocking for the
    // full 5 s would be worse than failing, so it throws immediately as before.
    process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS = '20'
    try {
      await mutatePool((pool) => {
        pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      })
      let n = 0
      respond = () => {
        n += 1
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '5' },
        })
      }
      const lb = createLoadBalancedFetch(anthropicAdapter)
      const start = Date.now()
      await expect(
        lb('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      ).rejects.toThrow('returned 429')
      expect(Date.now() - start).toBeLessThan(1000) // did NOT wait the 5 s cooldown
      expect(n).toBe(1) // tried once, no wait-and-retry
    } finally {
      delete process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS
    }
  })

  test('a client abort during the cooldown wait propagates the abort and does not retry', async () => {
    process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS = '5000'
    try {
      await mutatePool((pool) => {
        pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      })
      const ac = new AbortController()
      let n = 0
      respond = () => {
        n += 1
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '2' },
        })
      }
      const lb = createLoadBalancedFetch(anthropicAdapter)
      const start = Date.now()
      const p = lb('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
        signal: ac.signal,
      })
      setTimeout(() => ac.abort(), 30) // abort while the ~2 s wait is in progress
      await expect(p).rejects.toBeDefined()
      expect(Date.now() - start).toBeLessThan(1000) // woke on abort, not after 2 s
      expect(n).toBe(1) // 429 once; the wait was interrupted, no retry
    } finally {
      delete process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS
    }
  })

  test('an auth (401) cooldown is NOT waited out — the request fails fast', async () => {
    // Guard: only account-class (429/402) cooldowns are waitable. A 401 needs a
    // re-login, not time, so despite a generous budget the request must fail fast.
    process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS = '5000'
    try {
      await mutatePool((pool) => {
        pool.accounts.push(account({ id: 'A', access: 'tokA' }))
      })
      let n = 0
      respond = () => {
        n += 1
        return new Response('unauthorized', { status: 401 })
      }
      const lb = createLoadBalancedFetch(anthropicAdapter)
      const start = Date.now()
      await expect(
        lb('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          body: '{}',
        }),
      ).rejects.toThrow('returned 401')
      expect(Date.now() - start).toBeLessThan(1000) // no wait despite the 5 s budget
      expect(n).toBe(1) // one 401, no wait-and-retry (auth is not waitable)
    } finally {
      delete process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS
    }
  })

  test('multi-account 429 wait resumes at the SOONEST cooldown, not the latest', async () => {
    // Every existing wait test seeds ONE account, so `soonestCooldownUntil`'s
    // minimum scan (`if (account.cooldownUntil < soonest) …`) is never exercised
    // with 2+ waitable accounts — a regression returning the LATEST (or first
    // found) cooldown would pass the suite while over-blocking a recoverable
    // pool. Here A cools for 3 s and B for ~120 ms: the fetch must wait only
    // B's ~120 ms and resume on B (A is still cooling).
    process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS = '5000'
    try {
      const now = Date.now()
      await seedAB(now)
      let n = 0
      const auths: (string | null)[] = []
      respond = (_url, init) => {
        n += 1
        auths.push(
          new Headers(init?.headers as HeadersInit | undefined).get(
            'authorization',
          ),
        )
        if (n === 1)
          return new Response('limited', {
            status: 429,
            headers: { 'retry-after': '3' },
          })
        if (n === 2)
          return new Response('limited', {
            status: 429,
            headers: { 'retry-after': '0.12' },
          })
        return new Response('ok', { status: 200 })
      }
      const lb = createLoadBalancedFetch(anthropicAdapter)
      const start = Date.now()
      const res = await lb('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        body: '{}',
      })
      const elapsed = Date.now() - start
      expect(res.status).toBe(200)
      expect(n).toBe(3) // A 429, B 429, then (after waiting out B) the retry
      expect(elapsed).toBeGreaterThanOrEqual(50) // it actually waited B's ~120 ms
      expect(elapsed).toBeLessThan(2000) // …but NOT A's 3 s cooldown
      expect(auths[2]).toBe('Bearer tokB') // resumed on B — the soonest to recover
    } finally {
      delete process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS
    }
  })

  /**
   * Shared skeleton for the 429 retry-after cooldown tests below: seed the
   * two-account fixture, answer the first request with a 429 carrying the
   * given `retry-after` header (then 200), run one load-balanced POST, assert
   * it rotated to a 200, and return account A's resulting cooldown alongside
   * the `now` the seed used. Each test keeps its OWN expected-window
   * assertions (HTTP-date tests build their header string before calling;
   * their ±2 s tolerances absorb the sub-ms `now` skew).
   */
  async function cooldownAfter429(
    retryAfter: string,
  ): Promise<{ now: number; cooldownUntil: number | undefined }> {
    const now = Date.now()
    await seedAB(now)
    let n = 0
    respond = () => {
      n += 1
      if (n === 1)
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': retryAfter },
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
    return { now, cooldownUntil: cooled?.cooldownUntil }
  }

  test('honors retry-after when cooling down a rate-limited account', async () => {
    const { now, cooldownUntil } = await cooldownAfter429('30')
    expect(cooldownUntil).toBeGreaterThan(now + 25_000)
  })

  test('honors retry-after HTTP-date form (RFC 9110) when cooling down', async () => {
    // 90 minutes ahead — well outside both the 5 min ACCOUNT and 2 min AUTH fallback,
    // so a pre-fix code path (which only parses delay-seconds) would land near now+5min
    // and FAIL this assertion. Only the HTTP-date branch can satisfy the ±2s window.
    const futureMs = Date.now() + 90 * 60_000
    const httpDate = new Date(futureMs).toUTCString()
    const { cooldownUntil } = await cooldownAfter429(httpDate)
    // HTTP-date has second resolution; toUTCString truncates ms, so the cooled
    // value lands within one second below futureMs. Allow a ±2 s window.
    expect(cooldownUntil).toBeGreaterThanOrEqual(futureMs - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(futureMs + 2_000)
  })

  test('falls back to default cooldown when retry-after is unparseable', async () => {
    const { now, cooldownUntil } = await cooldownAfter429('garbage')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
  })

  test('falls back to default cooldown when retry-after seconds overflow numeric precision', async () => {
    // Regression lock: `Number("1e308") = 1e308` is finite, but `1e308 * 1000`
    // exceeds Number.MAX_VALUE (~1.798e308) and collapses to +Infinity. Before
    // the fix in applyCooldown, that set cooldownUntil to +Infinity, and the
    // scheduler's `account.cooldownUntil > now` check then excluded the account
    // forever (only a process restart or manual pool-file edit could recover it).
    // Post-fix the overflowing delta falls through to the ACCOUNT_COOLDOWN_MS
    // (5 min) fallback, just like the unparseable-retry-after branch above.
    const { now, cooldownUntil } = await cooldownAfter429('1e308')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    // The locking assertion: a regression that re-introduces the overflow path
    // sets cooldownUntil to +Infinity, which fails Number.isFinite.
    expect(Number.isFinite(cooldownUntil ?? Infinity)).toBe(true)
  })

  test('falls back to default cooldown when retry-after is "0" (server says retry immediately)', async () => {
    // Regression lock: `Number('0') = 0` is finite but `0 > 0` is false, so the
    // delay-seconds branch is skipped. `Date.parse('0')` either yields a finite
    // epoch-ms in the past (year 2000 on V8/Bun) or NaN depending on engine;
    // both paths fail the `Number.isFinite(httpDate) && httpDate > now` HTTP-date
    // gate, landing on the 5-min ACCOUNT_COOLDOWN_MS fallback. A regression that
    // flipped `httpDate > now` to `<` would silently pass the 'garbage' test
    // (NaN trips Number.isFinite first) but cool A out to the year 2000 here.
    const { now, cooldownUntil } = await cooldownAfter429('0')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    expect(Number.isFinite(cooldownUntil ?? Infinity)).toBe(true)
  })

  test('falls back to default cooldown when retry-after is a negative integer', async () => {
    // Regression lock: `Number('-10') = -10` is finite but `> 0` is false, so
    // the delay-seconds branch is skipped. `Date.parse('-10')` yields a finite
    // epoch-ms in the past (or NaN), which fails the `httpDate > now` gate —
    // the parser falls through to ACCOUNT_COOLDOWN_MS. Same regression family as
    // the '0' case: a flipped comparison would cool A out to a past date.
    const { now, cooldownUntil } = await cooldownAfter429('-10')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    expect(Number.isFinite(cooldownUntil ?? Infinity)).toBe(true)
  })

  test('honors retry-after for a large-but-valid delay-seconds (1 day)', async () => {
    // Regression lock: 86400 seconds (1 day) exercises the non-overflowing
    // finite-delta branch at the upper end of the practical range. The existing
    // '30' test pins behavior near the lower end; the '1e308' test pins the
    // OVERFLOW fallback; this test pins the accepted-finite-delta path itself.
    // A regression that tightened the RETRY_AFTER_MAX_MS bound (8 days) below
    // the practical quota range would silently pass '30' but break '86400'.
    const { now, cooldownUntil } = await cooldownAfter429('86400')
    // The non-overflowing finite-delta path: `until = now + 86_400 * 1000`.
    // Allow ±2 s of clock drift.
    const expected = now + 86_400 * 1000
    expect(cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
    expect(Number.isFinite(cooldownUntil ?? Infinity)).toBe(true)
  })

  test('falls back to default cooldown when retry-after seconds are finite but absurd (beyond any quota window)', async () => {
    // Regression lock for the RETRY_AFTER_MAX_MS bound on the delay-seconds
    // branch: `Number('10000000000') = 1e10` is finite and `1e10 * 1000 = 1e13`
    // does NOT overflow to Infinity — so the old Number.isFinite-only guard
    // accepted it and sidelined the account for ~317 years (persisted to the
    // pool file, surviving restarts; usage polls never clear cooldownUntil).
    // Real quota Retry-After values are bounded by the weekly window (≤ 7 d);
    // anything beyond the 8-day bound must fall through to the 5-min
    // ACCOUNT_COOLDOWN_MS fallback, exactly like the '1e308' overflow case.
    const { now, cooldownUntil } = await cooldownAfter429('10000000000')
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
  })

  test('falls back to default cooldown when retry-after HTTP-date is decades in the future', async () => {
    // Regression lock for the RETRY_AFTER_MAX_MS bound on the HTTP-date branch,
    // which previously had NO upper bound at all: a far-future date (broken
    // server clock or proxy) parsed to a finite epoch and sidelined the account
    // until that date. Past the 8-day bound it must fall through to the 5-min
    // ACCOUNT_COOLDOWN_MS fallback; the sane 90-min HTTP-date test above pins
    // the still-honored side of the bound.
    const farFuture = new Date(
      Date.now() + 30 * 365 * 24 * 60 * 60_000,
    ).toUTCString()
    const { now, cooldownUntil } = await cooldownAfter429(farFuture)
    // ACCOUNT_COOLDOWN_MS = 5 * 60 * 1000 (5 min). Allow ±2 s of clock drift.
    const expected = now + 5 * 60_000
    expect(cooldownUntil).toBeGreaterThanOrEqual(expected - 2_000)
    expect(cooldownUntil).toBeLessThanOrEqual(expected + 2_000)
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
    await seedAB(now)
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
    await seedAB(now)
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
    expect(pool.sessions['anthropic:s:svc']?.accountId).toBe('A')
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
            capturedAt: now,
          },
        }),
      )
      pool.sessions['anthropic:s:cjk'] = { accountId: 'B', updatedAt: now }
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

  test('recordSuccess prunes stale session-affinity entries past sessionTtlMs', async () => {
    // The TTL-prune branch in recordSuccess (fetch.ts) (`delete pool.sessions[key]` when
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
    expect(pool.sessions['anthropic:s:new']).toBeDefined()
  })

  test('cross-provider session keys are namespaced — anthropic and openai pins coexist without overwrite', async () => {
    // Regression lock for cross-provider session-affinity collision.
    // opencode supports model switching mid-conversation: a single session can
    // alternate between Claude (anthropic) and Codex (openai). Pre-fix,
    // deriveSessionKey returned the SAME `s:<sessionID>` for BOTH providers, so
    // `pool.sessions['s:<sessionID>']` was overwritten by whichever provider ran
    // most recently. findPinned's providerID check (src/scheduler/select.ts)
    // prevented serving the WRONG account on lookup (it returns null when the
    // pinned account's providerID doesn't match the asking provider), but
    // could NOT undo the overwrite — so the original provider's prompt-cache
    // affinity was silently dropped on its next turn, re-billing full context
    // onto a fresh account. Post-fix the session key is namespaced by
    // `${adapter.id}:${baseKey}`, so the two providers occupy disjoint key
    // spaces and never collide. A regression that drops the namespace prefix
    // (or namespaces with anything non-injective per providerID) would
    // resurrect the bug: this test fails on the coexistence assertion below.
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'tokA', label: 'A' }))
      pool.accounts.push(
        account({
          id: 'O',
          providerID: 'openai',
          access: 'tokO',
          label: 'O',
          accountId: 'acc_O',
          usage: {
            hourly: null,
            weekly: {
              utilization: 0.1,
              resetAt: now + 30 * 60 * 60 * 1000,
            },
            capturedAt: now,
          },
        }),
      )
    })

    const seen: { auth: string | null }[] = []
    respond = (_url, init) => {
      seen.push({
        auth: new Headers(init?.headers as HeadersInit | undefined).get(
          'authorization',
        ),
      })
      return new Response('ok', { status: 200 })
    }
    const lbAnthropic = createLoadBalancedFetch(anthropicAdapter)
    const lbOpenai = createLoadBalancedFetch(openaiAdapter)

    // 1. anthropic request with SESSION_HEADER 'shared' -> A served.
    //    Post-fix this pins `anthropic:s:shared = A`.
    const r1 = await lbAnthropic('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
      headers: { [SESSION_HEADER]: 'shared' },
    })
    expect(r1.status).toBe(200)

    // 2. openai request with the SAME SESSION_HEADER -> O served.
    //    Pre-fix this OVERWRITES `s:shared` from A to O. Post-fix it writes a
    //    SEPARATE key `openai:s:shared = O`, leaving A's pin intact.
    const r2 = await lbOpenai('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      }),
      headers: { [SESSION_HEADER]: 'shared' },
    })
    expect(r2.status).toBe(200)

    // 3. anthropic request with the SAME SESSION_HEADER -> A served (still pinned).
    const r3 = await lbAnthropic('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
      headers: { [SESSION_HEADER]: 'shared' },
    })
    expect(r3.status).toBe(200)

    // Each call hit its provider's account exactly once with the expected token.
    expect(seen).toHaveLength(3)
    expect(seen[0]?.auth).toBe('Bearer tokA')
    expect(seen[1]?.auth).toBe('Bearer tokO')
    expect(seen[2]?.auth).toBe('Bearer tokA')

    // LOCKING ASSERTION: BOTH provider pins coexist in pool.sessions under
    // disjoint namespaced keys. Pre-fix only one key existed (`s:shared`), and
    // it pointed at whichever provider ran most recently (here, A — because the
    // last write overwrites). Post-fix both keys exist independently.
    const pool = await readPool()
    expect(pool.sessions['anthropic:s:shared']?.accountId).toBe('A')
    expect(pool.sessions['openai:s:shared']?.accountId).toBe('O')
    // The legacy provider-agnostic key is NEVER written post-fix.
    expect(pool.sessions['s:shared']).toBeUndefined()
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
    // Respond WITH usage headers: the toast must show the response's FRESH
    // weekly utilization (33%), not the pre-request pool snapshot (10% from
    // the `account()` fixture) — the fetch applies the parsed headers to its
    // local account object before `hooks.onUse` fires.
    const resetSecs = Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000)
    respond = () =>
      new Response('ok', {
        status: 200,
        headers: {
          'anthropic-ratelimit-unified-7d-utilization': '0.33',
          'anthropic-ratelimit-unified-7d-reset': String(resetSecs),
        },
      })
    await opts.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('toast-acct')
    expect(toasts[0]).toContain('weekly 33%')
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

  test('auth_lb_rename: rejects an empty or whitespace-only new label without mutating', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'r1', label: 'keep-me' }))
    })
    const hooks = await loadHooks<ToolHooks>(AuthLoadBalancerStatusPlugin)

    const empty = await hooks.tool.auth_lb_rename.execute({
      account: 'r1',
      name: '',
    })
    expect(empty.output).toContain('must not be empty')

    const blank = await hooks.tool.auth_lb_rename.execute({
      account: 'r1',
      name: '   ',
    })
    expect(blank.output).toContain('must not be empty')
    expect((await readPool()).accounts.find((a) => a.id === 'r1')?.label).toBe(
      'keep-me',
    )
  })

  test('auth_lb_rename: rejects a label already used by ANOTHER account (rename-by-label stays unambiguous), but allows renaming an account to its own label', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(
        account({ id: 'r1', label: 'alpha' }),
        account({ id: 'r2', label: 'beta' }),
      )
    })
    const hooks = await loadHooks<ToolHooks>(AuthLoadBalancerStatusPlugin)

    const clash = await hooks.tool.auth_lb_rename.execute({
      account: 'r2',
      name: 'alpha',
    })
    expect(clash.output).toContain('already used by another account')
    expect((await readPool()).accounts.find((a) => a.id === 'r2')?.label).toBe(
      'beta',
    )

    // Self-rename (e.g. re-applying the same label) is not a collision.
    const self = await hooks.tool.auth_lb_rename.execute({
      account: 'r1',
      name: 'alpha',
    })
    expect(self.output).toContain('Renamed "alpha" → "alpha"')
  })

  test('auth_lb_rename: trims surrounding whitespace before persisting the new label', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'r1', label: 'old' }))
    })
    const hooks = await loadHooks<ToolHooks>(AuthLoadBalancerStatusPlugin)

    const result = await hooks.tool.auth_lb_rename.execute({
      account: 'r1',
      name: '  spaced-name  ',
    })
    expect(result.output).toContain('Renamed "old" → "spaced-name"')
    expect((await readPool()).accounts.find((a) => a.id === 'r1')?.label).toBe(
      'spaced-name',
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

describe('out-of-band weekly reset (e.g. a promotional server-side quota reset)', () => {
  test('a response carrying only 5h/status headers must NOT mark the weekly snapshot fresh — the endpoint re-poll then picks up the reset', async () => {
    const now = Date.now()
    const seedAt = now - 60_000 // fresh (< SEED_TTL_MS) but distinguishable from `now`
    await mutatePool((pool) => {
      pool.accounts.push(
        account({
          id: 'reset-hdr',
          label: 'reset-hdr',
          usage: {
            hourly: null,
            weekly: { utilization: 0.9, resetAt: now + 30 * 60 * 60 * 1000 },
            capturedAt: seedAt,
          },
        }),
      )
    })
    // Post-reset upstream shape: the fresh (empty) weekly window reports nothing,
    // so the response carries ONLY the 5h + status headers.
    respond = (url) => {
      if (url.includes('/v1/messages'))
        return new Response('ok', {
          status: 200,
          headers: {
            'anthropic-ratelimit-unified-5h-utilization': '0.20',
            'anthropic-ratelimit-unified-5h-reset': String(
              Math.floor((now + 5 * 60 * 60 * 1000) / 1000),
            ),
            'anthropic-ratelimit-unified-status': 'allowed',
          },
        })
      return new Response('{}', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)

    const after = (await readPool()).accounts.find((x) => x.id === 'reset-hdr')
    // Present fields merged...
    expect(after?.usage.hourly?.utilization).toBeCloseTo(0.2, 5)
    // ...but weekly is untouched AND the snapshot is NOT stamped fresh (the
    // pre-fix unconditional `capturedAt = now` here suppressed the usage-endpoint
    // re-poll forever, pinning the pre-reset 90% on the active account).
    expect(after?.usage.weekly?.utilization).toBeCloseTo(0.9, 5)
    expect(after?.usage.capturedAt).toBe(seedAt)

    // Once the snapshot ages past SEED_TTL_MS, the authoritative endpoint poll
    // must land the server-side reset (weekly -> 0%).
    await mutatePool((pool) => {
      const stored = pool.accounts.find((x) => x.id === 'reset-hdr')
      if (stored) stored.usage.capturedAt = Date.now() - 6 * 60_000
    })
    const weeklyResetSec = Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000)
    respond = (url) => {
      if (url.includes('/api/oauth/usage'))
        return new Response(
          JSON.stringify({
            five_hour: {
              utilization: 12,
              resets_at: Math.floor((now + 5 * 60 * 60 * 1000) / 1000),
            },
            seven_day: { utilization: 0, resets_at: weeklyResetSec },
          }),
          { status: 200 },
        )
      return new Response('{}', { status: 200 })
    }
    await refreshUsageInBackground(anthropicAdapter, Date.now())
    const reset = (await readPool()).accounts.find((x) => x.id === 'reset-hdr')
    expect(reset?.usage.weekly?.utilization).toBe(0)
    expect(reset?.usage.weekly?.resetAt).toBe(weeklyResetSec * 1000)
    expect(reset?.usage.capturedAt).toBeGreaterThan(seedAt)
  })

  test('a header response without a 7d reset keeps the previously seen FIXED weekly anchor', async () => {
    const now = Date.now()
    const anchor = now + 7 * 60 * 60 * 1000 // fixed weekly anchor 7h away
    await mutatePool((pool) => {
      pool.accounts.push(
        account({
          id: 'anchor-keep',
          label: 'anchor-keep',
          usage: {
            hourly: null,
            weekly: { utilization: 0.9, resetAt: anchor },
            capturedAt: now,
          },
        }),
      )
    })
    // Post-reset shape: utilization comes back (0) but the reset header is
    // absent. The anchor is a FIXED per-account time — losing it made the
    // scheduler assume a week of slack for a reset that is 7 hours away.
    respond = (url) => {
      if (url.includes('/v1/messages'))
        return new Response('ok', {
          status: 200,
          headers: { 'anthropic-ratelimit-unified-7d-utilization': '0' },
        })
      return new Response('{}', { status: 200 })
    }
    const lb = createLoadBalancedFetch(anthropicAdapter)
    const res = await lb('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(200)
    const after = (await readPool()).accounts.find(
      (x) => x.id === 'anchor-keep',
    )
    expect(after?.usage.weekly).toEqual({ utilization: 0, resetAt: anchor })
  })

  test('auth_lb_status re-polls stale accounts before rendering, so the reset shows without any model request', async () => {
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts.push(
        account({
          id: 'status-stale',
          label: 'status-stale',
          usage: {
            hourly: null,
            weekly: { utilization: 0.9, resetAt: now + 30 * 60 * 60 * 1000 },
            capturedAt: 0, // stale -> the status tool's refresh must poll it
          },
        }),
      )
      pool.lastSelected.anthropic = 'status-stale'
    })
    respond = (url) => {
      if (url.includes('/api/oauth/usage'))
        return new Response(
          JSON.stringify({
            five_hour: {
              utilization: 1,
              resets_at: Math.floor((now + 5 * 60 * 60 * 1000) / 1000),
            },
            seven_day: {
              utilization: 3,
              resets_at: Math.floor((now + 7 * 24 * 60 * 60 * 1000) / 1000),
            },
          }),
          { status: 200 },
        )
      return new Response('{}', { status: 200 })
    }
    const hooks = await loadHooks<ToolHooks>(AuthLoadBalancerStatusPlugin)
    const result = await hooks.tool.auth_lb_status.execute()
    // The rendered dashboard reflects the POST-reset weekly (3%), not the stale 90%.
    expect(result.output).toContain('status-stale')
    expect(result.output).toContain('3%')
    expect(result.output).not.toContain('90%')
    const stored = (await readPool()).accounts.find(
      (x) => x.id === 'status-stale',
    )
    expect(stored?.usage.weekly?.utilization).toBeCloseTo(0.03, 5)
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

  test('swallows a PoolReadError (a transient read fault must not fail a served response)', async () => {
    await expect(
      bestEffort('x', async () => {
        throw new PoolReadError('/tmp/pool.json', new Error('EBUSY'))
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
