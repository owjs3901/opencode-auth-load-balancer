import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { acquireLock } from '../pool/lock'
import {
  syncIntentFilePath,
  syncStateFilePath,
  syncStatusFilePath,
} from '../pool/paths'
import { encodeKey, generateKey } from '../sync/crypto'
import {
  INTENT_SKEW_MS,
  INTENT_TTL_MS,
  intentPending,
  takeIntent,
} from '../sync/intent'
import {
  newRefs,
  readSyncState,
  type SyncState,
  updateSyncState,
  writeSyncStatus,
} from '../sync/state'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-sync-state-'))
const ID = 'b'.repeat(32)

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  for (const path of [
    syncStateFilePath(),
    syncIntentFilePath(),
    syncStatusFilePath(),
  ])
    await rm(path, { force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
})

const state = (over: Partial<SyncState> = {}): SyncState => ({
  v: 1,
  gistId: ID,
  key: encodeKey(generateKey()),
  creator: false,
  imported: {},
  skipped: {},
  ...over,
})

describe('sync state file', () => {
  test('lives beside the pool and round trips', async () => {
    expect(syncStateFilePath()).toBe(join(DIR, 'auth-load-balancer-sync.json'))
    expect(syncIntentFilePath()).toBe(
      join(DIR, 'auth-load-balancer-sync-intent.json'),
    )
    expect(await readSyncState()).toBeNull()
    const full = state({
      creator: true,
      owner: 'octo',
      write: 'denied',
      writeCheckAt: 11,
      pollAt: 12,
      etag: 'W/"1"',
      syncedAt: 5,
      uploadedDigest: 'abc',
      uploadedAt: 9,
      appliedAt: 8,
      retryAt: 7,
      imported: { e: { accountId: 'a', fingerprint: 'f' } },
      skipped: { s: { fingerprint: 'f', blocker: 'b', holds: '' } },
    })
    expect(await updateSyncState(() => full)).toEqual(full)
    expect(await readSyncState()).toEqual(full)
  })

  test('the update sees the current state, and null forgets it', async () => {
    await updateSyncState(() => state({ syncedAt: 1 }))
    const seen: (number | undefined)[] = []
    await updateSyncState((cur) => {
      seen.push(cur?.syncedAt)
      return cur && { ...cur, syncedAt: 2 }
    })
    expect(seen).toEqual([1])
    expect((await readSyncState())?.syncedAt).toBe(2)
    expect(await updateSyncState(() => null)).toBeNull()
    expect(await readSyncState()).toBeNull()
    expect(await updateSyncState(() => null)).toBeNull()
  })

  test('a corrupt or foreign file reads as no state', async () => {
    const path = syncStateFilePath()
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ ...state(), v: 2 }),
      JSON.stringify({ ...state(), gistId: 'zz' }),
      JSON.stringify({ ...state(), gistId: 5 }),
      JSON.stringify({ ...state(), key: 'short' }),
      JSON.stringify({ ...state(), key: 5 }),
    ]
    for (const text of bad) {
      await writeFile(path, text)
      expect(await readSyncState()).toBeNull()
    }
  })

  test('unknown or malformed fields are dropped on read', async () => {
    await writeFile(
      syncStateFilePath(),
      JSON.stringify({
        ...state(),
        extra: 'x',
        owner: 5,
        etag: 5,
        syncedAt: 'now',
        uploadedDigest: 5,
        uploadedAt: 'x',
        appliedAt: 'x',
        retryAt: 'x',
        pollAt: 'x',
        writeCheckAt: 'x',
        write: 'sometimes',
        creator: 'yes',
        skipped: { bad: { blocker: 5 }, worse: 'x' },
        imported: {
          good: { accountId: 'a', fingerprint: 'f' },
          bad: { accountId: 5 },
          worse: 'x',
        },
      }),
    )
    const read = await readSyncState()
    expect(read?.imported).toEqual({
      good: { accountId: 'a', fingerprint: 'f' },
    })
    for (const field of [
      'extra',
      'owner',
      'etag',
      'syncedAt',
      'uploadedDigest',
      'uploadedAt',
      'appliedAt',
      'retryAt',
      'pollAt',
      'writeCheckAt',
      'write',
    ])
      expect(read).not.toHaveProperty(field)
    expect(read?.creator).toBe(false)
    expect(read?.skipped).toEqual({})
    await writeFile(
      syncStateFilePath(),
      JSON.stringify({ ...state(), imported: 3 }),
    )
    expect((await readSyncState())?.imported).toEqual({})
  })

  test('the outcome file is separate and never needs the state', async () => {
    await writeSyncStatus({
      at: 1,
      ok: false,
      message: 'GitHub could not be reached.',
      reqAt: 9,
    })
    expect(JSON.parse(await readFile(syncStatusFilePath(), 'utf8'))).toEqual({
      at: 1,
      ok: false,
      message: 'GitHub could not be reached.',
      reqAt: 9,
    })
    expect(await readSyncState()).toBeNull()
  })

  test('an outcome that cannot be written is a lost message, not a failure', async () => {
    const blocker = join(DIR, 'a-file')
    await writeFile(blocker, 'x')
    process.env.OPENCODE_AUTH_LB_DIR = join(blocker, 'dir')
    await writeSyncStatus({ at: 1, ok: true, message: 'm' })
  })
})

describe('imported references', () => {
  test('ids such as __proto__ are ordinary keys that survive a write and a read', async () => {
    const refs = newRefs()
    for (const id of ['__proto__', 'constructor', 'prototype'])
      refs[id] = { accountId: `row-${id}`, fingerprint: 'f' }
    await updateSyncState(() => state({ imported: refs }))
    const file = await readFile(syncStateFilePath(), 'utf8')
    expect(file).toContain('"__proto__":{"accountId":"row-__proto__"')
    const read = (await readSyncState())?.imported ?? newRefs()
    expect(Object.keys(read).sort()).toEqual([
      '__proto__',
      'constructor',
      'prototype',
    ])
    expect(Object.getPrototypeOf(read)).toBeNull()
    expect(read['__proto__']?.accountId).toBe('row-__proto__')
    expect(Object.hasOwn(newRefs(), 'toString')).toBe(false)
    expect(newRefs()['toString']).toBeUndefined()
  })

  test('a copy keeps every key and shares nothing', () => {
    const refs = newRefs()
    refs['__proto__'] = { accountId: 'a', fingerprint: 'f' }
    const copy = newRefs(refs)
    delete copy['__proto__']
    expect(Object.keys(refs)).toEqual(['__proto__'])
    expect(Object.keys(copy)).toEqual([])
  })
})

describe('TUI request handshake', () => {
  const write = (body: unknown) =>
    writeFile(
      syncIntentFilePath(),
      typeof body === 'string' ? body : JSON.stringify(body),
    )

  test('nothing pending is null', async () => {
    expect(await takeIntent(10)).toBeNull()
  })

  test('a request is claimed once and its file is gone afterwards', async () => {
    const link = `https://gist.github.com/${ID}#${encodeKey(generateKey())}`
    await write({ action: 'subscribe', at: 100, link })
    const [a, b] = await Promise.all([takeIntent(150), takeIntent(150)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect((a ?? b)?.link).toBe(link)
    expect(await takeIntent(150)).toBeNull()
    expect(await Bun.file(syncIntentFilePath()).exists()).toBe(false)
  })

  test('a claim that cannot get the lock leaves the request for the next tick', async () => {
    await write({ action: 'sync', at: 100 })
    const held = await acquireLock(`${syncIntentFilePath()}.lock`, {
      staleMs: 60_000,
      timeoutMs: 1_000,
      retryMs: 5,
      heartbeatMs: 5_000,
    })
    try {
      expect(await takeIntent(150, 60)).toBeNull()
      expect(await Bun.file(syncIntentFilePath()).exists()).toBe(true)
    } finally {
      await held.release()
    }
    expect(await takeIntent(150)).toEqual({ action: 'sync', at: 100 })
  })

  test('a newer request the TUI writes while the old one is being read is left alone, not deleted', async () => {
    await write({ action: 'sync', at: 100 })
    const taken = await takeIntent(150, undefined, () =>
      write({ action: 'upload', at: 120 }),
    )
    expect(taken).toEqual({ action: 'sync', at: 100 })
    expect(await intentPending()).toBe(true)
    expect(await takeIntent(150)).toEqual({ action: 'upload', at: 120 })
    expect(await intentPending()).toBe(false)
  })
  test('a request taken by someone else while we wait for the lock is simply gone', async () => {
    await write({ action: 'sync', at: 100 })
    const held = await acquireLock(`${syncIntentFilePath()}.lock`, {
      staleMs: 60_000,
      timeoutMs: 1_000,
      retryMs: 5,
      heartbeatMs: 5_000,
    })
    const waiting = takeIntent(150, 2_000)
    await rm(syncIntentFilePath(), { force: true })
    await held.release()
    expect(await waiting).toBeNull()
  })
  test('pending reports a waiting request without claiming it', async () => {
    expect(await intentPending()).toBe(false)
    await write({ action: 'sync', at: 100 })
    expect(await intentPending()).toBe(true)
    expect(await intentPending()).toBe(true)
  })

  test('a request stamped in the far future is refused (it would outlive the TTL)', async () => {
    await write({ action: 'sync', at: 100 + INTENT_SKEW_MS + 1 })
    expect(await takeIntent(100)).toBeNull()
    await write({ action: 'sync', at: 100 + INTENT_SKEW_MS })
    expect(await takeIntent(100)).toEqual({
      action: 'sync',
      at: 100 + INTENT_SKEW_MS,
    })
  })

  test('every action parses; the link is only kept when it is a short string', async () => {
    for (const action of [
      'upload',
      'upload-new',
      'subscribe',
      'sync',
      'forget',
    ] as const) {
      await write({ action, at: 5 })
      expect(await takeIntent(6)).toEqual({ action, at: 5 })
    }
    await write({ action: 'sync', at: 5, link: 'x'.repeat(2049) })
    expect(await takeIntent(6)).toEqual({ action: 'sync', at: 5 })
    await write({ action: 'sync', at: 5, link: 7 })
    expect(await takeIntent(6)).toEqual({ action: 'sync', at: 5 })
  })

  test('stale, unknown, or malformed requests do nothing — and are still consumed', async () => {
    const cases: unknown[] = [
      { action: 'sync', at: 0 },
      { action: 'rm -rf', at: 5 },
      { action: 'sync', at: 'now' },
      { action: 'sync' },
      [],
      'not json',
    ]
    for (const body of cases) {
      await write(body)
      expect(await takeIntent(INTENT_TTL_MS + 1)).toBeNull()
      expect(await Bun.file(syncIntentFilePath()).exists()).toBe(false)
    }
  })
})
