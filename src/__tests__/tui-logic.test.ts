import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  deleteFromPool,
  type FsOps,
  isAbsentOrPlainRecord,
  isFiniteNumber,
  isPlainRecordValue,
  mutatePoolFile,
  pct,
  type PoolAccount,
  poolFile,
  readPool,
  renameInPool,
  stateOf,
  tierResets,
  toPoolShape,
  toScore,
  toScoreWindow,
  until,
  winPct,
} from '../../tui/auth-load-balancer-tui.logic'

/**
 * Behavioral regression lock for the TUI's pool-file logic (`tui/auth-load-balancer-tui.logic.ts`).
 * The `.tsx` view that renders these results is only typechecked/linted (no live opencode TUI
 * here — see the batch plan), but this module is plain, synchronous, fs-isolated logic with no
 * SolidJS/JSX involved, so it is unit-tested directly here exactly like its server-side analogue
 * `src/pool/store.ts` is.
 */

const ROOT = mkdtempSync(join(tmpdir(), 'auth-lb-tui-logic-'))
let seq = 0
function scratchPath(name: string): string {
  seq += 1
  return join(ROOT, `${name}-${seq}.json`)
}

describe('poolFile', () => {
  test('OPENCODE_AUTH_LB_DIR override wins', () => {
    const prevDir = process.env.OPENCODE_AUTH_LB_DIR
    const prevXdg = process.env.XDG_DATA_HOME
    try {
      process.env.OPENCODE_AUTH_LB_DIR = '/custom/dir'
      expect(poolFile()).toBe(join('/custom/dir', 'auth-load-balancer.json'))
    } finally {
      if (prevDir === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
      else process.env.OPENCODE_AUTH_LB_DIR = prevDir
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
    }
  })

  test('falls back to XDG_DATA_HOME when no override is set', () => {
    const prevDir = process.env.OPENCODE_AUTH_LB_DIR
    const prevXdg = process.env.XDG_DATA_HOME
    try {
      delete process.env.OPENCODE_AUTH_LB_DIR
      process.env.XDG_DATA_HOME = '/xdg/data'
      expect(poolFile()).toBe(
        join('/xdg/data', 'opencode', 'auth-load-balancer.json'),
      )
    } finally {
      if (prevDir === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
      else process.env.OPENCODE_AUTH_LB_DIR = prevDir
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
    }
  })

  test('falls back to ~/.local/share/opencode when neither is set', () => {
    const prevDir = process.env.OPENCODE_AUTH_LB_DIR
    const prevXdg = process.env.XDG_DATA_HOME
    try {
      delete process.env.OPENCODE_AUTH_LB_DIR
      delete process.env.XDG_DATA_HOME
      expect(poolFile()).toBe(
        join(
          homedir(),
          '.local',
          'share',
          'opencode',
          'auth-load-balancer.json',
        ),
      )
    } finally {
      if (prevDir === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
      else process.env.OPENCODE_AUTH_LB_DIR = prevDir
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
    }
  })

  test('treats a whitespace-only override/xdg as absent (trim())', () => {
    const prevDir = process.env.OPENCODE_AUTH_LB_DIR
    const prevXdg = process.env.XDG_DATA_HOME
    try {
      process.env.OPENCODE_AUTH_LB_DIR = '   '
      process.env.XDG_DATA_HOME = '   '
      expect(poolFile()).toBe(
        join(
          homedir(),
          '.local',
          'share',
          'opencode',
          'auth-load-balancer.json',
        ),
      )
    } finally {
      if (prevDir === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
      else process.env.OPENCODE_AUTH_LB_DIR = prevDir
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prevXdg
    }
  })
})

describe('isPlainRecordValue / isAbsentOrPlainRecord', () => {
  test('isPlainRecordValue: true only for a non-null, non-array object', () => {
    expect(isPlainRecordValue({})).toBe(true)
    expect(isPlainRecordValue({ a: 1 })).toBe(true)
    expect(isPlainRecordValue([])).toBe(false)
    expect(isPlainRecordValue(null)).toBe(false)
    expect(isPlainRecordValue(undefined)).toBe(false)
    expect(isPlainRecordValue('x')).toBe(false)
    expect(isPlainRecordValue(1)).toBe(false)
    expect(isPlainRecordValue(true)).toBe(false)
  })

  test('isAbsentOrPlainRecord: true for undefined or a plain object, false otherwise', () => {
    expect(isAbsentOrPlainRecord(undefined)).toBe(true)
    expect(isAbsentOrPlainRecord({})).toBe(true)
    expect(isAbsentOrPlainRecord(null)).toBe(false)
    expect(isAbsentOrPlainRecord([])).toBe(false)
    expect(isAbsentOrPlainRecord('oops')).toBe(false)
  })
})

describe('toPoolShape', () => {
  test('a non-object parse result (null / array / primitive) becomes {}', () => {
    expect(toPoolShape(null)).toEqual({})
    expect(toPoolShape([1, 2])).toEqual({})
    expect(toPoolShape('oops')).toEqual({})
    expect(toPoolShape(42)).toEqual({})
  })

  test('drops rows that are non-objects or missing a string id/providerID; keeps valid rows', () => {
    const parsed = {
      accounts: [
        null,
        42,
        ['array-row'],
        { id: 1, providerID: 'anthropic' }, // non-string id
        { id: 'a', providerID: 2 }, // non-string providerID
        { id: 'keep', providerID: 'anthropic', label: 'Work' },
      ],
    }
    const shape = toPoolShape(parsed)
    expect(shape.accounts).toHaveLength(1)
    expect(shape.accounts?.[0]?.id).toBe('keep')
  })

  test('heals a non-string label to "" but keeps the row', () => {
    const parsed = {
      accounts: [{ id: 'a', providerID: 'anthropic', label: 123 }],
    }
    const shape = toPoolShape(parsed)
    expect(shape.accounts?.[0]?.label).toBe('')
  })

  test('leaves an already-string label untouched', () => {
    const parsed = {
      accounts: [{ id: 'a', providerID: 'anthropic', label: 'Already' }],
    }
    const shape = toPoolShape(parsed)
    expect(shape.accounts?.[0]?.label).toBe('Already')
  })

  test('a non-array accounts field becomes undefined (skips the healing loop)', () => {
    const shape = toPoolShape({ accounts: 'oops' })
    expect(shape.accounts).toBeUndefined()
  })

  test('a missing accounts field stays undefined', () => {
    const shape = toPoolShape({})
    expect(shape.accounts).toBeUndefined()
  })

  test('lastSelected / sessions: a hand-edited non-record value is rejected to undefined', () => {
    const shape = toPoolShape({ lastSelected: 'oops', sessions: ['bad'] })
    expect(shape.lastSelected).toBeUndefined()
    expect(shape.sessions).toBeUndefined()
  })

  test('lastSelected / sessions: a valid plain record survives untouched', () => {
    const shape = toPoolShape({
      lastSelected: { anthropic: 'acct-1' },
      sessions: { s1: { accountId: 'acct-1' } },
    })
    expect(shape.lastSelected).toEqual({ anthropic: 'acct-1' })
    expect(shape.sessions).toEqual({ s1: { accountId: 'acct-1' } })
  })

  test('lastSelected / sessions: absent fields stay absent', () => {
    const shape = toPoolShape({})
    expect(shape.lastSelected).toBeUndefined()
    expect(shape.sessions).toBeUndefined()
  })
})

describe('readPool', () => {
  test('reads and normalizes a valid pool file', () => {
    const path = scratchPath('read-valid')
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [{ id: 'a', providerID: 'anthropic', label: 'Work' }],
      }),
    )
    const shape = readPool(path)
    expect(shape.accounts).toHaveLength(1)
    expect(shape.accounts?.[0]?.label).toBe('Work')
  })

  test('a missing file returns {}', () => {
    expect(readPool(scratchPath('does-not-exist'))).toEqual({})
  })

  test('corrupt JSON returns {}', () => {
    const path = scratchPath('corrupt')
    writeFileSync(path, 'not json {{')
    expect(readPool(path)).toEqual({})
  })

  test('JSON.parse("null") returns {} (toPoolShape guards it)', () => {
    const path = scratchPath('null-json')
    writeFileSync(path, 'null')
    expect(readPool(path)).toEqual({})
  })
})

describe('mutatePoolFile', () => {
  test('happy path: atomic temp-write + rename, no leftover tmp file', () => {
    const path = scratchPath('mutate-happy')
    writeFileSync(path, JSON.stringify({ accounts: [] }))
    mutatePoolFile((pool) => {
      pool.accounts = [{ id: 'new', providerID: 'anthropic', label: 'New' }]
    }, path)
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      accounts: PoolAccount[]
    }
    expect(written.accounts).toHaveLength(1)
    expect(written.accounts[0]?.id).toBe('new')
  })

  test('a read failure (no tmp yet) is swallowed without attempting cleanup', () => {
    const calls = { write: 0, rename: 0, unlink: 0 }
    const ops: FsOps = {
      readFileSync: () => {
        throw new Error('ENOENT')
      },
      writeFileSync: () => {
        calls.write += 1
      },
      renameSync: () => {
        calls.rename += 1
      },
      unlinkSync: () => {
        calls.unlink += 1
      },
    }
    expect(() =>
      mutatePoolFile(() => {}, scratchPath('mutate-read-fail'), ops),
    ).not.toThrow()
    expect(calls.write).toBe(0)
    expect(calls.rename).toBe(0)
    expect(calls.unlink).toBe(0) // tmp was never assigned -> no cleanup attempt
  })

  test('a write failure (tmp assigned) triggers cleanup via unlinkSync', () => {
    let unlinkedPath: string | undefined
    const ops: FsOps = {
      readFileSync: () => '{}',
      writeFileSync: () => {
        throw new Error('ENOSPC')
      },
      renameSync: () => {
        throw new Error('should not be called')
      },
      unlinkSync: (path) => {
        unlinkedPath = path
      },
    }
    const path = scratchPath('mutate-write-fail')
    expect(() => mutatePoolFile(() => {}, path, ops)).not.toThrow()
    expect(unlinkedPath?.startsWith(`${path}.`)).toBe(true)
    expect(unlinkedPath?.endsWith('.tmp')).toBe(true)
  })

  test('a rename failure (tmp assigned) also triggers cleanup via unlinkSync', () => {
    let renamed = false
    let unlinked = false
    const ops: FsOps = {
      readFileSync: () => '{}',
      writeFileSync: () => {},
      renameSync: () => {
        throw new Error('EPERM')
      },
      unlinkSync: () => {
        unlinked = true
      },
    }
    expect(() =>
      mutatePoolFile(
        () => {
          renamed = true // fn still ran before the write/rename failure
        },
        scratchPath('mutate-rename-fail'),
        ops,
      ),
    ).not.toThrow()
    expect(renamed).toBe(true)
    expect(unlinked).toBe(true)
  })

  test('a transient rename failure (EPERM-like) is retried and eventually succeeds', () => {
    // Mirrors src/pool/store.ts's writeJsonAtomic retry: a concurrent process
    // (the server's own mutatePool) can briefly hold the target open on
    // Windows. renameSync throws twice then succeeds on the 3rd attempt.
    let renameCalls = 0
    let unlinked = false
    const path = scratchPath('mutate-rename-transient')
    const ops: FsOps = {
      readFileSync: () => '{}',
      writeFileSync: () => {},
      renameSync: () => {
        renameCalls += 1
        if (renameCalls < 3) throw new Error('EPERM')
      },
      unlinkSync: () => {
        unlinked = true
      },
    }
    expect(() => mutatePoolFile(() => {}, path, ops)).not.toThrow()
    expect(renameCalls).toBe(3)
    expect(unlinked).toBe(false) // succeeded before cleanup was ever needed
  })

  test('a persistently failing rename retries up to 5x then falls through to cleanup', () => {
    let renameCalls = 0
    let unlinked = false
    const ops: FsOps = {
      readFileSync: () => '{}',
      writeFileSync: () => {},
      renameSync: () => {
        renameCalls += 1
        throw new Error('EPERM')
      },
      unlinkSync: () => {
        unlinked = true
      },
    }
    expect(() =>
      mutatePoolFile(() => {}, scratchPath('mutate-rename-persistent'), ops),
    ).not.toThrow()
    expect(renameCalls).toBe(5)
    expect(unlinked).toBe(true)
  })

  test('cleanup unlink failure is swallowed too (best-effort, never throws)', () => {
    const ops: FsOps = {
      readFileSync: () => '{}',
      writeFileSync: () => {
        throw new Error('ENOSPC')
      },
      renameSync: () => {},
      unlinkSync: () => {
        throw new Error('gone')
      },
    }
    expect(() =>
      mutatePoolFile(() => {}, scratchPath('mutate-unlink-fail'), ops),
    ).not.toThrow()
  })
})

describe('renameInPool / deleteFromPool (end-to-end against a scratch file)', () => {
  test('renameInPool relabels a matching account', () => {
    const path = scratchPath('rename-hit')
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [{ id: 'a', providerID: 'anthropic', label: 'Old' }],
      }),
    )
    renameInPool('a', 'New Label', path)
    const shape = readPool(path)
    expect(shape.accounts?.[0]?.label).toBe('New Label')
  })

  test('renameInPool is a no-op for an unknown id (still writes the healed file)', () => {
    const path = scratchPath('rename-miss')
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [{ id: 'a', providerID: 'anthropic', label: 'Old' }],
      }),
    )
    renameInPool('missing', 'New Label', path)
    const shape = readPool(path)
    expect(shape.accounts?.[0]?.label).toBe('Old')
  })

  test('deleteFromPool removes the account and its lastSelected/sessions references', () => {
    const path = scratchPath('delete-hit')
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [
          { id: 'a', providerID: 'anthropic', label: 'A' },
          { id: 'b', providerID: 'anthropic', label: 'B' },
        ],
        lastSelected: { anthropic: 'a', openai: 'other' },
        sessions: {
          s1: { accountId: 'a' },
          s2: { accountId: 'b' },
        },
      }),
    )
    deleteFromPool('a', path)
    const shape = readPool(path)
    expect(shape.accounts?.map((a) => a.id)).toEqual(['b'])
    expect(shape.lastSelected).toEqual({ openai: 'other' })
    expect(shape.sessions).toEqual({ s2: { accountId: 'b' } })
  })

  test('deleteFromPool for an unknown id leaves lastSelected/sessions untouched', () => {
    const path = scratchPath('delete-miss')
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [{ id: 'a', providerID: 'anthropic', label: 'A' }],
        lastSelected: { anthropic: 'a' },
        sessions: { s1: { accountId: 'a' } },
      }),
    )
    deleteFromPool('missing', path)
    const shape = readPool(path)
    expect(shape.accounts?.map((a) => a.id)).toEqual(['a'])
    expect(shape.lastSelected).toEqual({ anthropic: 'a' })
    expect(shape.sessions).toEqual({ s1: { accountId: 'a' } })
  })

  test('deleteFromPool tolerates absent lastSelected/sessions', () => {
    const path = scratchPath('delete-no-extras')
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [{ id: 'a', providerID: 'anthropic', label: 'A' }],
      }),
    )
    expect(() => deleteFromPool('a', path)).not.toThrow()
    const shape = readPool(path)
    expect(shape.accounts).toEqual([])
  })
})

describe('isFiniteNumber', () => {
  test('rejects NaN/±Infinity/non-numbers, accepts finite numbers', () => {
    expect(isFiniteNumber(1)).toBe(true)
    expect(isFiniteNumber(0)).toBe(true)
    expect(isFiniteNumber(Number.NaN)).toBe(false)
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isFiniteNumber('1')).toBe(false)
    expect(isFiniteNumber(undefined)).toBe(false)
    expect(isFiniteNumber(null)).toBe(false)
  })
})

describe('toScoreWindow', () => {
  test('null/undefined window -> null', () => {
    expect(toScoreWindow(null)).toBeNull()
    expect(toScoreWindow(undefined)).toBeNull()
  })

  test('a non-finite utilization -> null', () => {
    expect(toScoreWindow({ utilization: Number.NaN })).toBeNull()
    expect(toScoreWindow({})).toBeNull()
  })

  test('a valid utilization with a missing/negative resetAt coerces resetAt to 0', () => {
    expect(toScoreWindow({ utilization: 0.5 })).toEqual({
      utilization: 0.5,
      resetAt: 0,
    })
    expect(toScoreWindow({ utilization: 0.5, resetAt: -1 })).toEqual({
      utilization: 0.5,
      resetAt: 0,
    })
  })

  test('a valid utilization + resetAt passes through', () => {
    expect(toScoreWindow({ utilization: 0.5, resetAt: 1000 })).toEqual({
      utilization: 0.5,
      resetAt: 1000,
    })
  })
})

describe('toScore', () => {
  test('normalizes windows, cooldownUntil, and disabledReason', () => {
    const sa = toScore({
      id: 'a',
      providerID: 'anthropic',
      label: 'A',
      usage: { hourly: { utilization: 0.2, resetAt: 100 }, weekly: null },
      cooldownUntil: 500,
      disabledReason: 'revoked',
    })
    expect(sa).toEqual({
      usage: { hourly: { utilization: 0.2, resetAt: 100 }, weekly: null },
      cooldownUntil: 500,
      disabledReason: 'revoked',
    })
  })

  test('defaults a non-finite cooldownUntil to 0 and a missing disabledReason to null', () => {
    const sa = toScore({
      id: 'a',
      providerID: 'anthropic',
      label: 'A',
      cooldownUntil: Number.NaN,
    })
    expect(sa.cooldownUntil).toBe(0)
    expect(sa.disabledReason).toBeNull()
    expect(sa.usage).toEqual({ hourly: null, weekly: null })
  })
})

describe('pct', () => {
  test('formats a number as a rounded percentage, "-" otherwise', () => {
    expect(pct(0.5)).toBe('50%')
    expect(pct(0.999)).toBe('100%')
    expect(pct(0)).toBe('0%')
    expect(pct(null)).toBe('-')
    expect(pct(undefined)).toBe('-')
  })
})

describe('until', () => {
  const now = 1_000_000

  test('non-finite or past/now resetAt -> "-"', () => {
    expect(until(undefined, now)).toBe('-')
    expect(until(Number.NaN, now)).toBe('-')
    expect(until(now, now)).toBe('-')
    expect(until(now - 1, now)).toBe('-')
  })

  test('clamps a sub-30s future reset to "1m" (never "0m")', () => {
    expect(until(now + 5_000, now)).toBe('1m')
  })

  test('renders minutes under an hour', () => {
    expect(until(now + 30 * 60_000, now)).toBe('30m')
  })

  test('renders hours under a day', () => {
    expect(until(now + 3 * 60 * 60_000, now)).toBe('3h')
  })

  test('renders floored days at/over 24h', () => {
    expect(until(now + 36 * 60 * 60_000, now)).toBe('1d')
    expect(until(now + 3 * 24 * 60 * 60_000, now)).toBe('3d')
  })
})

describe('winPct', () => {
  const now = 1_000_000

  test('renders "-" for an absent window', () => {
    expect(winPct(null, now)).toBe('-')
    expect(winPct(undefined, now)).toBe('-')
  })

  test('renders "0%" once the window has reset (stale value discarded)', () => {
    expect(winPct({ utilization: 0.9, resetAt: now - 1 }, now)).toBe('0%')
  })

  test('renders the stored utilization for a live window', () => {
    expect(winPct({ utilization: 0.42, resetAt: now + 60_000 }, now)).toBe(
      '42%',
    )
  })
})

describe('tierResets', () => {
  const now = 1_000_000
  const base: PoolAccount = { id: 'a', providerID: 'anthropic', label: 'A' }

  test('empty when there are no tier cooldowns', () => {
    expect(tierResets(base, now)).toEqual([])
  })

  test('filters out expired/non-finite entries and sorts by tier name', () => {
    const a: PoolAccount = {
      ...base,
      modelCooldownsUntil: {
        sonnet: now + 2000,
        opus: now + 1000,
        fable: now + 3000,
        expired: now - 1,
        garbage: Number.NaN,
      },
    }
    expect(tierResets(a, now)).toEqual([
      ['fable', now + 3000],
      ['opus', now + 1000],
      ['sonnet', now + 2000],
    ])
  })

  test('a non-plain-record modelCooldownsUntil is ignored', () => {
    const a: PoolAccount = {
      ...base,
      modelCooldownsUntil: 'oops' as unknown as Record<string, number>,
    }
    expect(tierResets(a, now)).toEqual([])
  })

  test('folds the legacy opusCooldownUntil into "opus" (max-merged with an existing entry)', () => {
    const noExisting: PoolAccount = { ...base, opusCooldownUntil: now + 5000 }
    expect(tierResets(noExisting, now)).toEqual([['opus', now + 5000]])

    const lowerLegacy: PoolAccount = {
      ...base,
      modelCooldownsUntil: { opus: now + 9000 },
      opusCooldownUntil: now + 1000, // lower than the map entry -> max-merge keeps 9000
    }
    expect(tierResets(lowerLegacy, now)).toEqual([['opus', now + 9000]])

    const higherLegacy: PoolAccount = {
      ...base,
      modelCooldownsUntil: { opus: now + 1000 },
      opusCooldownUntil: now + 9000, // higher than the map entry -> max-merge takes 9000
    }
    expect(tierResets(higherLegacy, now)).toEqual([['opus', now + 9000]])
  })

  test('an expired/non-finite legacy opusCooldownUntil is ignored', () => {
    const expired: PoolAccount = { ...base, opusCooldownUntil: now - 1 }
    expect(tierResets(expired, now)).toEqual([])
    const nonFinite: PoolAccount = {
      ...base,
      opusCooldownUntil: Number.NaN,
    }
    expect(tierResets(nonFinite, now)).toEqual([])
  })
})

describe('stateOf', () => {
  const now = 1_000_000

  test('disabledReason takes priority -> "re-login"', () => {
    expect(
      stateOf(
        {
          usage: { hourly: null, weekly: null },
          cooldownUntil: 0,
          disabledReason: 'x',
        },
        [],
        now,
      ),
    ).toBe('re-login')
  })

  test('an active cooldown -> "cooldown"', () => {
    expect(
      stateOf(
        {
          usage: { hourly: null, weekly: null },
          cooldownUntil: now + 1000,
          disabledReason: null,
        },
        [],
        now,
      ),
    ).toBe('cooldown 1m')
  })

  test('exhausted usage -> "full"', () => {
    expect(
      stateOf(
        {
          usage: {
            hourly: { utilization: 0.999, resetAt: now + 1000 },
            weekly: null,
          },
          cooldownUntil: 0,
          disabledReason: null,
        },
        [],
        now,
      ),
    ).toBe('full')
  })

  test('active tier cooldowns render as a joined annotation', () => {
    expect(
      stateOf(
        {
          usage: { hourly: null, weekly: null },
          cooldownUntil: 0,
          disabledReason: null,
        },
        [
          ['fable', now + 60_000],
          ['opus', now + 120_000],
        ],
        now,
      ),
    ).toBe('fable 1m · opus 2m')
  })

  test('a healthy account with no tier cooldowns -> ""', () => {
    expect(
      stateOf(
        {
          usage: { hourly: null, weekly: null },
          cooldownUntil: 0,
          disabledReason: null,
        },
        [],
        now,
      ),
    ).toBe('')
  })
})
