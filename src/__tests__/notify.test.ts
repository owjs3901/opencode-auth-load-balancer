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
})
