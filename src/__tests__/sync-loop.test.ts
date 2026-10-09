import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { acquireLock } from '../pool/lock'
import { syncIntentFilePath, syncStateFilePath } from '../pool/paths'
import { encodeKey, generateKey } from '../sync/crypto'
import type { Outcome, SyncEngine } from '../sync/engine'
import type { SyncIntent } from '../sync/intent'
import {
  CHANGE_CHECK_MS,
  createSyncLoop,
  DEBOUNCE_MS,
  type IntentSource,
  type LoopTimers,
  POLL_MS,
  realTimers,
  withCycleLock,
} from '../sync/loop'
import { startSync, syncEnabled } from '../sync/start'
import {
  newRefs,
  type SyncRole,
  type SyncState,
  updateSyncState,
} from '../sync/state'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-sync-loop-'))
const ID = 'c'.repeat(32)
const OK: Outcome = { ok: true, message: 'ok' }
const cycleLock = () => `${syncStateFilePath()}.cycle.lock`

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(syncStateFilePath(), { force: true })
  await rm(syncIntentFilePath(), { force: true })
  await rm(cycleLock(), { recursive: true, force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
  delete process.env.OPENCODE_AUTH_LB_SYNC
})

const setRole = (role: SyncRole | null, retryAt?: number) =>
  updateSyncState(() =>
    role
      ? ({
          v: 1,
          role,
          gistId: ID,
          key: encodeKey(generateKey()),
          imported: newRefs(),
          ...(retryAt === undefined ? {} : { retryAt }),
        } satisfies SyncState)
      : null,
  )

/** An engine that records its calls and answers from `script`. */
function scriptedEngine() {
  const calls: string[] = []
  const script: {
    background: Outcome | null
    digest: string | null
    hold: Promise<unknown>
    lockSeen: boolean[]
  } = { background: OK, digest: null, hold: Promise.resolve(), lockSeen: [] }
  const engine: SyncEngine = {
    poll: async () => OK,
    upload: async (fresh, reqAt) => {
      calls.push(`upload:${fresh}:${reqAt}`)
      return OK
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
    backgroundPoll: async (gistId) => {
      calls.push(`bg-poll:${gistId}`)
      await script.hold
      return script.background
    },
    backgroundPublish: async (gistId, digest) => {
      calls.push(`bg-publish:${gistId}:${digest}`)
      return script.background
    },
  }
  return { engine, calls, script }
}

function harness(
  intents?: IntentSource,
  extra: { disposeWaitMs?: number } = {},
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
    lockWaitMs: 60,
    ...(intents ? { intents } : {}),
    ...extra,
  })
  return { clock, timers, loop, ...scripted }
}

const noRequests: IntentSource = {
  pending: async () => false,
  take: async () => null,
}

/** Wait (bounded) until ok(): a fixed sleep would only guess how long a loaded machine needs. */
async function until(ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!ok()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(5)
  }
}

const holdLock = () =>
  acquireLock(cycleLock(), {
    staleMs: 60_000,
    timeoutMs: 1_000,
    retryMs: 5,
    heartbeatMs: 5_000,
  })

describe('subscriber schedule', () => {
  test('downloads when the persisted schedule says it is due, checking no more often than every 5 seconds', async () => {
    await setRole('subscriber')
    const { loop, clock, calls } = harness(noRequests)
    await loop.tick()
    expect(calls).toEqual([`bg-poll:${ID}`])
    await loop.tick()
    expect(calls).toHaveLength(1)
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toHaveLength(2)
  })

  test('nothing runs before the persisted retry time, and the first check after it runs', async () => {
    const { loop, clock, calls } = harness(noRequests)
    await setRole('subscriber', clock.now + POLL_MS)
    await loop.tick()
    clock.now += POLL_MS - 1
    await loop.tick()
    expect(calls).toEqual([])
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([`bg-poll:${ID}`])
  })

  test('nothing runs without a role', async () => {
    const { loop, clock, calls } = harness(noRequests)
    await loop.tick()
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([])
  })

  test('a download whose lock another window holds is simply tried again', async () => {
    await setRole('subscriber')
    const { loop, clock, calls } = harness(noRequests)
    const held = await holdLock()
    try {
      await loop.tick()
      expect(calls).toEqual([])
    } finally {
      await held.release()
    }
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([`bg-poll:${ID}`])
  })
})

describe('publisher schedule', () => {
  test('uploads once the credentials have stopped changing for the debounce window, naming the gist and digest it saw', async () => {
    await setRole('publisher')
    const { loop, clock, calls, script } = harness(noRequests)
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
    expect(calls).toEqual([`bg-publish:${ID}:d2`])
    script.digest = null
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    clock.now += DEBOUNCE_MS
    await loop.tick()
    expect(calls).toHaveLength(1)
  })

  test('nothing is uploaded before the persisted retry time', async () => {
    const { loop, clock, calls, script } = harness(noRequests)
    await setRole('publisher', clock.now + 3 * DEBOUNCE_MS)
    script.digest = 'd1'
    for (let i = 0; i < 4; i++) {
      await loop.tick()
      clock.now += CHANGE_CHECK_MS
    }
    expect(calls).toEqual([])
    clock.now += 3 * DEBOUNCE_MS
    await loop.tick()
    clock.now += DEBOUNCE_MS
    await loop.tick()
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([`bg-publish:${ID}:d1`])
  })

  test('an upload that did not run (lock busy, or decided against under it) is retried while the credentials are still unpublished', async () => {
    await setRole('publisher')
    const { loop, clock, calls, script } = harness(noRequests)
    script.digest = 'd1'
    script.background = null
    await loop.tick()
    clock.now += DEBOUNCE_MS
    await loop.tick()
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([`bg-publish:${ID}:d1`, `bg-publish:${ID}:d1`])
    script.background = OK
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toHaveLength(3)
  })
})

describe('TUI requests', () => {
  const asked = (action: SyncIntent['action'], link?: string): SyncIntent => ({
    action,
    at: 42,
    ...(link ? { link } : {}),
  })
  const once = (intent: SyncIntent | null): IntentSource => {
    let next = intent
    return {
      pending: async () => next !== null,
      take: async () => {
        const got = next
        next = null
        return got
      },
    }
  }

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
      const { loop, calls } = harness(once(asked(action, link)))
      await loop.tick()
      expect(calls).toEqual([call])
    },
  )

  test('the request is claimed only once the machine-wide lock is held', async () => {
    const seen: boolean[] = []
    const { loop, calls } = harness({
      pending: async () => true,
      take: async () => {
        seen.push(existsSync(cycleLock()))
        return asked('upload')
      },
    })
    await loop.tick()
    expect(seen).toEqual([true])
    expect(calls).toEqual(['upload:false:42'])
  })

  test('a request whose lock is busy stays on disk, unread, and runs once the lock frees', async () => {
    const link = `https://gist.github.com/${ID}#${encodeKey(generateKey())}`
    await writeFile(
      syncIntentFilePath(),
      JSON.stringify({ action: 'subscribe', at: Date.now(), link }),
    )
    const { engine, calls } = scriptedEngine()
    const real = createSyncLoop({ engine, now: Date.now, lockWaitMs: 60 })
    const held = await holdLock()
    try {
      await real.tick()
      await real.tick()
      expect(calls).toEqual([])
      expect(existsSync(syncIntentFilePath())).toBe(true)
    } finally {
      await held.release()
    }
    await real.tick()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toStartWith('subscribe:https://gist.github.com/')
    expect(existsSync(syncIntentFilePath())).toBe(false)
  })

  test('a lock left behind by a process that died is reclaimed within 20 seconds, a live-looking one is not', async () => {
    await writeFile(
      syncIntentFilePath(),
      JSON.stringify({ action: 'sync', at: Date.now() }),
    )
    const { engine, calls } = scriptedEngine()
    const real = createSyncLoop({ engine, now: Date.now, lockWaitMs: 400 })
    await mkdir(cycleLock(), { recursive: true })
    const ago = (ms: number) => new Date(Date.now() - ms)
    await utimes(cycleLock(), ago(15_000), ago(15_000))
    await real.tick()
    expect(calls).toEqual([])
    expect(existsSync(syncIntentFilePath())).toBe(true)

    await utimes(cycleLock(), ago(25_000), ago(25_000))
    await real.tick()
    expect(calls).toHaveLength(1)
    expect(existsSync(syncIntentFilePath())).toBe(false)
  })
})

describe('lifecycle', () => {
  test('start schedules a one-second tick and runs one at once; dispose clears it and stops ticking', async () => {
    await setRole('subscriber')
    const { loop, timers, calls } = harness(noRequests)
    loop.start()
    expect(timers.started.map((t) => t.ms)).toEqual([1_000])
    await until(() => calls.length === 1)
    expect(calls).toEqual([`bg-poll:${ID}`])
    await loop.dispose()
    expect(timers.cleared).toEqual(['handle'])
    await loop.tick()
    timers.started[0]?.run()
    expect(calls).toHaveLength(1)
  })

  test('the scheduled tick runs the loop', async () => {
    let asks = 0
    const { loop, timers } = harness({
      pending: async () => {
        asks += 1
        return false
      },
      take: async () => null,
    })
    loop.start()
    await until(() => asks === 1)
    await Bun.sleep(5)
    timers.started[0]?.run()
    await until(() => asks === 2)
    expect(asks).toBe(2)
    await loop.dispose()
  })

  test('runs never overlap', async () => {
    await setRole('subscriber')
    const { loop, calls, script, clock } = harness(noRequests)
    let release: () => void = () => undefined
    script.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = loop.tick()
    await until(() => calls.length === 1)
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([`bg-poll:${ID}`])
    release()
    await first
  })

  test('dispose waits for the step in flight, so its lock is released with it', async () => {
    await setRole('subscriber')
    const { loop, script } = harness(noRequests)
    let release: () => void = () => undefined
    script.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    void loop.tick()
    await until(() => existsSync(cycleLock()))
    expect(existsSync(cycleLock())).toBe(true)

    let disposed = false
    const done = loop.dispose().then(() => {
      disposed = true
    })
    await Bun.sleep(60)
    expect(disposed).toBe(false)
    release()
    await done
    expect(disposed).toBe(true)
    expect(existsSync(cycleLock())).toBe(false)
  })

  test('dispose does not wait forever for a step that never ends', async () => {
    await setRole('subscriber')
    const { loop, script } = harness(noRequests, { disposeWaitMs: 50 })
    script.hold = new Promise<void>(() => undefined)
    void loop.tick()
    await until(() => existsSync(cycleLock()))
    const started = Date.now()
    await loop.dispose()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('a failing step is swallowed and the next one still runs', async () => {
    await setRole('subscriber')
    let fail = true
    const { loop, clock, calls } = harness({
      pending: async () => {
        if (fail) throw new Error('disk')
        return false
      },
      take: async () => null,
    })
    await loop.tick()
    fail = false
    clock.now += CHANGE_CHECK_MS
    await loop.tick()
    expect(calls).toEqual([`bg-poll:${ID}`])
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
    await loop?.dispose()
  })
})
