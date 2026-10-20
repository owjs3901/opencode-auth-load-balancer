import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { mutatePool, readPool } from '../pool/store'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import { kimiCodeAdapter } from '../providers/kimi/adapter'
import { openaiAdapter } from '../providers/openai/adapter'
import { fetchJson } from '../providers/usage-http'
import { selectAccount } from '../scheduler/select'
import { refreshUsageInBackground } from '../usage-refresh'
import { testAccount } from './fixtures/account'
import { responderFetch } from './fixtures/fetch-mock'

const cases = [
  {
    name: 'Claude',
    adapter: anthropicAdapter,
    response: { five_hour: null, seven_day: null },
  },
  {
    name: 'Codex',
    adapter: openaiAdapter,
    response: {
      rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604_800 },
      },
    },
  },
  {
    name: 'Kimi',
    adapter: kimiCodeAdapter,
    response: {
      usages: {
        limit_5h: { used_ratio: 0 },
        limit_7d: { used_ratio: 0 },
      },
    },
  },
]

const originalFetch = globalThis.fetch
let dir: string
const DAY = 86_400_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auth-lb-usage-auth-'))
  process.env.OPENCODE_AUTH_LB_DIR = dir
  process.env.OPENCODE_AUTH_LB_SYNC = '0'
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  delete process.env.OPENCODE_AUTH_LB_DIR
  delete process.env.OPENCODE_AUTH_LB_SYNC
  await rm(dir, { recursive: true, force: true })
})

test.each(cases)(
  '$name usage 401 refreshes an unexpired rejected token once and clears recovered quota cooldown',
  async ({ adapter, response }) => {
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts = [
        testAccount({
          id: randomUUID(),
          providerID: adapter.id,
          label: 'contact',
          access: 'rejected-access',
          refresh: 'fake-rotating-refresh',
          expires: now + DAY,
          cooldownUntil: now + 2 * DAY,
          cooldownKind: 'quota',
        }),
      ]
    })
    const authorization: (string | null)[] = []
    globalThis.fetch = responderFetch(() => (_url, init) => {
      const bearer = new Headers(init?.headers).get('authorization')
      authorization.push(bearer)
      return bearer === 'Bearer rejected-access'
        ? Response.json(
            { error: { type: 'authentication_error' } },
            { status: 401 },
          )
        : Response.json(response)
    })
    const refreshes: string[] = []
    await refreshUsageInBackground(
      {
        ...adapter,
        refresh: async (refresh) => {
          refreshes.push(refresh)
          return {
            access: 'recovered-access',
            refresh: 'fake-successor-refresh',
            expires: now + DAY,
          }
        },
      },
      now,
    )

    const pool = await readPool()
    expect(refreshes).toEqual(['fake-rotating-refresh'])
    expect(authorization).toEqual([
      'Bearer rejected-access',
      'Bearer recovered-access',
    ])
    expect(pool.accounts[0]?.refresh).toBe('fake-successor-refresh')
    expect(pool.accounts[0]?.cooldownUntil).toBe(0)
    expect(selectAccount(pool.accounts, adapter.id, now)?.degraded).toBe(false)
  },
)

test.each([401, 403, 429])(
  'persistent usage HTTP %i never causes an unbounded refresh loop or clears cooldown without usage',
  async (status) => {
    const now = Date.now()
    await mutatePool((pool) => {
      pool.accounts = [
        testAccount({
          id: randomUUID(),
          expires: now + DAY,
          cooldownUntil: now + 2 * DAY,
          cooldownKind: 'quota',
        }),
      ]
    })
    let requests = 0
    let refreshes = 0
    globalThis.fetch = responderFetch(() => () => {
      requests += 1
      return Response.json({ error: 'fake-error' }, { status })
    })
    await refreshUsageInBackground(
      {
        ...anthropicAdapter,
        refresh: async () => {
          refreshes += 1
          return {
            access: 'new-access',
            refresh: 'new-refresh',
            expires: now + DAY,
          }
        },
      },
      now,
    )

    expect(requests).toBe(status === 401 ? 2 : 1)
    expect(refreshes).toBe(status === 401 ? 1 : 0)
    const row = (await readPool()).accounts[0]
    expect(row?.cooldownUntil).toBe(now + 2 * DAY)
    expect(row?.usage.capturedAt).toBe(0)
  },
)

test('generic JSON reads keep their null-on-401 contract for non-usage lookups', async () => {
  globalThis.fetch = responderFetch(
    () => () => new Response(null, { status: 401 }),
  )
  expect(await fetchJson('https://fake.test/metadata', {}, 1_000)).toBeNull()
})

test('a static API key rejected by the usage endpoint is never sent to OAuth refresh', async () => {
  const now = Date.now()
  await mutatePool((pool) => {
    pool.accounts = [
      testAccount({
        id: randomUUID(),
        providerID: kimiCodeAdapter.id,
        refresh: '',
        expires: Number.MAX_SAFE_INTEGER,
        cooldownUntil: now + 2 * DAY,
        cooldownKind: 'quota',
      }),
    ]
  })
  let requests = 0
  let refreshes = 0
  globalThis.fetch = responderFetch(() => () => {
    requests += 1
    return new Response(null, { status: 401 })
  })
  await refreshUsageInBackground(
    {
      ...kimiCodeAdapter,
      refresh: async () => {
        refreshes += 1
        throw new Error('A static key must not be refreshed')
      },
    },
    now,
  )
  expect(requests).toBe(1)
  expect(refreshes).toBe(0)
  expect((await readPool()).accounts[0]?.cooldownUntil).toBe(now + 2 * DAY)
})

test('usage 401 adopts a concurrently replaced access token without spending another refresh token', async () => {
  const now = Date.now()
  const row = testAccount({
    id: randomUUID(),
    access: 'old-access',
    expires: now + DAY,
    cooldownUntil: now + 2 * DAY,
    cooldownKind: 'quota',
  })
  await mutatePool((pool) => {
    pool.accounts = [row]
  })
  const authorization: (string | null)[] = []
  globalThis.fetch = responderFetch(() => async (_url, init) => {
    const bearer = new Headers(init?.headers).get('authorization')
    authorization.push(bearer)
    if (bearer === 'Bearer old-access') {
      await mutatePool((pool) => {
        const stored = pool.accounts[0]
        if (!stored) throw new Error('Missing fixture account')
        stored.access = 'concurrent-access'
        stored.refresh = 'concurrent-refresh'
        stored.tokenGen = 1
      })
      return new Response(null, { status: 401 })
    }
    return Response.json({ five_hour: null, seven_day: null })
  })
  let refreshes = 0
  await refreshUsageInBackground(
    {
      ...anthropicAdapter,
      refresh: async () => {
        refreshes += 1
        throw new Error('The other process already refreshed')
      },
    },
    now,
  )
  expect(authorization).toEqual([
    'Bearer old-access',
    'Bearer concurrent-access',
  ])
  expect(refreshes).toBe(0)
  expect((await readPool()).accounts[0]?.cooldownUntil).toBe(0)
})
