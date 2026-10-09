import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { acquireLock } from '../pool/lock'
import { syncStateFilePath } from '../pool/paths'
import { encodeKey, generateKey } from '../sync/crypto'
import type { Outcome, SyncEngine } from '../sync/engine'
import type { SyncIntent } from '../sync/intent'
import {
  CHANGE_CHECK_MS,
  createSyncLoop,
  DEBOUNCE_MS,
  type LoopTimers,
  POLL_MS,
  PUBLISH_RETRY_MS,
  realTimers,
  withCycleLock,
} from '../sync/loop'
import { startSync, syncEnabled } from '../sync/start'
import { type SyncRole, type SyncState, updateSyncState } from '../sync/state'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-sync-loop-'))
const ID = 'c'.repeat(32)
const OK: Outcome = { ok: true, message: 'ok' }

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(syncStateFilePath(), { force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
  delete process.env.OPENCODE_AUTH_LB_SYNC
})

const setRole = (role: SyncRole | null) =>
  updateSyncState(() =>
    role
      ? ({
          v: 1,
          role,
          gistId: ID,
          key: encodeKey(generateKey()),
          imported: {},
        } satisfies SyncState)
      : null,
  )

/** An engine that records its calls and answers from `script`. */
function scriptedEngine() {
  const calls: string[] = []
  const script: {
    poll: Outcome | Promise<Outcome>
    upload: Outcome
    digest: string | null
  } = { poll: OK, upload: OK, digest: null }
  const engine: SyncEngine = {
    poll: async () => {
      calls.push('poll')
      return script.poll
    },
    upload: async (fresh, reqAt) => {
      calls.push(`upload:${fresh}:${reqAt}`)
      return script.upload
    },
    subscribe: async (link, reqAt) => {
      calls.push(`subscribe:${link}:${reqAt}`)
      return OK
    },
    forget: async (reqAt) => {
      calls.push(`forget:${reqAt}`)
      return OK
    },
    sync: async (reqAt) => {
      calls.push(`sync:${reqAt}`)
      return OK
    },
    unpublishedDigest: async () => script.digest,
  }
  return { engine, calls, script }
}

function harness(
  take: (now: number) => Promise<SyncIntent | null> = async () => null,
) {
  const clock = { now: 1_000_000 }
  const timers = {
    started: [] as { run: () => void; ms: number }[],
    cleared: [] as unknown[],
  }
  const fake: LoopTimers = {
    set: (run, ms) => {
      timers.started.push({ run, ms })
      return 'handle'
    },
    clear: (handle) => timers.cleared.push(handle),
  }
  const scripted = scriptedEngine()
  const loop = createSyncLoop({
    engine: scripted.engine,
    now: () => clock.now,
    timers: fake,
    take,
  })
  return { clock, timers, loop, ...scripted }
}

describe('subscriber schedule', () => {
  test('downloads at start, then every 15 minutes, checking the state no more often than every 5 seconds', async () => {
    await setRole('subscriber')
    const { loop, clock, calls } = harness()
    await loop.tick()
    expect(calls).toEqual(['poll'])
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    clock.now += POLL_MS - CHANGE_CHECK_MS - 1
    await loop.tick()
    expect(calls).toEqual(['poll'])
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual(['poll', 'poll'])
    clock.now += 1_000
    await loop.tick()
    expect(calls).toEqual(['poll', 'poll'])
  })

  test("nothing runs without a role, or for a publisher's download", async () => {
    const { loop, clock, calls } = harness()
    await loop.tick()
    clock.now += CHANGE_CHECK_MS
    await setRole('publisher')
    await loop.tick()
    expect(calls).toEqual([])
  })

  test('a rate limit holds downloads back for as long as GitHub asked', async () => {
    await setRole('subscriber')
    const { loop, clock, calls, script } = harness()
    script.poll = { ok: false, message: 'limited', backoffMs: 2 * POLL_MS }
    await loop.tick()
    clock.now += POLL_MS
    await loop.tick()
    expect(calls).toEqual(['poll'])
    clock.now += POLL_MS
    await loop.tick()
    expect(calls).toEqual(['poll', 'poll'])
  })
})

describe('publisher schedule', () => {
  test('uploads once the credentials have stopped changing for the debounce window', async () => {
    await setRole('publisher')
    const { loop, clock, calls, script } = harness()
    script.digest = 'd1'
    await loop.tick()
    clock.now += CHANGE_CHECK_MS
    script.digest = 'd2'
    await loop.tick()
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([])
    clock.now += DEBOUNCE_MS
    await loop.tick()
    expect(calls).toEqual(['upload:false:undefined'])
    script.digest = null
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    clock.now += DEBOUNCE_MS
    await loop.tick()
    expect(calls).toHaveLength(1)
  })

  test('a failed upload is not retried every tick, but after the retry delay', async () => {
    await setRole('publisher')
    const { loop, clock, calls, script } = harness()
    script.digest = 'd1'
    script.upload = { ok: false, message: 'no token' }
    await loop.tick()
    clock.now += DEBOUNCE_MS
    await loop.tick()
    expect(calls).toHaveLength(1)
    clock.now += DEBOUNCE_MS
    await loop.tick()
    expect(calls).toHaveLength(1)
    clock.now += PUBLISH_RETRY_MS
    await loop.tick()
    expect(calls).toHaveLength(2)
  })

  test('a rate-limited upload waits as long as GitHub asked', async () => {
    await setRole('publisher')
    const { loop, clock, calls, script } = harness()
    script.digest = 'd1'
    script.upload = {
      ok: false,
      message: 'limited',
      backoffMs: 3 * PUBLISH_RETRY_MS,
    }
    await loop.tick()
    clock.now += DEBOUNCE_MS
    await loop.tick()
    clock.now += 2 * PUBLISH_RETRY_MS
    await loop.tick()
    expect(calls).toHaveLength(1)
    clock.now += 2 * PUBLISH_RETRY_MS
    await loop.tick()
    expect(calls).toHaveLength(2)
  })

  test('a machine that is mid-run elsewhere skips this round', async () => {
    await setRole('publisher')
    const { loop, clock, calls, script } = harness()
    script.digest = 'd1'
    await loop.tick()
    clock.now += DEBOUNCE_MS
    const held = await acquireLock(`${syncStateFilePath()}.cycle.lock`, {
      staleMs: 60_000,
      timeoutMs: 1_000,
      retryMs: 5,
      heartbeatMs: 5_000,
    })
    try {
      await loop.tick()
      expect(calls).toEqual([])
    } finally {
      await held.release()
    }
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toHaveLength(1)
  })
})

describe('TUI requests', () => {
  const asked = (action: SyncIntent['action'], link?: string): SyncIntent => ({
    action,
    at: 42,
    ...(link ? { link } : {}),
  })

  test.each([
    ['upload', undefined, 'upload:false:42'],
    ['upload-new', undefined, 'upload:true:42'],
    ['subscribe', 'the-link', 'subscribe:the-link:42'],
    ['subscribe', undefined, 'subscribe::42'],
    ['sync', undefined, 'sync:42'],
    ['forget', undefined, 'forget:42'],
  ] as const)(
    '%s runs at once and takes priority over the schedule',
    async (action, link, call) => {
      await setRole('subscriber')
      const { loop, calls } = harness(async () => asked(action, link))
      await loop.tick()
      expect(calls).toEqual([call])
    },
  )

  test('a request resets the download schedule and the upload debounce, and honors a back-off', async () => {
    await setRole('subscriber')
    let next: SyncIntent | null = asked('sync')
    const { loop, clock, calls } = harness(async () => {
      const intent = next
      next = null
      return intent
    })
    await loop.tick()
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual(['sync:42'])
  })

  test('a request whose engine asks for a back-off holds downloads off', async () => {
    await setRole('subscriber')
    let next: SyncIntent | null = asked('upload')
    const { loop, clock, calls, script } = harness(async () => {
      const intent = next
      next = null
      return intent
    })
    script.upload = { ok: false, message: 'limited', backoffMs: 2 * POLL_MS }
    await loop.tick()
    clock.now += POLL_MS + CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual(['upload:false:42'])
  })

  test('a request is not lost to a busy lock: it waits for it', async () => {
    const { loop, calls } = harness(async () => asked('sync'))
    const held = await acquireLock(`${syncStateFilePath()}.cycle.lock`, {
      staleMs: 60_000,
      timeoutMs: 1_000,
      retryMs: 5,
      heartbeatMs: 5_000,
    })
    const running = loop.tick()
    await Bun.sleep(60)
    expect(calls).toEqual([])
    await held.release()
    await running
    expect(calls).toEqual(['sync:42'])
  })
})

describe('lifecycle', () => {
  test('start schedules a one-second tick and runs one at once; dispose clears it and stops ticking', async () => {
    await setRole('subscriber')
    const { loop, timers, calls } = harness()
    loop.start()
    expect(timers.started.map((t) => t.ms)).toEqual([1_000])
    await Bun.sleep(30)
    expect(calls).toEqual(['poll'])
    loop.dispose()
    expect(timers.cleared).toEqual(['handle'])
    await loop.tick()
    timers.started[0]?.run()
    expect(calls).toEqual(['poll'])
  })

  test('the scheduled tick runs the loop', async () => {
    const taken: number[] = []
    const { loop, timers } = harness(async (now) => {
      taken.push(now)
      return null
    })
    loop.start()
    await Bun.sleep(30)
    timers.started[0]?.run()
    await Bun.sleep(30)
    expect(taken).toHaveLength(2)
    loop.dispose()
  })

  test('runs never overlap', async () => {
    await setRole('subscriber')
    const { loop, calls, script } = harness()
    let release: (outcome: Outcome) => void = () => undefined
    script.poll = new Promise<Outcome>((resolve) => {
      release = resolve
    })
    const first = loop.tick()
    await Bun.sleep(30)
    await loop.tick()
    expect(calls).toEqual(['poll'])
    release(OK)
    await first
  })

  test('a failing step is swallowed and the next one still runs', async () => {
    await setRole('subscriber')
    let fail = true
    const { loop, clock, calls } = harness(async () => {
      if (fail) throw new Error('disk')
      return null
    })
    await loop.tick()
    fail = false
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual(['poll'])
  })

  test('real timers tick without keeping the process alive', () => {
    let ran = 0
    const handle = realTimers.set(() => {
      ran += 1
    }, 5)
    expect(typeof (handle as { unref: unknown }).unref).toBe('function')
    realTimers.clear(handle)
    expect(ran).toBe(0)
  })
})

describe('cycle lock', () => {
  test('runs the function and returns its value', async () => {
    expect(await withCycleLock(async () => 7, 100)).toBe(7)
  })

  test('other errors surface', async () => {
    expect(
      withCycleLock(() => Promise.reject(new Error('boom')), 100),
    ).rejects.toThrow('boom')
  })
})

describe('starting sync', () => {
  test('on by default; OPENCODE_AUTH_LB_SYNC=0/false/no/off turns it off', () => {
    for (const off of ['0', 'false', ' OFF ', 'no'])
      expect(syncEnabled({ OPENCODE_AUTH_LB_SYNC: off })).toBe(false)
    for (const on of [undefined, '', '1', 'true'])
      expect(syncEnabled({ OPENCODE_AUTH_LB_SYNC: on })).toBe(true)
    expect(syncEnabled()).toBe(true)
  })

  test('startSync is null when off, and a stoppable loop when on', async () => {
    process.env.OPENCODE_AUTH_LB_SYNC = '0'
    expect(startSync()).toBeNull()
    delete process.env.OPENCODE_AUTH_LB_SYNC
    const loop = startSync()
    expect(loop).not.toBeNull()
    loop?.dispose()
    await Bun.sleep(30)
  })
})
