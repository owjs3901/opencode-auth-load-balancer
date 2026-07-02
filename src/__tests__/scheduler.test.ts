import { describe, expect, test } from 'bun:test'

import { DEFAULT_CONFIG } from '../scheduler/config'
import {
  isAvailable,
  isExhausted,
  weeklyUrgency,
} from '../scheduler/score-core'
import { selectAccount, selectForSession } from '../scheduler/select'
import type {
  PoolAccount,
  PoolFile,
  SessionAssignment,
  UsageWindow,
} from '../types'
import { testAccount } from './fixtures/account'

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
  return testAccount({
    id,
    providerID: opts.providerID ?? 'anthropic',
    label: id,
    access: 'a',
    expires: NOW + 8 * HOUR,
    usage: {
      hourly: opts.hourly ?? null,
      weekly: opts.weekly ?? null,
      status: null,
      capturedAt: NOW,
    },
    cooldownUntil: opts.cooldownUntil ?? 0,
    disabledReason: opts.disabled ?? null,
    createdAt: NOW,
  })
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

  test('known utilization + UNKNOWN anchor ranks FIRST (probe-first: the fixed reset may be imminent)', () => {
    // Post-quota-reset shape: the endpoint confirmed 0% used but resets_at was
    // null and no anchor was ever seen. Weekly anchors are FIXED per account,
    // so "unknown" may be hours away — the scheduler must route ONE request to
    // discover it instead of assuming a full week of slack.
    const unknownAnchor = account('probe', {
      weekly: { utilization: 0, resetAt: 0 },
    })
    const knownSoon = account('soon', { weekly: win(0.03, 29 * HOUR) })
    const knownFar = account('far', { weekly: win(0.07, 5 * DAY) })
    expect(pick([knownFar, unknownAnchor, knownSoon])).toBe('probe')
    expect(weeklyUrgency(unknownAnchor, DEFAULT_CONFIG, NOW)).toBeGreaterThan(
      weeklyUrgency(knownSoon, DEFAULT_CONFIG, NOW),
    )
  })

  test('a MISSING weekly window (never polled) keeps the conservative baseline — no probe boost', () => {
    // utilization itself is unknown; the free usage-endpoint poll resolves this
    // without routing traffic, so it must NOT outrank a known soon-resetting
    // account.
    const neverPolled = account('blind', { weekly: null })
    const knownSoon = account('soon', { weekly: win(0.03, 29 * HOUR) })
    expect(pick([neverPolled, knownSoon])).toBe('soon')
  })

  test('an unknown-anchor account with NO headroom never gets the probe boost (drainable gates it)', () => {
    const exhaustedUnknown = account('full', {
      weekly: { utilization: 1.0, resetAt: 0 },
    })
    expect(weeklyUrgency(exhaustedUnknown, DEFAULT_CONFIG, NOW)).toBe(0)
  })

  test('an ELAPSED weekly anchor keeps the conservative full-window baseline — no probe boost', () => {
    // A window PRESENT with `resetAt` in the PAST (stale, elapsed anchor) must
    // take the `weekWindowMs` baseline, per weeklyUrgency's jsdoc — only the
    // `resetAt === 0` unknown-anchor shape gets the imminent-reset probe boost.
    // A regression widening the probe condition to `weekly ? cfg.minResetMs :
    // cfg.weekWindowMs` (treating ANY present window as probe-imminent) would
    // pass the unknown-anchor and missing-window tests above but misrank every
    // account whose anchor has merely lapsed; this pins both orderings.
    const elapsed = account('elapsed', {
      weekly: { utilization: 0.5, resetAt: NOW - HOUR },
    })
    const soon = account('soon', { weekly: win(0.03, 29 * HOUR) })
    expect(pick([elapsed, soon])).toBe('soon')
    const unknownAnchorProbe = account('probe', {
      weekly: { utilization: 0, resetAt: 0 },
    })
    expect(weeklyUrgency(elapsed, DEFAULT_CONFIG, NOW)).toBeLessThan(
      weeklyUrgency(unknownAnchorProbe, DEFAULT_CONFIG, NOW),
    )
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
    expect(isExhausted(exhausted, DEFAULT_CONFIG, NOW)).toBe(true)
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

describe('stale (already-reset) windows count as fresh headroom, not exhaustion', () => {
  test('a 5h window stuck at 100% whose reset already passed is available again', () => {
    // owjs3901's real shape: the 5h window read 100% but its reset is in the PAST (the
    // window rolled over), while weekly is still live at 48%. The elapsed 5h must count as
    // full headroom — otherwise the account is excluded, never picked, never re-polled, and
    // stays "full" forever even though it has not been used.
    const reset5h = account('reset5h', {
      hourly: win(1.0, -HOUR), // resetAt = NOW - HOUR: already elapsed
      weekly: win(0.48, 14 * HOUR),
    })
    expect(isExhausted(reset5h, DEFAULT_CONFIG, NOW)).toBe(false)
    expect(isAvailable(reset5h, DEFAULT_CONFIG, NOW)).toBe(true)
  })

  test('the elapsed-5h account outranks a genuinely busier one and is picked', () => {
    const reset5h = account('reset5h', {
      hourly: win(1.0, -HOUR),
      weekly: win(0.48, 14 * HOUR),
    })
    const busy = account('busy', { weekly: win(0.9, 14 * HOUR) })
    expect(pick([reset5h, busy])).toBe('reset5h')
  })

  test('an account whose weekly window already reset is no longer exhausted', () => {
    const resetWk = account('resetWk', { weekly: win(1.0, -DAY) }) // weekly elapsed
    expect(isExhausted(resetWk, DEFAULT_CONFIG, NOW)).toBe(false)
    expect(isAvailable(resetWk, DEFAULT_CONFIG, NOW)).toBe(true)
  })

  test('a 100% window with an UNKNOWN reset (resetAt 0) stays exhausted (not treated as reset)', () => {
    // resetAt === 0 means "no reset metadata", NOT "the window elapsed": keep the reported
    // utilization so a genuinely-maxed account with no reset time is still excluded.
    const unknown = account('unknown', {
      weekly: { utilization: 1.0, resetAt: 0 },
    })
    expect(isExhausted(unknown, DEFAULT_CONFIG, NOW)).toBe(true)
    expect(isAvailable(unknown, DEFAULT_CONFIG, NOW)).toBe(false)
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

  test('a stale CROSS-PROVIDER pin is ignored (fresh pick, not sticky)', () => {
    // Locks the `a.providerID === providerID` conjunct in findPinned: a pool
    // file may carry a pin to an account of a DIFFERENT provider (e.g. an
    // older, un-namespaced session-key scheme). Without the guard, findPinned
    // would resolve the openai account for an anthropic request and re-serve
    // the cross-provider pin; deleting the conjunct must fail this test.
    const o = account('o', { providerID: 'openai', weekly: win(0.1, 3 * DAY) })
    const a = account('a', { weekly: win(0.6, 7 * DAY) })
    const pool = poolOf([o, a], {
      's:x': { accountId: 'o', updatedAt: NOW },
    })
    const sel = sessionPick(pool, 's:x')
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
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
    // 0.985: over the weekly drain target (0.98) so a proactive switch is on the
    // table, but BELOW the imminent-exhaustion band (0.989) so the byte cost gate
    // still applies. (The imminent bypass is exercised in its own test below.)
    const b = account('b', { weekly: win(0.985, 5 * DAY) })
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

  test('proactive migration is held back when the only alternative is cooling down (degraded)', () => {
    // Pinned `b` is over the weekly drain target (0.99 > 0.98) so the proactive
    // branch WOULD fire — but the sole alt `a` is currently cooling down. A
    // degraded alt is selectAccount's least-bad pick of the unavailable set;
    // switching onto it would just 429 again on the next request, extend its
    // cooldown, and briefly flip the in-use marker before falling back. The
    // healthy pin must keep serving until either it itself becomes unavailable
    // (forced-switch path) or a genuinely available alt appears.
    const a = account('a', {
      weekly: win(0.5, 5 * DAY),
      cooldownUntil: NOW + HOUR,
    })
    const b = account('b', { weekly: win(0.99, 5 * DAY) })
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1')
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
    expect(sel?.degraded).toBe(false)
  })

  test('drain migration is held back when the only alternative is cooling down (degraded)', () => {
    // Symmetric to the proactive guard: with drainMigrate on, alt `a`'s
    // imminent weekly reset (2h) would normally dominate the pin's urgency by
    // drainMigrateMargin (1.5x), but its cooldown disqualifies it from a
    // non-forced migration. A near-reset account in cooldown is the WORST kind
    // of switch target — its quota is perishable AND it can't actually serve
    // right now. Stay on the healthy pin.
    const a = account('a', {
      weekly: win(0.5, 2 * HOUR),
      cooldownUntil: NOW + HOUR,
    })
    const b = account('b', { weekly: win(0.3, 7 * DAY) })
    const cfg = { ...DEFAULT_CONFIG, drainMigrate: true }
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg)
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
    expect(sel?.degraded).toBe(false)
  })

  test('drainMigrate on: a zero-urgency tie keeps the pin sticky (no wasteful migration)', () => {
    // Boundary lock: when BOTH the pin AND the best alt are past
    // `weeklyDrainTarget` (0.98) but still below `exhaustedAt` (0.999),
    // `weeklyUrgency` collapses to 0 for each (its `drainable = max(0,
    // weeklyDrainTarget - util)` term zeroes out). Pre-fix the drain check
    // `0 >= 0 * 1.5` evaluated true and the drain branch fired a useless
    // migration — no perishable quota to chase, just a lost prompt cache and a
    // re-billed conversation context on a fresh account with the same headroom.
    // The proactive branch correctly stays silent here (`maxUtil(alt)` ties at
    // 0.985 so the `<` guard fails), so drain is the only path that could
    // wrongly fire. Post-fix the `altUrgency > 0` guard keeps the pin sticky.
    const a = account('a', { weekly: win(0.985, 5 * DAY) })
    const b = account('b', { weekly: win(0.985, 5 * DAY) }) // pinned
    const cfg = { ...DEFAULT_CONFIG, drainMigrate: true }
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg)
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
    expect(sel?.degraded).toBe(false)
  })

  test('does NOT migrate when pinned weekly is between migrateAt (0.95) and weeklyDrainTarget (0.98)', () => {
    // Boundary lock: the WEEKLY window migrates at weeklyDrainTarget (~0.98)
    // because weekly quota is perishable — drain nearly full before reset. The
    // shorter 5h window migrates EARLIER at migrateAt (~0.95) for hard-limit
    // safety. A pinned account whose weekly sits in the GAP (above 0.95, below
    // 0.98) must STAY pinned: it still has perishable quota worth draining and
    // is nowhere near the hard 100% wall. A regression that used migrateAt for
    // BOTH windows would migrate here, spreading weekly quota across accounts
    // and wasting it. The existing weekly tests pin only 0.99 (above 0.98 ->
    // migrate) and 0.9 (below 0.95 -> sticky); this fills the gap between them.
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(0.96, 5 * DAY) }) // pinned, in the gap
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1')
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
    expect(sel?.degraded).toBe(false)
  })

  test('cheapSwitchMaxBytes defaults to 64 KiB (cost gate ON, so big-context switches are held)', () => {
    // Regression lock on the default. Before, the gate was OFF (0) and proactive
    // migrations re-sent the whole conversation onto a fresh, uncached account
    // regardless of size — a full prompt-cache write. 64 KiB lets cheap early-turn
    // switches through while holding grown conversations.
    expect(DEFAULT_CONFIG.cheapSwitchMaxBytes).toBe(64 * 1024)
  })

  test('imminent exhaustion bypasses the cost gate: a huge request still migrates to a healthier account', () => {
    // Pinned `b` (0.99) is within IMMINENT_EXHAUSTION_BAND (0.01) of hard exhaustion
    // (>= exhaustedAt 0.999 - 0.01 = 0.989). A forced, cost-gate-IGNORING switch is
    // coming next turn anyway, and opencode re-sends the whole (only-growing)
    // conversation each turn — so migrate NOW even though the request (5000 B) is far
    // over the 1000 B gate. This is the whole point: the byte gate must never DELAY a
    // switch into a MORE expensive forced one.
    const a = account('a', { weekly: win(0.2, 5 * DAY) })
    const b = account('b', { weekly: win(0.99, 5 * DAY) })
    const cfg = { ...DEFAULT_CONFIG, cheapSwitchMaxBytes: 1000 }
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg, 5000)
    expect(sel?.account.id).toBe('a')
    expect(sel?.sticky).toBe(false)
  })

  test('below the imminent band, a proactive switch needs a real headroom margin (no A->B->A thrash)', () => {
    // Pinned `b` (0.985) is over the weekly drain target (0.98) but below the imminent
    // band (0.989). Alt `a` (0.98) is only 0.005 more headroom — under
    // PROACTIVE_MIGRATE_MIN_DELTA (0.02) — so the pin is KEPT. Without the margin, two
    // accounts hovering here ping-pong A->B->A across turns, each switch paying a full
    // prompt-cache write. The request is cheap (0 B), so only the margin holds it.
    const a = account('a', { weekly: win(0.98, 5 * DAY) })
    const b = account('b', { weekly: win(0.985, 5 * DAY) })
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1')
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
    expect(sel?.degraded).toBe(false)
  })

  test('in the imminent band, still will not switch to a worse-headroom account', () => {
    // Even imminent, the alt must genuinely have MORE headroom: the bypass only lets
    // us LOOK past the byte gate, it does not force a bad move. Pinned `b` (0.99,
    // imminent) vs alt `a` (0.995, busier) on a huge request -> `altUtil < pinnedUtil`
    // fails -> stay. Switching to a busier account would re-cache the whole context
    // onto something even closer to the wall.
    const a = account('a', { weekly: win(0.995, 5 * DAY) })
    const b = account('b', { weekly: win(0.99, 5 * DAY) })
    const cfg = { ...DEFAULT_CONFIG, cheapSwitchMaxBytes: 1000 }
    const sel = migPick(pinnedTo([a, b], 'b'), 's:1', cfg, 5000)
    expect(sel?.account.id).toBe('b')
    expect(sel?.sticky).toBe(true)
  })
})
