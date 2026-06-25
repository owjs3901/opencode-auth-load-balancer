import { describe, expect, test } from 'bun:test'

import { DEFAULT_CONFIG } from '../scheduler/config'
import { isAvailable, isExhausted, weeklyUrgency } from '../scheduler/score'
import { selectAccount, selectForSession } from '../scheduler/select'
import type {
  PoolAccount,
  PoolFile,
  SessionAssignment,
  UsageWindow,
} from '../types'

const NOW = 1_000_000_000_000 // fixed epoch ms
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function win(utilization: number, resetInMs: number): UsageWindow {
  return { utilization, resetAt: NOW + resetInMs }
}

function account(
  id: string,
  opts: {
    weekly?: UsageWindow | null
    hourly?: UsageWindow | null
    cooldownUntil?: number
    disabled?: string | null
    providerID?: string
  } = {},
): PoolAccount {
  return {
    id,
    providerID: opts.providerID ?? 'anthropic',
    label: id,
    access: 'a',
    refresh: 'r',
    expires: NOW + 8 * HOUR,
    accountId: null,
    usage: {
      hourly: opts.hourly ?? null,
      weekly: opts.weekly ?? null,
      status: null,
      capturedAt: NOW,
    },
    cooldownUntil: opts.cooldownUntil ?? 0,
    disabledReason: opts.disabled ?? null,
    createdAt: NOW,
    lastUsedAt: 0,
  }
}

const pick = (accts: PoolAccount[], exclude?: Set<string>) =>
  selectAccount(accts, 'anthropic', NOW, DEFAULT_CONFIG, exclude)?.account.id

function poolOf(
  accounts: PoolAccount[],
  sessions: Record<string, SessionAssignment> = {},
): PoolFile {
  return { version: 1, accounts, lastSelected: {}, sessions }
}

describe('weekly urgency = drainable / (daysToReset + cushion)^2', () => {
  test('at equal reset time, the account with more weekly headroom wins', () => {
    const accts = [
      account('low', { weekly: win(0.1, 30 * HOUR) }),
      account('mid', { weekly: win(0.5, 30 * HOUR) }),
      account('high', { weekly: win(0.8, 30 * HOUR) }),
    ]
    expect(pick(accts)).toBe('low')
  })

  test('urgency rises monotonically as the weekly reset nears (no cliff)', () => {
    const at = (resetInMs: number) =>
      weeklyUrgency(
        account('x', { weekly: win(0.5, resetInMs) }),
        DEFAULT_CONFIG,
        NOW,
      )
    expect(at(2 * DAY)).toBeGreaterThan(at(5 * DAY))
    expect(at(6 * HOUR)).toBeGreaterThan(at(2 * DAY))
  })

  test('at equal remaining, a sooner reset has higher urgency (3d > 7d)', () => {
    const u3 = weeklyUrgency(
      account('a', { weekly: win(0.5, 3 * DAY) }),
      DEFAULT_CONFIG,
      NOW,
    )
    const u7 = weeklyUrgency(
      account('b', { weekly: win(0.5, 7 * DAY) }),
      DEFAULT_CONFIG,
      NOW,
    )
    expect(u3).toBeGreaterThan(u7)
  })
})

describe('point 1: use the sooner-resetting account first', () => {
  test('equal remaining, 3-day reset chosen over 7-day reset', () => {
    const a = account('3d', { weekly: win(0.5, 3 * DAY) })
    const b = account('7d', { weekly: win(0.5, 7 * DAY) })
    expect(pick([a, b])).toBe('3d')
  })
})

describe('point 2: continuous drain, not a last-hour cliff', () => {
  test('a sooner-resetting account is preferred well before it is imminent', () => {
    // 'drain' resets in a full DAY (not imminent) yet is preferred over a fresher
    // account resetting far out — so its perishable quota is drained progressively.
    const fresh = account('fresh', { weekly: win(0.1, 6 * DAY) }) // urgency 0.9/6 = 0.15
    const drain = account('drain', { weekly: win(0.5, 1 * DAY) }) // urgency 0.5/1 = 0.50
    expect(pick([fresh, drain])).toBe('drain')
  })

  test('a near-reset account keeps winning until it is drained/excluded', () => {
    const fresh = account('fresh', { weekly: win(0.2, 6 * DAY) })
    const drain = account('drain', { weekly: win(0.6, 3 * HOUR) })
    expect(pick([fresh, drain])).toBe('drain')
  })

  test('a soon-resetting account outranks a fresher one that resets far out', () => {
    // Real case: "contact" (weekly 67% used, resets in 17h, 5h busy but resets in ~30m)
    // is drained before "owjs3901" (weekly 5% used, resets in 2d) — its quota is the most
    // perishable. The squared time term + reset-aware 5h penalty make contact win.
    const owjs = account('owjs', {
      weekly: win(0.05, 2 * DAY),
      hourly: win(0.0, 4 * HOUR),
    })
    const contact = account('contact', {
      weekly: win(0.67, 17 * HOUR),
      hourly: win(0.77, 28 * 60 * 1000),
    })
    expect(pick([owjs, contact])).toBe('contact')
  })
})

describe('5h window modulates but never overrides weekly urgency', () => {
  test('equal weekly urgency is broken by 5h headroom', () => {
    const full5h = account('full', {
      weekly: win(0.3, 5 * DAY),
      hourly: win(0.0, HOUR),
    })
    const low5h = account('low', {
      weekly: win(0.3, 5 * DAY),
      hourly: win(0.9, HOUR),
    })
    expect(pick([full5h, low5h])).toBe('full')
  })

  test('a sooner weekly reset still wins even with worse 5h headroom', () => {
    const far = account('far', {
      weekly: win(0.5, 7 * DAY),
      hourly: win(0.0, HOUR),
    })
    const soon = account('soon', {
      weekly: win(0.5, 3 * DAY),
      hourly: win(0.95, HOUR),
    })
    expect(pick([far, soon])).toBe('soon')
  })

  test('a busy 5h window that resets soon barely penalizes vs one that resets far', () => {
    // Same weekly urgency; both 5h at 90%. The one whose 5h resets SOON is barely de-rated
    // (short-term pressure about to clear), so it outranks the one whose 5h resets far out.
    const soon5h = account('soon5h', {
      weekly: win(0.3, 3 * DAY),
      hourly: win(0.9, 15 * 60 * 1000),
    })
    const far5h = account('far5h', {
      weekly: win(0.3, 3 * DAY),
      hourly: win(0.9, 5 * HOUR),
    })
    expect(pick([soon5h, far5h])).toBe('soon5h')
  })
})

describe('exclusion', () => {
  test('an account exhausted in the weekly window is excluded', () => {
    const exhausted = account('ex', { weekly: win(1.0, 30 * HOUR) })
    const ok = account('ok', { weekly: win(0.9, 30 * HOUR) })
    expect(isExhausted(exhausted, DEFAULT_CONFIG)).toBe(true)
    expect(pick([exhausted, ok])).toBe('ok')
  })

  test('an account exhausted in the hourly window is excluded', () => {
    const exhausted = account('ex', {
      hourly: win(1.0, HOUR),
      weekly: win(0.1, 30 * HOUR),
    })
    const ok = account('ok', { weekly: win(0.7, 30 * HOUR) })
    expect(pick([exhausted, ok])).toBe('ok')
  })

  test('a cooling-down account is skipped', () => {
    const cooling = account('cool', {
      weekly: win(0.1, 30 * HOUR),
      cooldownUntil: NOW + HOUR,
    })
    const ok = account('ok', { weekly: win(0.7, 30 * HOUR) })
    expect(isAvailable(cooling, DEFAULT_CONFIG, NOW)).toBe(false)
    expect(pick([cooling, ok])).toBe('ok')
  })

  test('a disabled account is never selected', () => {
    const disabled = account('dead', {
      weekly: win(0.0, 30 * HOUR),
      disabled: 'invalid_grant',
    })
    const ok = account('ok', { weekly: win(0.9, 30 * HOUR) })
    expect(pick([disabled, ok])).toBe('ok')
  })

  test('an excluded (already-tried) account is skipped', () => {
    const a = account('a', { weekly: win(0.1, 30 * HOUR) })
    const b = account('b', { weekly: win(0.6, 30 * HOUR) })
    expect(pick([a, b], new Set(['a']))).toBe('b')
  })
})

describe('degraded fallback', () => {
  test('when all are exhausted, picks the least-bad (lowest weekly util) and flags degraded', () => {
    const a = account('a', { weekly: win(1.0, 30 * HOUR) })
    const b = account('b', { weekly: win(1.0, 5 * HOUR) })
    const sel = selectAccount([a, b], 'anthropic', NOW)
    expect(sel).not.toBeNull()
    expect(sel?.degraded).toBe(true)
    expect(['a', 'b']).toContain(sel?.account.id ?? '')
  })

  test('returns null when the provider has no non-disabled accounts', () => {
    const disabled = account('dead', { disabled: 'invalid_grant' })
    expect(selectAccount([disabled], 'anthropic', NOW)).toBeNull()
  })

  test('ignores accounts from other providers', () => {
    const openai = account('o', {
      providerID: 'openai',
      weekly: win(0.0, 30 * HOUR),
    })
    const anthropic = account('a', { weekly: win(0.5, 30 * HOUR) })
    expect(pick([openai, anthropic])).toBe('a')
  })
})

describe('point 3: session affinity (prompt-cache stickiness)', () => {
  const sessionPick = (
    pool: PoolFile,
    key: string | null,
    exclude?: Set<string>,
  ) => selectForSession(pool, 'anthropic', key, NOW, DEFAULT_CONFIG, exclude)

  test('a session stays pinned to its account even when another has higher urgency', () => {
    const a = account('a', { weekly: win(0.1, 3 * DAY) }) // higher urgency
    const b = account('b', { weekly: win(0.6, 7 * DAY) })
    const pool = poolOf([a, b], {
      's:sess1': { accountId: 'b', updatedAt: NOW },
    })
    const sel = sessionPick(pool, 's:sess1')
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
  })

  test('a new session (no assignment) gets the urgency pick', () => {
    const a = account('a', { weekly: win(0.1, 3 * DAY) })
    const b = account('b', { weekly: win(0.6, 7 * DAY) })
    const pool = poolOf([a, b])
    const sel = sessionPick(pool, 's:new')
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
  })

  test('when the pinned account becomes exhausted, the session switches (forced)', () => {
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(1.0, 7 * DAY) }) // pinned but now exhausted
    const pool = poolOf([a, b], {
      's:sess1': { accountId: 'b', updatedAt: NOW },
    })
    const sel = sessionPick(pool, 's:sess1')
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
  })

  test('a pinned account that is excluded (just failed) is not reused', () => {
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(0.3, 7 * DAY) })
    const pool = poolOf([a, b], {
      's:sess1': { accountId: 'b', updatedAt: NOW },
    })
    const sel = sessionPick(pool, 's:sess1', new Set(['b']))
    expect(sel?.account.id).toBe('a')
  })
})

describe('point 3a/3b/3c: proactive migration, cost gating, drain override', () => {
  const migPick = (
    pool: PoolFile,
    key: string,
    cfg = DEFAULT_CONFIG,
    requestBytes = 0,
    exclude: Set<string> = new Set(),
  ) => selectForSession(pool, 'anthropic', key, NOW, cfg, exclude, requestBytes)

  const pinnedTo = (accounts: PoolAccount[], id: string): PoolFile =>
    poolOf(accounts, { 's:1': { accountId: id, updatedAt: NOW } })

  test('proactively migrates off a pinned account past the weekly drain target to a healthier one', () => {
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(0.99, 5 * DAY) }) // pinned, over the weekly drain target (0.98)
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1')
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
  })

  test('does NOT migrate while the pinned account is below migrateAt', () => {
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(0.9, 5 * DAY) }) // below 0.95
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1')
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
  })

  test('does NOT proactively migrate if no account has more headroom', () => {
    const a = account('a', { weekly: win(0.99, 5 * DAY) }) // worse than the pin (less headroom)
    const b = account('b', { weekly: win(0.98, 5 * DAY) }) // pinned, over the weekly drain target
    expect(migPick(pinnedTo([a, b], 'b'), 's:1')?.account.id).toBe('b')
  })

  test('cost gate holds a proactive migration on a large request, allows it on a small one', () => {
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(0.99, 5 * DAY) })
    const cfg = { ...DEFAULT_CONFIG, cheapSwitchMaxBytes: 1000 }
    // large body -> keep the pin (avoid re-sending a big context onto a fresh account)
    expect(migPick(pinnedTo([a, b], 'b'), 's:1', cfg, 5000)?.account.id).toBe(
      'b',
    )
    // small body -> cheap moment -> migrate
    expect(migPick(pinnedTo([a, b], 'b'), 's:1', cfg, 500)?.account.id).toBe(
      'a',
    )
  })

  test('drainMigrate on: cost gate holds the drain switch on a large request', () => {
    // The cheapSwitchMaxBytes gate is the OUTER gate around BOTH proactive AND
    // drain migrations in selectForSession (`if (isCheapMoment(requestBytes, cfg)) {
    // const alt = ...; if (proactive || drain) return alt; }`). A regression that
    // moved the gate inside the proactive check (e.g. `if (proactive &&
    // isCheapMoment) ...; if (drain) ...`) would re-send a huge conversation onto
    // a fresh account at the worst time — drain accounts are BY DEFINITION near
    // their weekly reset, so the burned context is wasted. Symmetric to the
    // existing proactive cost-gate test above; this one pins the drain branch.
    const a = account('a', { weekly: win(0.5, 2 * HOUR) }) // imminent reset, high urgency
    const b = account('b', { weekly: win(0.3, 7 * DAY) }) // pinned, healthy
    const cfg = {
      ...DEFAULT_CONFIG,
      drainMigrate: true,
      cheapSwitchMaxBytes: 1000,
    }
    // large body -> keep the pin (drain switch held by the cost gate)
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg, 5000)
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
  })

  test('drainMigrate on: cost gate allows the drain switch on a small request', () => {
    // Symmetric to the test above — pins that the drain branch IS reachable once
    // the request is small enough to fit the gate. Without this counterpart, a
    // regression that hard-coded the drain branch to FALSE inside the gate would
    // also green-pass: the previous test would still see "stays sticky", just for
    // the wrong reason.
    const a = account('a', { weekly: win(0.5, 2 * HOUR) })
    const b = account('b', { weekly: win(0.3, 7 * DAY) })
    const cfg = {
      ...DEFAULT_CONFIG,
      drainMigrate: true,
      cheapSwitchMaxBytes: 1000,
    }
    // small body -> cheap moment -> drain to the imminently-resetting account
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg, 500)
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
  })

  test('forced switch (hard-exhausted pin) ignores the cost gate even on a huge request', () => {
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(1.0, 5 * DAY) }) // hard-exhausted
    const cfg = { ...DEFAULT_CONFIG, cheapSwitchMaxBytes: 1000 }
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg, 99999)
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
  })

  test("drainMigrate off: a healthy pin is kept even when another account's reset is imminent", () => {
    const a = account('a', { weekly: win(0.5, 2 * HOUR) }) // imminent reset, very high urgency
    const b = account('b', { weekly: win(0.3, 7 * DAY) }) // pinned, healthy
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1') // drainMigrate false by default
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
  })

  test('drainMigrate on: a healthy pin yields to drain an imminently-resetting account', () => {
    const a = account('a', { weekly: win(0.5, 2 * HOUR) })
    const b = account('b', { weekly: win(0.3, 7 * DAY) })
    const cfg = { ...DEFAULT_CONFIG, drainMigrate: true }
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg)
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
  })

  test('a pinned account whose 5h window crosses migrateAt migrates even when weekly is healthy', () => {
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', {
      weekly: win(0.5, 5 * DAY), // weekly below the drain target
      hourly: win(0.96, 2 * HOUR), // but 5h over migrateAt (0.95)
    })
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1')
    expect(sel?.account.id).toBe('a')
  })
})
