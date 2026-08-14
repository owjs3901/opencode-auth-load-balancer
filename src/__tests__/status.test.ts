import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, test } from 'bun:test'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-status-'))

import { mutatePool } from '../pool/store'
import { buildStatus, displayWidth, readStatus, renderStatus } from '../status'
import {
  MANUAL_DISABLED_REASON,
  type PoolAccount,
  type PoolFile,
  type UsageWindow,
} from '../types'
import { testAccount } from './fixtures/account'

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
  return testAccount({
    id: o.id,
    providerID: o.providerID ?? 'anthropic',
    label: o.id,
    usage: {
      hourly: o.hourly ?? null,
      weekly: o.weekly ?? null,
      capturedAt: NOW,
    },
    cooldownUntil: o.cooldownUntil ?? 0,
    disabledReason: o.disabled ?? null,
  })
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
    // relative reset formats: <48h stays hourly, hours+mins, mins, and "-" for past/unknown
    expect(out).toContain('30h0m')
    expect(out).toContain('3h0m')
    expect(out).toContain('30m')
  })

  test('keeps resets within 48h in hours instead of rounding down to days', () => {
    const p = pool([
      acc({ id: 'forty-seven', weekly: win(0.2, 47 * HOUR) }),
      acc({ id: 'forty-eight', weekly: win(0.3, 48 * HOUR) }),
      acc({ id: 'forty-nine', weekly: win(0.4, 49 * HOUR) }),
    ])
    const out = renderStatus(buildStatus(p, NOW), NOW)

    expect(out).toContain('47h0m')
    expect(out).toContain('48h0m')
    expect(out).toContain('2d1h')
  })

  test('keeps resets up to 120 minutes in minutes instead of hours', () => {
    const p = pool([
      acc({ id: 'sixty', weekly: win(0.2, HOUR) }),
      acc({ id: 'ninety', weekly: win(0.3, 90 * MIN) }),
      acc({ id: 'one-twenty', weekly: win(0.4, 120 * MIN) }),
      acc({ id: 'two-oh-one', weekly: win(0.5, 121 * MIN) }),
    ])
    const out = renderStatus(buildStatus(p, NOW), NOW)

    expect(out).toContain('60m')
    expect(out).toContain('90m')
    expect(out).toContain('120m')
    expect(out).toContain('2h1m')
  })

  test('a manually disabled account renders `disabled`, distinct from `re-login`', () => {
    // The sentinel `MANUAL_DISABLED_REASON` (user turned the account off) must
    // read as `disabled`, NOT the `re-login` shown for the auto invalid_grant
    // reason — both sideline the account, but only re-login needs a fresh OAuth.
    const p = pool(
      [
        acc({
          id: 'off',
          weekly: win(0.3, 20 * HOUR),
          disabled: MANUAL_DISABLED_REASON,
        }),
      ],
      { anthropic: 'off' },
    )
    const out = renderStatus(buildStatus(p, NOW), NOW)
    expect(out).toContain('disabled')
    expect(out).not.toContain('re-login')
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

  test('widens the label column for labels longer than 16 chars, keeping rows aligned', () => {
    // Labels are user-editable; pre-fix a >16-char label overflowed
    // `padEnd(16)` and sheared that row's weekly/5h/resets/state columns out
    // of alignment with the header and its sibling rows.
    const long = 'claude-personal-workspace' // 25 chars
    const p = pool(
      [
        acc({ id: 'short', weekly: win(0.2, 30 * HOUR) }),
        { ...acc({ id: 'long', weekly: win(0.6, 3 * HOUR) }), label: long },
      ],
      { anthropic: 'short' },
    )
    const lines = renderStatus(buildStatus(p, NOW), NOW).split('\n')
    const header = lines[1]!
    const rows = lines.slice(2)
    expect(rows).toHaveLength(2)
    // Every row's 5-char weekly field starts exactly under the header's
    // "weekly" — including the row whose label is longer than the old fixed
    // 16-char column.
    const weeklyStart = header.indexOf('weekly')
    expect(weeklyStart).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.slice(weeklyStart, weeklyStart + 5)).toMatch(/^\s*\d+%$/)
    }
  })

  test('reports when no accounts are registered', () => {
    expect(renderStatus([], NOW)).toContain('no accounts registered')
  })

  test('keeps columns aligned (in terminal display width) for a CJK/Hangul label', () => {
    // A CJK/Hangul label renders each such character as ~2 terminal columns;
    // `.length` (UTF-16 code units) would undercount it and shear the
    // weekly/5h/resets/state columns out of alignment with the ASCII row.
    // Compare by DISPLAY column (not raw string index — a code-unit slice
    // would itself misalign once the label field's code-unit count and
    // display-column count diverge, which is exactly the bug being fixed).
    function columnSlice(row: string, startCol: number, len: number): string {
      let col = 0
      let i = 0
      while (i < row.length && col < startCol) {
        col += displayWidth(row[i]!)
        i += 1
      }
      return row.slice(i, i + len)
    }
    const wide = '클로드계정' // 5 Hangul syllables -> 10 display columns
    const p = pool(
      [
        acc({ id: 'short', weekly: win(0.2, 30 * HOUR) }),
        { ...acc({ id: 'long', weekly: win(0.6, 3 * HOUR) }), label: wide },
      ],
      { anthropic: 'short' },
    )
    const lines = renderStatus(buildStatus(p, NOW), NOW).split('\n')
    const header = lines[1]!
    const rows = lines.slice(2)
    expect(rows).toHaveLength(2)
    const weeklyStartCol = header.indexOf('weekly') // header is pure ASCII: index === display column
    expect(weeklyStartCol).toBeGreaterThan(0)
    for (const row of rows) {
      expect(columnSlice(row, weeklyStartCol, 5)).toMatch(/^\s*\d+%$/)
    }
  })

  test('displayWidth: ASCII degenerates to .length; CJK/Hangul/fullwidth count as 2 columns', () => {
    expect(displayWidth('')).toBe(0)
    expect(displayWidth('claude-work')).toBe('claude-work'.length)
    expect(displayWidth('클로드')).toBe(6) // 3 Hangul syllables x 2
    expect(displayWidth('日本語')).toBe(6) // 3 CJK ideographs x 2
    expect(displayWidth('claude-클로드')).toBe(13) // mixed: 7 ASCII (1 each) + 3 Hangul (2 each)
  })

  test('a model-tier limit annotates the usable state with a tier countdown (never "cooldown")', () => {
    // The account stays AVAILABLE (tier requests steer to other accounts or
    // downgrade; every other model is unaffected), so its state is the usable
    // base ("in use"/"ready") annotated with when the tier recovers — NOT a
    // whole-account "cooldown" (the bug that showed every account as cooled
    // down when only one model tier was exhausted).
    const p = pool(
      [
        {
          ...acc({ id: 'op', weekly: win(0.3, 20 * HOUR) }),
          modelCooldownsUntil: { opus: NOW + 4 * HOUR },
        },
      ],
      { anthropic: 'op' },
    )
    const status = buildStatus(p, NOW)
    const row = status[0]!.accounts.find((a) => a.id === 'op')!
    expect(row.available).toBe(true)
    expect(row.modelCooldownsUntil.opus).toBe(NOW + 4 * HOUR)
    const out = renderStatus(status, NOW)
    expect(out).toContain('in use · opus 4h0m')
    expect(out).not.toContain('cooldown')
  })

  test('multiple exhausted tiers render sorted by tier name; elapsed entries are dropped', () => {
    const p = pool(
      [
        {
          ...acc({ id: 'mt', weekly: win(0.3, 20 * HOUR) }),
          modelCooldownsUntil: {
            opus: NOW + 4 * HOUR,
            fable: NOW + 2 * HOUR,
            haiku: NOW - 1, // already recovered — must not render
          },
        },
      ],
      { anthropic: 'mt' },
    )
    const out = renderStatus(buildStatus(p, NOW), NOW)
    expect(out).toContain('in use · fable 120m · opus 4h0m')
    expect(out).not.toContain('haiku')
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
