import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { addAccount } from '../accounts'
import { mutatePool, readPool } from '../pool/store'
import { selectAccount } from '../scheduler/select'
import type { CooldownKind, PoolAccount, UsageSnapshot } from '../types'
import { refreshUsageInBackground } from '../usage-refresh'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'

let dir: string
const DAY = 86_400_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auth-lb-quota-reset-'))
  process.env.OPENCODE_AUTH_LB_DIR = dir
})

afterEach(async () => {
  delete process.env.OPENCODE_AUTH_LB_DIR
  await rm(dir, { recursive: true, force: true })
})

function resetUsage(now: number): UsageSnapshot {
  return {
    hourly: { utilization: 0, resetAt: 0 },
    weekly: { utilization: 0, resetAt: 0 },
    capturedAt: now,
  }
}

async function relogin(usage: UsageSnapshot, over: Partial<PoolAccount> = {}) {
  const row = testAccount({
    label: 'contact',
    accountId: 'quota-reset-account',
    expires: Date.now() + 3_600_000,
    cooldownUntil: Date.now() + 2 * DAY,
    cooldownKind: 'quota',
    usage: {
      hourly: { utilization: 1, resetAt: Date.now() + 3_600_000 },
      weekly: { utilization: 1, resetAt: Date.now() + 2 * DAY },
      capturedAt: 1,
    },
    ...over,
  })
  await mutatePool((pool) => {
    pool.accounts = [row]
  })
  await addAccount('anthropic', {
    accountId: row.accountId ?? undefined,
    access: 'fresh-oauth-access',
    refresh: 'fresh-oauth-refresh',
    expires: Date.now() + 3_600_000,
    usage,
  })
  return { row, pool: await readPool() }
}

test('re-login with measured reset usage rejoins normal selection even when polling skips the fresh snapshot', async () => {
  const now = Date.now()
  await relogin(resetUsage(now))
  let polls = 0
  await refreshUsageInBackground(
    fakeAdapter({
      fetchUsage: async () => {
        polls += 1
        return null
      },
    }),
    now,
  )

  const pool = await readPool()
  const picked = selectAccount(pool.accounts, 'anthropic', now)
  expect(polls).toBe(0)
  expect(pool.accounts[0]?.cooldownUntil).toBe(0)
  expect(pool.accounts[0]?.cooldownKind).toBeUndefined()
  expect(picked?.account.label).toBe('contact')
  expect(picked?.degraded).toBe(false)
})

test('re-login without a measured weekly window does not clear quota cooldown', async () => {
  const { row, pool } = await relogin({
    hourly: { utilization: 0, resetAt: 0 },
    weekly: null,
    capturedAt: Date.now(),
  })
  expect(pool.accounts[0]?.cooldownUntil).toBe(row.cooldownUntil)
})

test.each(['hourly', 'weekly'] as const)(
  're-login keeps quota cooldown when the measured %s window is still exhausted',
  async (window) => {
    const now = Date.now()
    const usage = resetUsage(now)
    usage[window] = { utilization: 1, resetAt: now + DAY }
    const { row, pool } = await relogin(usage)
    expect(pool.accounts[0]?.cooldownUntil).toBe(row.cooldownUntil)
  },
)

test.each(['auth', 'transient'] satisfies CooldownKind[])(
  'quota reset does not discard an unrelated %s cooldown',
  async (cooldownKind) => {
    const { row, pool } = await relogin(resetUsage(Date.now()), {
      cooldownKind,
      cooldownUntil: Date.now() + 60_000,
    })
    expect(pool.accounts[0]?.cooldownUntil).toBe(row.cooldownUntil)
    expect(pool.accounts[0]?.cooldownKind).toBe(cooldownKind)
  },
)

test('pairing a measured setup-token also clears a stale quota cooldown', async () => {
  const now = Date.now()
  const { row } = await relogin(resetUsage(now))
  await mutatePool((pool) => {
    const stored = pool.accounts[0]
    if (!stored) throw new Error('Missing fixture account')
    stored.cooldownUntil = now + 2 * DAY
    stored.cooldownKind = 'quota'
    pool.relogin = {
      accountId: row.id,
      providerID: 'anthropic',
      expiresAt: now + 60_000,
    }
  })
  await addAccount('anthropic', {
    access: 'sk-ant-oat01-fake-setup-token',
    refresh: '',
    expires: Number.MAX_SAFE_INTEGER,
    inferenceOnly: true,
    usage: resetUsage(now),
  })

  const pool = await readPool()
  expect(pool.accounts).toHaveLength(1)
  expect(pool.accounts[0]?.cooldownUntil).toBe(0)
  expect(pool.accounts[0]?.refresh).toBe('fresh-oauth-refresh')
})

test('a newer quota rejection recorded during an old usage poll keeps its cooldown', async () => {
  const now = Date.now()
  const { row } = await relogin(resetUsage(now))
  await mutatePool((pool) => {
    const stored = pool.accounts[0]
    if (!stored) throw new Error('Missing fixture account')
    stored.usage.capturedAt = 0
    stored.cooldownUntil = now + DAY
    stored.cooldownKind = 'quota'
  })
  await refreshUsageInBackground(
    fakeAdapter({
      fetchUsage: async () => {
        await mutatePool((pool) => {
          const stored = pool.accounts.find((a) => a.id === row.id)
          if (!stored) throw new Error('Missing fixture account')
          stored.cooldownUntil = now + 3 * DAY
        })
        return resetUsage(now)
      },
    }),
    now,
  )

  expect((await readPool()).accounts[0]?.cooldownUntil).toBe(now + 3 * DAY)
})
