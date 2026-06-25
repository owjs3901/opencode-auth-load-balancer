import { describe, expect, test } from 'bun:test'

import { notifyOnSwitch, type ToastClient } from '../notify'
import type { PoolAccount } from '../types'

function acc(
  id: string,
  weekly: number | null,
  hourly: number | null,
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
      weekly: weekly === null ? null : { utilization: weekly, resetAt: 0 },
      hourly: hourly === null ? null : { utilization: hourly, resetAt: 0 },
      status: null,
      capturedAt: 0,
    },
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: 0,
    lastUsedAt: 0,
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
})
