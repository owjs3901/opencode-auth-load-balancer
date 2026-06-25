import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, test } from 'bun:test'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-stateful-'))
const POOL = join(DIR, 'auth-load-balancer.json')

import { addAccount, bootstrapFromOpencodeAuth } from '../accounts'
import {
  findAccount,
  type FsOps,
  mutatePool,
  readPool,
  writeJsonAtomic,
} from '../pool/store'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import { openaiAdapter } from '../providers/openai/adapter'
import type { ProviderAdapter } from '../providers/types'
import { ensureAccessToken, needsRefresh } from '../refresh'
import type { PoolAccount, TokenSet, UsageSnapshot } from '../types'
import { refreshUsageInBackground } from '../usage-refresh'

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(POOL, { force: true })
})

let seq = 0
function account(over: Partial<PoolAccount> = {}): PoolAccount {
  seq += 1
  return {
    id: `acc-${seq}`,
    providerID: 'anthropic',
    label: `acc-${seq}`,
    access: 'tok',
    refresh: 'ref',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: null,
    usage: { hourly: null, weekly: null, status: null, capturedAt: Date.now() },
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: Date.now(),
    lastUsedAt: 0,
    ...over,
  }
}

function fakeAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: 'anthropic',
    authorize: async () => ({
      url: '',
      verifier: '',
      state: '',
      redirectUri: '',
    }),
    exchange: async () => null,
    refresh: async () => ({
      access: 'new',
      refresh: 'newref',
      expires: Date.now() + 3_600_000,
    }),
    applyAuth: () => undefined,
    transformUrl: (i) => i,
    transformBody: (b) => b,
    transformResponse: (r) => r,
    parseUsageHeaders: () => null,
    fetchUsage: async () => null,
    classifyError: () => 'ok',
    ...over,
  }
}

describe('pool store', () => {
  test('readPool returns empty on a corrupt/unknown-version file', async () => {
    await writeFile(POOL, JSON.stringify({ version: 2, accounts: [] }))
    expect((await readPool()).accounts).toHaveLength(0)
  })

  test('mutatePool persists, readPool reflects, findAccount locates', async () => {
    const a = account()
    await mutatePool((pool) => {
      pool.accounts.push(a)
    })
    const pool = await readPool()
    expect(pool.accounts).toHaveLength(1)
    expect(findAccount(pool, a.id)?.id).toBe(a.id)
    expect(findAccount(pool, 'missing')).toBeUndefined()
  })

  test('writeJsonAtomic falls back to a direct write when rename fails', async () => {
    const writes: string[] = []
    const ops: FsOps = {
      mkdir: async () => undefined,
      writeFile: async (path) => {
        writes.push(path)
      },
      rename: async () => {
        throw new Error('EPERM')
      },
      unlink: async () => {
        throw new Error('gone') // rejects -> exercises the shared `ignore`
      },
    }
    await writeJsonAtomic('/data/pool.json', '{}', ops)
    expect(writes).toContain('/data/pool.json') // fallback wrote directly to the target
    expect(writes).toHaveLength(2) // tmp (try) + target (fallback)
  })
})

describe('refresh', () => {
  test('needsRefresh reflects expiry and missing token', () => {
    expect(
      needsRefresh(
        account({ expires: Date.now() + 60 * 60 * 1000 }),
        Date.now(),
      ),
    ).toBe(false)
    expect(needsRefresh(account({ expires: Date.now() - 1 }), Date.now())).toBe(
      true,
    )
    expect(needsRefresh(account({ access: '' }), Date.now())).toBe(true)
  })

  test('returns the current token when no refresh is needed', async () => {
    const a = account({
      access: 'current',
      expires: Date.now() + 60 * 60 * 1000,
    })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        return { access: 'x', refresh: 'y', expires: 0 }
      },
    })
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe('current')
    expect(called).toBe(0)
  })

  test('refreshes, persists the rotated token, and updates the account in place', async () => {
    const a = account({ access: 'old', expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const tokens: TokenSet = {
      access: 'fresh',
      refresh: 'rotated',
      expires: Date.now() + 3_600_000,
      accountId: 'acc_x',
    }
    const adapter = fakeAdapter({ refresh: async () => tokens })
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe('fresh')
    expect(a.access).toBe('fresh')
    expect(a.accountId).toBe('acc_x')
    expect(findAccount(await readPool(), a.id)?.refresh).toBe('rotated')
  })

  test('disables the account on invalid_grant and rethrows', async () => {
    const a = account({ expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error('invalid_grant')
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      'invalid_grant',
    )
    expect(a.disabledReason).toContain('invalid_grant')
    expect(findAccount(await readPool(), a.id)?.disabledReason).toContain(
      'invalid_grant',
    )
  })

  test('does NOT disable an account when a 5xx body coincidentally contains "400"', async () => {
    // Regression: pre-fix, /\b400\b|\b401\b/ matched the FULL error message,
    // which includes the upstream response body. A 502 whose body mentions
    // "HTTP 400" anywhere would permanently mark a working account as needing
    // re-login. The fix anchors the status check to the "Token refresh failed:
    // <status>" prefix that both OAuth refresh paths actually throw.
    const a = account({ expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error(
          'Token refresh failed: 502 — Bad Gateway. See status page: HTTP 400 fallback active.',
        )
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      '502',
    )
    expect(a.disabledReason).toBeNull()
    expect(
      findAccount(await readPool(), a.id)?.disabledReason ?? null,
    ).toBeNull()
  })

  test('still disables on a real 400 invalid_grant from the OAuth server', async () => {
    // The status-anchored prefix path (status === 400/401) must keep working
    // even when the body does NOT carry the literal "invalid_grant" substring.
    const a = account({ expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error(
          'Token refresh failed: 400 — {"error":"unauthorized_client"}',
        )
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      '400',
    )
    expect(a.disabledReason).toContain('invalid_grant')
    expect(findAccount(await readPool(), a.id)?.disabledReason).toContain(
      'invalid_grant',
    )
  })

  test('collapses concurrent refreshes (singleflight)', async () => {
    const a = account({ expires: Date.now() - 1 })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 10))
        return {
          access: 'fresh',
          refresh: 'r2',
          expires: Date.now() + 3_600_000,
        }
      },
    })
    await Promise.all([
      ensureAccessToken(adapter, a, Date.now()),
      ensureAccessToken(adapter, a, Date.now()),
    ])
    expect(called).toBe(1)
  })

  test("singleflight updates EVERY concurrent caller's account, not just the one that started the refresh", async () => {
    // Production fan-out: two parallel requests each call readPool() and
    // therefore hold DIFFERENT PoolAccount objects with the same id. The
    // singleflight short-circuit must mutate both — otherwise the reuser
    // sends the OLD token and the upstream 401's a perfectly fresh account.
    const a1 = account({
      id: 'shared',
      access: 'old',
      refresh: 'r-old',
      expires: Date.now() - 1,
    })
    const a2 = { ...a1 } // distinct object, same id, same stale token
    await mutatePool((pool) => {
      pool.accounts.push({ ...a1 })
    })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 10))
        return {
          access: 'fresh',
          refresh: 'r-new',
          expires: Date.now() + 3_600_000,
          accountId: 'acc_x',
        }
      },
    })
    const [t1, t2] = await Promise.all([
      ensureAccessToken(adapter, a1, Date.now()),
      ensureAccessToken(adapter, a2, Date.now()),
    ])
    expect(called).toBe(1)
    expect(t1).toBe('fresh')
    expect(t2).toBe('fresh')
    expect(a1.access).toBe('fresh')
    expect(a2.access).toBe('fresh') // would be 'old' against pre-fix code
    expect(a1.refresh).toBe('r-new')
    expect(a2.refresh).toBe('r-new')
    expect(a1.accountId).toBe('acc_x')
    expect(a2.accountId).toBe('acc_x')
  })
})

describe('accounts', () => {
  test('addAccount appends and de-dupes by refresh token', async () => {
    const tokens: TokenSet = { access: 'a', refresh: 'shared', expires: 1 }
    const first = await addAccount('anthropic', tokens, 'first')
    const again = await addAccount(
      'anthropic',
      { ...tokens, access: 'a2' },
      'second',
    )
    expect(again.id).toBe(first.id) // same refresh -> same account, refreshed
    expect(again.access).toBe('a2')
    const pool = await readPool()
    expect(
      pool.accounts.filter((x) => x.providerID === 'anthropic'),
    ).toHaveLength(1)
    await addAccount('anthropic', { access: 'b', refresh: 'other', expires: 1 })
    expect((await readPool()).accounts).toHaveLength(2)
  })

  test('bootstrap imports an existing opencode oauth credential once', async () => {
    await bootstrapFromOpencodeAuth('anthropic', async () => ({
      type: 'oauth',
      access: 'imp',
      refresh: 'impref',
      expires: 123,
    }))
    expect((await readPool()).accounts).toHaveLength(1)
    // second call is a no-op (already has an account)
    await bootstrapFromOpencodeAuth('anthropic', async () => ({
      type: 'oauth',
      access: 'x',
      refresh: 'y',
      expires: 1,
    }))
    expect((await readPool()).accounts).toHaveLength(1)
  })

  test('bootstrap skips non-oauth auth and swallows a throwing getAuth', async () => {
    await bootstrapFromOpencodeAuth('anthropic', async () => ({ type: 'api' }))
    expect((await readPool()).accounts).toHaveLength(0)
    await bootstrapFromOpencodeAuth('anthropic', async () => {
      throw new Error('no auth')
    })
    expect((await readPool()).accounts).toHaveLength(0)
  })
})

describe('usage-refresh', () => {
  test('seeds usage for a stale account via the usage endpoint', async () => {
    const a = account({
      usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const snapshot: UsageSnapshot = {
      hourly: { utilization: 0.1, resetAt: 0 },
      weekly: { utilization: 0.4, resetAt: 0 },
      status: null,
      capturedAt: Date.now(),
    }
    let fetched = 0
    const adapter = fakeAdapter({
      fetchUsage: async () => {
        fetched += 1
        return snapshot
      },
    })
    await refreshUsageInBackground(adapter, Date.now())
    expect(fetched).toBe(1)
    expect(
      findAccount(await readPool(), a.id)?.usage.weekly?.utilization,
    ).toBeCloseTo(0.4, 5)
  })

  test('skips fresh accounts and a null usage result', async () => {
    const fresh = account({
      usage: {
        hourly: null,
        weekly: null,
        status: null,
        capturedAt: Date.now(),
      },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...fresh })
    })
    let fetched = 0
    const adapter = fakeAdapter({
      fetchUsage: async () => {
        fetched += 1
        return null
      },
    })
    await refreshUsageInBackground(adapter, Date.now())
    expect(fetched).toBe(0) // fresh -> not polled
  })

  test('swallows errors from the refresh/usage path', async () => {
    const a = account({
      expires: Date.now() - 1,
      usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error('boom')
      },
    })
    await expect(
      refreshUsageInBackground(adapter, Date.now()),
    ).resolves.toBeUndefined()
  })
})

describe('adapter delegation', () => {
  test('anthropic adapter wires transforms, usage, and error classification', async () => {
    expect((await anthropicAdapter.authorize()).url).toContain('claude.ai')
    const h = new Headers()
    anthropicAdapter.applyAuth(h, account({ access: 'tokA' }))
    expect(h.get('authorization')).toBe('Bearer tokA')
    expect(
      anthropicAdapter
        .transformUrl('https://api.anthropic.com/v1/messages')
        .toString(),
    ).toContain('beta=true')
    expect(
      anthropicAdapter.transformBody(JSON.stringify({ messages: [] })),
    ).toContain('Claude Agent SDK')
    expect(
      anthropicAdapter.transformResponse(new Response('{"name":"mcp_Bash"}')),
    ).toBeInstanceOf(Response)
    expect(anthropicAdapter.parseUsageHeaders(new Headers(), 0)).toBeNull()
    expect(anthropicAdapter.classifyError(429)).toBe('account')
    expect(anthropicAdapter.classifyError(402)).toBe('account')
    expect(anthropicAdapter.classifyError(401)).toBe('auth')
    expect(anthropicAdapter.classifyError(403)).toBe('auth')
    expect(anthropicAdapter.classifyError(503)).toBe('service')
    expect(anthropicAdapter.classifyError(200)).toBe('ok')
  })

  test('openai adapter wires transforms, usage, and error classification', async () => {
    expect((await openaiAdapter.authorize()).url).toContain('auth.openai.com')
    const h = new Headers()
    openaiAdapter.applyAuth(
      h,
      account({ providerID: 'openai', access: 'tokO', accountId: 'acc' }),
    )
    expect(h.get('authorization')).toBe('Bearer tokO')
    expect(
      openaiAdapter
        .transformUrl('https://api.openai.com/v1/responses')
        .toString(),
    ).toContain('codex/responses')
    expect(
      JSON.parse(openaiAdapter.transformBody(JSON.stringify({}))).store,
    ).toBe(false)
    expect(openaiAdapter.transformResponse(new Response('x'))).toBeInstanceOf(
      Response,
    )
    expect(openaiAdapter.parseUsageHeaders(new Headers(), 0)).toBeNull()
    expect(openaiAdapter.classifyError(429)).toBe('account')
    expect(openaiAdapter.classifyError(401)).toBe('auth')
    expect(openaiAdapter.classifyError(500)).toBe('service')
    expect(openaiAdapter.classifyError(200)).toBe('ok')
  })

  test('adapter exchange/refresh/fetchUsage delegate to the network layer', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 1,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch
    try {
      expect(
        await anthropicAdapter.exchange(
          'https://cb?code=C&state=S',
          'v',
          'https://cb',
          'S',
        ),
      ).not.toBeNull()
      expect((await anthropicAdapter.refresh('r')).access).toBe('a')
      // body parses but isn't a usage shape -> snapshot with empty windows
      expect(
        (await anthropicAdapter.fetchUsage(account(), 0))?.hourly,
      ).toBeNull()
      expect(
        await openaiAdapter.exchange(
          'https://cb?code=C&state=S',
          'v',
          'https://cb',
          'S',
        ),
      ).not.toBeNull()
      expect((await openaiAdapter.refresh('r')).access).toBe('a')
      // no rateLimits in body -> null
      expect(
        await openaiAdapter.fetchUsage(account({ providerID: 'openai' }), 0),
      ).toBeNull()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
