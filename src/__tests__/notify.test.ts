import { describe, expect, test } from 'bun:test'

import {
  notifyModelFallback,
  notifyOnSwitch,
  type ToastClient,
} from '../notify'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'

function acc(
  id: string,
  weekly: number | null,
  hourly: number | null,
  weeklyResetAt = 0,
  hourlyResetAt = 0,
): PoolAccount {
  return testAccount({
    id,
    label: id,
    usage: {
      weekly:
        weekly === null
          ? null
          : { utilization: weekly, resetAt: weeklyResetAt },
      hourly:
        hourly === null
          ? null
          : { utilization: hourly, resetAt: hourlyResetAt },
      capturedAt: 0,
    },
  })
}

function spyClient() {
  const calls: { title?: string; message: string }[] = []
  const client: ToastClient = {
    tui: {
      showToast: async (o) => {
        calls.push(o.body)
        return undefined
      },
    },
  }
  return { client, calls }
}

describe('notifyOnSwitch', () => {
  test('toasts on first use and on a real switch, deduped while unchanged', async () => {
    const { client, calls } = spyClient()
    await notifyOnSwitch(client, 'p1', acc('a1', 0.45, 0.12))
    await notifyOnSwitch(client, 'p1', acc('a1', 0.45, 0.12)) // same account -> deduped
    await notifyOnSwitch(client, 'p1', acc('a2', 0.1, null)) // switched -> toast again

    expect(calls).toHaveLength(2)
    expect(calls[0]?.message).toContain('a1')
    expect(calls[0]?.message).toContain('45%') // weekly pct
    expect(calls[0]?.message).toContain('12%') // 5h pct
    expect(calls[1]?.message).toContain('a2')
    expect(calls[1]?.message).toContain('-') // null 5h utilization renders as "-"
  })

  test('uses the provider fallback name and survives a failing toast', async () => {
    const client: ToastClient = {
      tui: {
        showToast: async () => {
          throw new Error('tui down')
        },
      },
    }
    await expect(
      notifyOnSwitch(client, 'p2', acc('z1', 1, 1)),
    ).resolves.toBeUndefined()
  })

  test('renders 0% for an elapsed window (uses displayUtil, not the raw stored utilization)', async () => {
    const { client, calls } = spyClient()
    const now = Date.now()
    // Both windows have ALREADY ROLLED OVER (resetAt in the past) but the stored
    // utilization snapshots are still 75% / 50% (no fresh poll since the reset).
    // The toast must agree with the dashboard / scheduler and show 0%, not the
    // stale stored values.
    await notifyOnSwitch(
      client,
      'p-expired',
      acc('exp1', 0.75, 0.5, now - 60_000, now - 60_000),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.message).toContain('weekly 0%')
    expect(calls[0]?.message).toContain('5h 0%')
  })

  test('elapsed weekly renders 0% while a null hourly still renders "-"', async () => {
    const { client, calls } = spyClient()
    const now = Date.now()
    // Locks the "null still renders -" arm of displayUtil/pct alongside the
    // expired-window "0%" arm — null is the no-data case, expired is the
    // freshly-reset-with-full-headroom case, and they must stay distinct.
    await notifyOnSwitch(
      client,
      'p-mixed',
      acc('exp2', 0.75, null, now - 60_000),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.message).toContain('weekly 0%')
    expect(calls[0]?.message).toContain('5h -')
  })
})

describe('notifyModelFallback', () => {
  test('toasts the downgrade once per account+source-model within a window, re-toasting when the source changes', async () => {
    const { client, calls } = spyClient()
    const windowEnd = Date.now() + 3 * 24 * 60 * 60 * 1000
    const a = testAccount({
      id: 'fb1',
      label: 'fb1',
      // Two active tiers: the de-dupe key uses the LATEST window (the max
      // entry), exercising both comparison outcomes of the max scan.
      modelCooldownsUntil: { fable: windowEnd - 1000, opus: windowEnd },
    })
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    )
    // Same account + same source model + same exhaustion window on the next
    // turn -> deduped (no re-toast).
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    )
    // A different source model on the same account -> toasts again.
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-opus-4-1',
      'claude-sonnet-4-6',
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.title).toContain('model fallback')
    expect(calls[0]?.message).toContain('fb1')
    expect(calls[0]?.message).toContain('claude-opus-4-7')
    expect(calls[0]?.message).toContain('claude-sonnet-4-6')
    expect(calls[1]?.message).toContain('claude-opus-4-1')
  })

  test('re-toasts when the tier re-exhausts in a NEW window (fresh modelCooldownsUntil entry)', async () => {
    // The README promises the downgrade is "never silent". A de-dupe keyed on
    // fromModel alone silenced every exhaustion window after the first in a
    // process's lifetime: cap exhausts -> toast; cap RESETS and the tier serves
    // for days; cap exhausts again -> silent. The de-dupe value is scoped to
    // the exhaustion window (`fromModel@<latest tier window>`), so a new
    // window must toast again while turns WITHIN one window stay deduped.
    const { client, calls } = spyClient()
    const DAY = 24 * 60 * 60 * 1000
    const firstWindow = Date.now() + 3 * DAY
    const first = testAccount({
      id: 'fbw',
      label: 'fbw',
      modelCooldownsUntil: { opus: firstWindow },
    })
    await notifyModelFallback(client, 'p1', first, 'opus', 'sonnet')
    await notifyModelFallback(client, 'p1', first, 'opus', 'sonnet') // same window -> deduped
    expect(calls).toHaveLength(1)

    // The tier cap reset, served for days, then re-exhausted: same account id,
    // NEW cooldown window -> the downgrade must be announced again.
    const second = testAccount({
      id: 'fbw',
      label: 'fbw',
      modelCooldownsUntil: { opus: firstWindow + 7 * DAY },
    })
    await notifyModelFallback(client, 'p1', second, 'opus', 'sonnet')
    expect(calls).toHaveLength(2)
    // ...and turns within the second window are deduped again.
    await notifyModelFallback(client, 'p1', second, 'opus', 'sonnet')
    expect(calls).toHaveLength(2)
  })

  test('ignores a stale, larger tier timestamp so a fresh smaller-window fallback still toasts', async () => {
    // Nothing in the codebase purges a `modelCooldownsUntil[tier]` entry once
    // it expires, so a long-reset tier exhausted weeks ago can still be
    // sitting in the map with a NUMERICALLY LARGER (but already-past)
    // timestamp than the tier that just triggered THIS downgrade. The max
    // scan must ignore expired entries, or the de-dupe key stays unchanged
    // across a genuinely new exhaustion window and the toast goes silent.
    const { client, calls } = spyClient()
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const a = testAccount({
      id: 'stale1',
      label: 'stale1',
      modelCooldownsUntil: {
        // Stale: expired long ago, but numerically larger than the fresh
        // window below.
        opus: now - DAY,
        // Fresh: currently active, the tier that actually triggered this
        // fallback, with a smaller absolute timestamp than the stale entry.
        fable: now + 1000,
      },
    })
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-fable-5',
      'claude-opus-4-9',
    )
    expect(calls).toHaveLength(1)

    // Same account/source-model/fresh-window on the next turn -> deduped,
    // exactly like the non-stale case.
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-fable-5',
      'claude-opus-4-9',
    )
    expect(calls).toHaveLength(1)

    // The fable tier re-exhausts in a NEW window -> must announce again, even
    // though the stale opus entry is still sitting in the map unchanged.
    const b = testAccount({
      id: 'stale1',
      label: 'stale1',
      modelCooldownsUntil: {
        opus: now - DAY,
        fable: now + 2 * DAY,
      },
    })
    await notifyModelFallback(
      client,
      'p1',
      b,
      'claude-fable-5',
      'claude-opus-4-9',
    )
    expect(calls).toHaveLength(2)
  })

  test('with fromTier supplied, scopes the de-dupe window to the TRIGGERING tier, not the max-scan', async () => {
    // Two simultaneously-active tiers (a chained fable -> opus -> sonnet
    // downgrade, both still cooling down): the max-scan alone would pick
    // whichever window is LATER, not necessarily the tier that actually
    // triggered this toast. `fromTier` must override that.
    const { client, calls } = spyClient()
    const now = Date.now()
    const DAY = 24 * 60 * 60 * 1000
    const fableWindow = now + DAY // triggering tier: the SMALLER window
    const opusWindow = now + 5 * DAY // unrelated, but numerically LARGER
    const a = testAccount({
      id: 'tiered1',
      label: 'tiered1',
      modelCooldownsUntil: { fable: fableWindow, opus: opusWindow },
    })
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-fable-5',
      'claude-sonnet-4-6',
      'fable',
    )
    expect(calls).toHaveLength(1)

    // Same triggering tier/window on the next turn -> deduped, exactly like
    // the max-scan path.
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-fable-5',
      'claude-sonnet-4-6',
      'fable',
    )
    expect(calls).toHaveLength(1)

    // The fable tier re-exhausts in a NEW window -> announces again, even
    // though the unrelated (larger) opus window is unchanged — proving the
    // de-dupe key tracked fable's own window, not the max of the two.
    const b = testAccount({
      id: 'tiered1',
      label: 'tiered1',
      modelCooldownsUntil: { fable: fableWindow + DAY, opus: opusWindow },
    })
    await notifyModelFallback(
      client,
      'p1',
      b,
      'claude-fable-5',
      'claude-sonnet-4-6',
      'fable',
    )
    expect(calls).toHaveLength(2)
  })

  test('fromTier whose own window already expired falls back to the max-scan heuristic', async () => {
    const { client, calls } = spyClient()
    const now = Date.now()
    const activeWindow = now + 24 * 60 * 60 * 1000
    const a = testAccount({
      id: 'staletier1',
      label: 'staletier1',
      // `fromTier` names a tier whose OWN cooldown already lapsed (stale
      // bookkeeping), while a different tier is still genuinely active.
      modelCooldownsUntil: { opus: now - 1000, sonnet: activeWindow },
    })
    await notifyModelFallback(
      client,
      'p1',
      a,
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'opus',
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.message).toContain('claude-opus-4-7')
    expect(calls[0]?.message).toContain('claude-sonnet-4-6')
  })

  test('survives a failing toast (best-effort, never affects the request)', async () => {
    const client: ToastClient = {
      tui: {
        showToast: async () => {
          throw new Error('tui down')
        },
      },
    }
    await expect(
      notifyModelFallback(
        client,
        'p-fail',
        testAccount({ id: 'fbz', label: 'fbz' }),
        'claude-opus-4-7',
        'claude-sonnet-4-6',
      ),
    ).resolves.toBeUndefined()
  })

  test('lastFallbackToasted cache clears when full (LAST_FALLBACK_TOASTED_MAX = 256), re-toasting a pre-clear key but never missing a post-clear one', async () => {
    // Bounded-resource regression test: without the cap, this map leaks one
    // entry per distinct provider+account ever downgraded for the life of a
    // long-running process (TUI sidebar deletes + re-logins over
    // weeks/months). `lastFallbackToasted` is a MODULE-LEVEL singleton shared
    // across every test in this file, so this test drives well past the cap
    // (300 distinct keys, vs. the 256 max) rather than asserting an exact
    // absolute size — that stays correct regardless of how many entries
    // earlier tests in this describe block already left behind.
    const { client, calls } = spyClient()
    const windowEnd = Date.now() + 3 * 24 * 60 * 60 * 1000
    const acctAt = (i: number) =>
      testAccount({
        id: `cap${i}`,
        label: `cap${i}`,
        modelCooldownsUntil: { opus: windowEnd },
      })

    const TOTAL = 300
    for (let i = 0; i < TOTAL; i++) {
      await notifyModelFallback(client, 'p1', acctAt(i), 'opus', 'sonnet')
    }
    expect(calls).toHaveLength(TOTAL) // every distinct key toasts once

    // The MOST RECENTLY inserted key cannot yet have been evicted by a
    // clear — its repeat still dedupes.
    await notifyModelFallback(client, 'p1', acctAt(TOTAL - 1), 'opus', 'sonnet')
    expect(calls).toHaveLength(TOTAL)

    // 300 distinct inserts is well past the 256 cap, so at least one
    // clear-on-full boundary fired somewhere in the loop above, wiping the
    // FIRST key this test inserted. Its repeat (same exhaustion window) now
    // re-toasts — the accepted trade-off: a clear can cause one EXTRA
    // toast, but never a MISSED one.
    await notifyModelFallback(client, 'p1', acctAt(0), 'opus', 'sonnet')
    expect(calls).toHaveLength(TOTAL + 1)
  })
})
