import { describe, expect, test } from 'bun:test'

import {
  PendingCoordinator,
  type PendingCoordinatorDependencies,
} from '../pending/coordinator'
import type { ProviderRecovery } from '../pending/recovery'
import { pendingKey } from '../pending/store'
import type { PendingRef, PendingTurn } from '../pending/types'
import { DEFAULT_CONFIG } from '../scheduler/config'
import type { PoolFile } from '../types'
import { sleep, sleepAbortable } from '../util'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'

const START = 1_800_000_000_000
const WORKSPACE = 'C:\\work\\alpha'

function ref(id: string): PendingRef {
  return {
    workspace: WORKSPACE,
    providerID: 'anthropic',
    sessionID: `session-${id}`,
    messageID: `message-${id}`,
  }
}

function fullPool(resetAt: number): PoolFile {
  return {
    version: 1,
    accounts: [
      testAccount({
        usage: {
          hourly: null,
          weekly: { utilization: 1, resetAt },
          capturedAt: START,
        },
      }),
    ],
    lastSelected: {},
    sessions: {},
  }
}

function readyPool(): PoolFile {
  return {
    version: 1,
    accounts: [testAccount()],
    lastSelected: {},
    sessions: {},
  }
}

function quota(
  nextCheckAt: number,
  resumeAt: number | null,
): Extract<ProviderRecovery, { state: 'quota-blocked' }> {
  return { state: 'quota-blocked', nextCheckAt, resumeAt }
}

interface Harness {
  coordinator: PendingCoordinator
  turns: Map<string, PendingTurn>
  events: string[]
  setPool(pool: PoolFile): void
  setNow(now: number): void
}

function harness(
  overrides: Partial<PendingCoordinatorDependencies> = {},
): Harness {
  let now = START
  let pool = fullPool(START + 100)
  const turns = new Map<string, PendingTurn>()
  const events: string[] = []
  const dependencies: PendingCoordinatorDependencies = {
    now: () => now,
    sleep: async (ms, signal) => {
      events.push(`sleep:${ms}`)
      await sleepAbortable(0, signal)
      now += ms
    },
    readPool: async () => pool,
    refreshUsage: async () => {
      events.push('refresh')
    },
    upsert: async (pendingRef, schedule) => {
      events.push(`upsert:${pendingRef.messageID}:${schedule.nextCheckAt}`)
      const key = pendingKey(pendingRef)
      const old = turns.get(key)
      const turn: PendingTurn = {
        ...pendingRef,
        key,
        createdAt: old?.createdAt ?? schedule.now,
        updatedAt: schedule.now,
        nextCheckAt: schedule.nextCheckAt,
        resumeAt: schedule.resumeAt,
      }
      turns.set(key, turn)
      return turn
    },
    remove: async (pendingRef) => {
      const key =
        typeof pendingRef === 'string' ? pendingRef : pendingKey(pendingRef)
      events.push(
        `remove:${typeof pendingRef === 'string' ? pendingRef : pendingRef.messageID}`,
      )
      return turns.delete(key)
    },
    acquireLease: async (key) => {
      events.push(`lease:${key}`)
      return {
        release: async () => {
          events.push(`release:${key}`)
        },
      }
    },
    onPending: async (_pendingRef, recovery) => {
      events.push(`pending:${recovery.nextCheckAt}:${recovery.resumeAt}`)
    },
    onResumed: async (pendingRef) => {
      events.push(`resumed:${pendingRef.messageID}`)
    },
    ...overrides,
  }
  return {
    coordinator: new PendingCoordinator({
      workspace: WORKSPACE,
      adapter: fakeAdapter(),
      config: DEFAULT_CONFIG,
      dependencies,
    }),
    turns,
    events,
    setPool(value) {
      pool = value
    },
    setNow(value) {
      now = value
    },
  }
}

describe('PendingCoordinator live waits', () => {
  test('persists before waiting, rechecks usage, resumes, and completes explicitly', async () => {
    const h = harness()
    h.setPool(readyPool())
    const pendingRef = ref('one')

    expect(
      await h.coordinator.waitForCapacity(
        pendingRef,
        quota(START + 100, START + 100),
      ),
    ).toBe('available')
    expect(h.events.slice(0, 3)).toEqual([
      `lease:${pendingKey(pendingRef)}`,
      `upsert:${pendingRef.messageID}:${START + 100}`,
      `pending:${START + 100}:${START + 100}`,
    ])
    expect(h.events).toContain('sleep:100')
    expect(h.events).toContain('refresh')
    expect(h.events).toContain(`resumed:${pendingRef.messageID}`)
    expect(h.turns.has(pendingKey(pendingRef))).toBe(true)

    await h.coordinator.complete(pendingRef)
    expect(h.turns.has(pendingKey(pendingRef))).toBe(false)
    expect(h.events.at(-1)).toBe(`release:${pendingKey(pendingRef)}`)
  })

  test('updates a still-blocked row without repeating an unchanged pending toast', async () => {
    let reads = 0
    const h = harness({
      readPool: async () => {
        reads += 1
        return reads === 1 ? fullPool(START + 200) : readyPool()
      },
    })
    const pendingRef = ref('loop')

    expect(
      await h.coordinator.waitForCapacity(
        pendingRef,
        quota(START + 100, START + 200),
      ),
    ).toBe('available')
    expect(
      h.events.filter((event) => event.startsWith('upsert:')),
    ).toHaveLength(2)
    expect(h.events.filter((event) => event.startsWith('pending:'))).toEqual([
      `pending:${START + 100}:${START + 200}`,
    ])
    await h.coordinator.complete(pendingRef)
  })

  test('different sessions wait concurrently without a provider-wide queue', async () => {
    const sleepers: (() => void)[] = []
    let ready = false
    const h = harness({
      sleep: (_ms, signal) =>
        new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal?.reason)
          signal?.addEventListener('abort', onAbort, { once: true })
          sleepers.push(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          })
        }),
      readPool: async () => (ready ? readyPool() : fullPool(START + 100)),
    })
    const firstRef = ref('first')
    const secondRef = ref('second')
    const first = h.coordinator.waitForCapacity(
      firstRef,
      quota(START + 100, START + 100),
    )
    const second = h.coordinator.waitForCapacity(
      secondRef,
      quota(START + 100, START + 100),
    )
    while (sleepers.length < 2) await sleep(0)

    ready = true
    for (const wake of sleepers) wake()
    expect(await Promise.all([first, second])).toEqual([
      'available',
      'available',
    ])
    await Promise.all([
      h.coordinator.complete(firstRef),
      h.coordinator.complete(secondRef),
    ])
  })

  test('an explicit abort deletes the row and releases its lease', async () => {
    const h = harness({ sleep: sleepAbortable })
    const pendingRef = ref('cancel')
    const controller = new AbortController()
    const waiting = h.coordinator.waitForCapacity(
      pendingRef,
      quota(START + 60_000, START + 60_000),
      controller.signal,
    )
    while (!h.turns.has(pendingKey(pendingRef))) await sleep(0)
    controller.abort()

    await expect(waiting).rejects.toHaveProperty('name', 'AbortError')
    expect(h.turns.has(pendingKey(pendingRef))).toBe(false)
    expect(h.events).toContain(`remove:${pendingRef.messageID}`)
    expect(h.events).toContain(`release:${pendingKey(pendingRef)}`)
  })

  test('dispose aborts live waits but preserves durable rows for restart', async () => {
    const h = harness({ sleep: sleepAbortable })
    const pendingRef = ref('shutdown')
    const waiting = h.coordinator.waitForCapacity(
      pendingRef,
      quota(START + 60_000, START + 60_000),
    )
    while (!h.turns.has(pendingKey(pendingRef))) await sleep(0)
    await h.coordinator.dispose()

    await expect(waiting).rejects.toThrow('OpenCode plugin disposed')
    expect(h.turns.has(pendingKey(pendingRef))).toBe(true)
    expect(h.events).not.toContain(`remove:${pendingRef.messageID}`)
    expect(h.events).toContain(`release:${pendingKey(pendingRef)}`)
  })

  test('a provider that becomes non-quota unusable clears pending and returns unusable', async () => {
    const h = harness()
    h.setPool({ version: 1, accounts: [], lastSelected: {}, sessions: {} })
    const pendingRef = ref('unusable')

    expect(
      await h.coordinator.waitForCapacity(
        pendingRef,
        quota(START + 100, START + 100),
      ),
    ).toBe('unusable')
    expect(h.turns.has(pendingKey(pendingRef))).toBe(false)
  })

  test('an initial persistence failure releases the lease and never sleeps', async () => {
    const h = harness({
      upsert: async () => {
        throw new Error('disk full')
      },
    })
    const pendingRef = ref('disk')

    await expect(
      h.coordinator.waitForCapacity(
        pendingRef,
        quota(START + 100, START + 100),
      ),
    ).rejects.toThrow('disk full')
    expect(h.events.some((event) => event.startsWith('sleep:'))).toBe(false)
    expect(h.events).toContain(`release:${pendingKey(pendingRef)}`)
  })
})
