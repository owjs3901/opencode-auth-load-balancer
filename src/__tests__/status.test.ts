import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, test } from 'bun:test'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-status-'))

import { mutatePool } from '../pool/store'
import { buildStatus, readStatus, renderStatus } from '../status'
import type { PoolAccount, PoolFile, UsageWindow } from '../types'

const NOW = 1_000_000_000_000
const MIN = 60_000
const HOUR = 60 * MIN

function win(utilization: number, resetInMs: number): UsageWindow {
  return { utilization, resetAt: resetInMs === 0 ? 0 : NOW + resetInMs }
}

function acc(o: {
  id: string
  providerID?: string
  weekly?: UsageWindow | null
  hourly?: UsageWindow | null
  cooldownUntil?: number
  disabled?: string | null
}): PoolAccount {
  return {
    id: o.id,
    providerID: o.providerID ?? 'anthropic',
    label: o.id,
    access: 't',
    refresh: 'r',
    expires: NOW + HOUR,
    accountId: null,
    usage: {
      hourly: o.hourly ?? null,
      weekly: o.weekly ?? null,
      status: null,
      capturedAt: NOW,
    },
    cooldownUntil: o.cooldownUntil ?? 0,
    disabledReason: o.disabled ?? null,
    createdAt: NOW,
  }
}

function pool(
  accounts: PoolAccount[],
  lastSelected: Record<string, string> = {},
): PoolFile {
  return { version: 1, accounts, lastSelected, sessions: {} }
}

// anthropic: in-use + ready + exhausted + cooldown + disabled, with varied reset windows;
// "other": an unknown provider with no in-use account.
function sampleProviders() {
  const p = pool(
    [
      acc({ id: 'a1', weekly: win(0.2, 30 * HOUR) }), // current, available
      acc({ id: 'a2', weekly: win(0.6, 3 * HOUR), hourly: win(0.1, HOUR) }), // available, sooner reset
      acc({ id: 'a3', weekly: win(1.0, 30 * MIN) }), // exhausted
      acc({ id: 'a4', weekly: win(0.5, 0), cooldownUntil: NOW + 45 * MIN }), // cooldown
      acc({ id: 'a5', weekly: win(0.3, 0), disabled: 'invalid_grant' }), // re-login
      acc({ id: 'o1', providerID: 'other', weekly: win(0.1, 90 * MIN) }),
    ],
    { anthropic: 'a1' },
  )
  return buildStatus(p, NOW)
}

describe('buildStatus', () => {
  test('ranks available accounts by urgency, then unavailable by weekly util', () => {
    const providers = sampleProviders()
    expect(providers.map((x) => x.providerID)).toEqual(['anthropic', 'other'])
    const anthropic = providers[0]!
    // a2 (sooner reset -> higher urgency) outranks a1; unavailable (a5,a4,a3) come last by weekly util asc
    expect(anthropic.accounts.map((a) => a.id)).toEqual([
      'a2',
      'a1',
      'a5',
      'a4',
      'a3',
    ])
    expect(anthropic.accounts.map((a) => a.rank)).toEqual([1, 2, 3, 4, 5])
    expect(anthropic.currentAccountId).toBe('a1')
    expect(anthropic.accounts.find((a) => a.id === 'a1')?.current).toBe(true)
    expect(anthropic.accounts.find((a) => a.id === 'a3')?.available).toBe(false)
  })

  test('returns an empty list for an empty pool', () => {
    expect(buildStatus(pool([]), NOW)).toEqual([])
  })

  test('a window past its reset shows 0% and stays available (stale value discarded)', () => {
    // 5h read 100% but its reset already elapsed (resetAt in the past): the window rolled
    // over, so the account has full 5h headroom again. It must read as available with a 0%
    // 5h util — never a stale "100% / exhausted" that would wrongly exclude it.
    const p = pool(
      [
        acc({
          id: 'stale',
          weekly: win(0.48, 14 * HOUR),
          hourly: win(1.0, -HOUR),
        }),
      ],
      { anthropic: 'stale' },
    )
    const anthropic = buildStatus(p, NOW)[0]!
    const stale = anthropic.accounts.find((a) => a.id === 'stale')!
    expect(stale.available).toBe(true)
    expect(stale.hourlyUtil).toBe(0) // elapsed window -> reset -> 0%
    expect(stale.weeklyUtil).toBe(0.48) // still-live window unchanged
  })

  test('an expired weekly window reports weeklyResetAt 0 to match its 0% util', () => {
    // The weekly window already reset (resetAt in the past): displayUtil discards
    // its stale value -> weeklyUtil 0. weeklyResetAt must agree (0, rendered "-")
    // rather than printing the elapsed window's old reset time alongside "0%".
    const p = pool([acc({ id: 'expired', weekly: win(0.9, -HOUR) })], {
      anthropic: 'expired',
    })
    const expired = buildStatus(p, NOW)[0]!.accounts.find(
      (a) => a.id === 'expired',
    )!
    expect(expired.weeklyUtil).toBe(0)
    expect(expired.weeklyResetAt).toBe(0)
  })

  test('an unknown weekly reset (resetAt 0) is preserved, not expired', () => {
    // resetAt === 0 means "unknown", not expired: util keeps its stored value and
    // weeklyResetAt stays 0 (already the unknown sentinel).
    const p = pool([acc({ id: 'unknown', weekly: win(0.4, 0) })])
    const unknown = buildStatus(p, NOW)[0]!.accounts.find(
      (a) => a.id === 'unknown',
    )!
    expect(unknown.weeklyUtil).toBe(0.4)
    expect(unknown.weeklyResetAt).toBe(0)
  })
})

describe('renderStatus', () => {
  test('renders provider names, the in-use marker, percentages, resets, and every state', () => {
    const out = renderStatus(sampleProviders(), NOW)
    expect(out).toContain('Claude — in use: a1')
    expect(out).toContain('other — in use: (none yet)') // unknown provider name + no current
    expect(out).toContain('20%')
    expect(out).toContain('100%')
    expect(out).toContain('in use')
    expect(out).toContain('ready')
    expect(out).toContain('exhausted')
    expect(out).toContain('cooldown 45m')
    expect(out).toContain('re-login')
    // relative reset formats: days+hours, hours+mins, mins, and "-" for past/unknown
    expect(out).toContain('1d6h')
    expect(out).toContain('3h0m')
    expect(out).toContain('30m')
  })

  test('floors a sub-minute future cooldown at 1m (never "0m")', () => {
    // 20s from now would Math.round to 0 -> "cooldown 0m", which reads as
    // "already done" while '-' is reserved for actually elapsed times.
    const p = pool([
      acc({ id: 'soon', weekly: win(0.5, HOUR), cooldownUntil: NOW + 20_000 }),
    ])
    const out = renderStatus(buildStatus(p, NOW), NOW)
    expect(out).toContain('cooldown 1m')
    expect(out).not.toContain('cooldown 0m')
  })

  test('reports when no accounts are registered', () => {
    expect(renderStatus([], NOW)).toContain('no accounts registered')
  })
})

describe('readStatus', () => {
  beforeEach(async () => {
    process.env.OPENCODE_AUTH_LB_DIR = DIR
    await rm(join(DIR, 'auth-load-balancer.json'), { force: true })
  })

  test('reads the live pool and builds its ranked status', async () => {
    await mutatePool((p) => {
      p.accounts.push(acc({ id: 'live', weekly: win(0.3, 20 * HOUR) }))
      p.lastSelected.anthropic = 'live'
    })
    const providers = await readStatus()
    expect(providers).toHaveLength(1)
    expect(providers[0]?.accounts[0]?.label).toBe('live')
    expect(providers[0]?.accounts[0]?.current).toBe(true)
  })
})
