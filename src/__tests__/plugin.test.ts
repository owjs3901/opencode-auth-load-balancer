import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-plugin-'))
const POOL = join(DIR, 'auth-load-balancer.json')

import { createLoadBalancedFetch } from '../fetch'
import {
  AnthropicLoadBalancerPlugin,
  AuthLoadBalancerStatusPlugin,
  OpenAILoadBalancerPlugin,
} from '../index'
import type { ToastClient } from '../notify'
import { mutatePool, readPool } from '../pool/store'
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
  test('falls back to the default fetch when the pool has no accounts', async () => {
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
    expect(hit).toBe(true)
    expect(await res.text()).toBe('default')
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
