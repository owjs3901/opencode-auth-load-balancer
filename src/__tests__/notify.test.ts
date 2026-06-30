import { describe, expect, test } from 'bun:test'

import { notifyOnSwitch, type ToastClient } from '../notify'
import type { PoolAccount } from '../types'

function acc(
  id: string,
  weekly: number | null,
  hourly: number | null,
  weeklyResetAt = 0,
  hourlyResetAt = 0,
): PoolAccount {
  return {
    id,
    providerID: 'x',
    label: id,
    access: 't',
    refresh: 'r',
    expires: 0,
    accountId: null,
    usage: {
      weekly:
        weekly === null
          ? null
          : { utilization: weekly, resetAt: weeklyResetAt },
      hourly:
        hourly === null
          ? null
          : { utilization: hourly, resetAt: hourlyResetAt },
      status: null,
      capturedAt: 0,
    },
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: 0,
  }
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
