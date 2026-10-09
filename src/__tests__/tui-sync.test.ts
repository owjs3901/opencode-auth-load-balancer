import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  awaitSyncResult,
  type FsOps,
  isGistLinkShape,
  POOL_FILE,
  readShareLink,
  readSyncStatus,
  readSyncView,
  SYNC_INTENT_FILE,
  SYNC_STATE_FILE,
  SYNC_STATUS_FILE,
  syncLines,
  syncMenu,
  type SyncStatusView,
  writeSyncIntent,
} from '../../tui/auth-load-balancer-tui.logic'
import { syncIntentFilePath } from '../pool/paths'
import { encodeKey, generateKey } from '../sync/crypto'
import { parseGistLink } from '../sync/gist'
import { takeIntent } from '../sync/intent'

const ROOT = mkdtempSync(join(tmpdir(), 'auth-lb-tui-sync-'))
let seq = 0
const scratch = (name: string): string =>
  join(ROOT, `${name}-${(seq += 1)}.json`)
const ID = 'd'.repeat(32)
const KEY = encodeKey(generateKey())

describe('files', () => {
  test('sit beside the pool file, under the names the server uses', () => {
    const dir = POOL_FILE.slice(
      0,
      POOL_FILE.lastIndexOf(join('/', 'x')[0] ?? '/'),
    )
    expect(SYNC_STATE_FILE.startsWith(dir)).toBe(true)
    expect(SYNC_STATE_FILE.endsWith('auth-load-balancer-sync.json')).toBe(true)
    expect(
      SYNC_STATUS_FILE.endsWith('auth-load-balancer-sync-status.json'),
    ).toBe(true)
    expect(
      SYNC_INTENT_FILE.endsWith('auth-load-balancer-sync-intent.json'),
    ).toBe(true)
    expect(
      SYNC_INTENT_FILE.endsWith(
        syncIntentFilePath().split(/[\\/]/).at(-1) ?? '',
      ),
    ).toBe(true)
  })
})

describe('reading what the server wrote', () => {
  test('the view has the role and times, and never the key or gist', () => {
    const state = scratch('state')
    const status = scratch('status')
    writeFileSync(
      state,
      JSON.stringify({
        role: 'subscriber',
        syncedAt: 50,
        gistId: ID,
        key: KEY,
      }),
    )
    writeFileSync(
      status,
      JSON.stringify({ at: 60, ok: true, message: 'Up to date.', reqAt: 7 }),
    )
    const view = readSyncView(state, status)
    expect(view).toEqual({
      role: 'subscriber',
      syncedAt: 50,
      status: { at: 60, ok: true, message: 'Up to date.', reqAt: 7 },
    })
    expect(JSON.stringify(view)).not.toContain(KEY)
    expect(JSON.stringify(view)).not.toContain(ID)
  })

  test('missing, broken, or foreign files read as off', () => {
    expect(readSyncView(scratch('none'), scratch('none'))).toEqual({
      role: null,
    })
    const state = scratch('state')
    writeFileSync(state, '[]')
    expect(readSyncView(state, scratch('none'))).toEqual({ role: null })
    writeFileSync(state, 'broken')
    expect(readSyncView(state, scratch('none'))).toEqual({ role: null })
    writeFileSync(state, JSON.stringify({ role: 'admin', syncedAt: 1 }))
    expect(readSyncView(state, scratch('none'))).toEqual({ role: null })
    writeFileSync(state, JSON.stringify({ role: 'publisher', syncedAt: 'x' }))
    expect(readSyncView(state, scratch('none'))).toEqual({ role: 'publisher' })
  })

  test('a malformed outcome is ignored', () => {
    const status = scratch('status')
    for (const body of [
      { at: 'x', ok: true, message: 'm' },
      { at: 1, ok: 'y', message: 'm' },
      { at: 1, ok: true },
    ]) {
      writeFileSync(status, JSON.stringify(body))
      expect(readSyncStatus(status)).toBeUndefined()
    }
    writeFileSync(status, JSON.stringify({ at: 1, ok: false, message: 'm' }))
    expect(readSyncStatus(status)).toEqual({ at: 1, ok: false, message: 'm' })
  })

  test('the share link is built only for a publisher, only on request', () => {
    const state = scratch('state')
    writeFileSync(
      state,
      JSON.stringify({
        role: 'publisher',
        gistId: ID,
        key: KEY,
        owner: 'octo',
      }),
    )
    const link = readShareLink(state)
    expect(link).toBe(`https://gist.github.com/octo/${ID}#${KEY}`)
    expect(parseGistLink(link ?? '')?.id).toBe(ID)
    writeFileSync(
      state,
      JSON.stringify({ role: 'publisher', gistId: ID, key: KEY }),
    )
    expect(readShareLink(state)).toBe(`https://gist.github.com/${ID}#${KEY}`)
    writeFileSync(
      state,
      JSON.stringify({ role: 'subscriber', gistId: ID, key: KEY }),
    )
    expect(readShareLink(state)).toBeUndefined()
    writeFileSync(state, JSON.stringify({ role: 'publisher', gistId: ID }))
    expect(readShareLink(state)).toBeUndefined()
    expect(readShareLink(scratch('none'))).toBeUndefined()
  })
})

describe('link check', () => {
  test('agrees with the server on what a gist link with a key is', () => {
    const good = [
      `https://gist.github.com/octo/${ID}#${KEY}`,
      `  https://gist.github.com/${ID}#${KEY}  `,
    ]
    const bad = [
      '',
      `https://gist.github.com/octo/${ID}`,
      `http://gist.github.com/octo/${ID}#${KEY}`,
      `https://evil.example/octo/${ID}#${KEY}`,
      `https://gist.github.com/octo/${ID}#short`,
      `https://gist.github.com/a/b/${ID}#${KEY}`,
    ]
    for (const link of good) {
      expect(isGistLinkShape(link)).toBe(true)
      expect(parseGistLink(link)).not.toBeNull()
    }
    for (const link of bad) {
      expect(isGistLinkShape(link)).toBe(false)
      expect(parseGistLink(link)).toBeNull()
    }
  })
})

describe('asking the server', () => {
  test('a request the server can claim, with owner-only mode and no temp file left', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-lb-tui-intent-'))
    const previous = process.env.OPENCODE_AUTH_LB_DIR
    process.env.OPENCODE_AUTH_LB_DIR = dir
    try {
      const path = syncIntentFilePath()
      const link = `https://gist.github.com/octo/${ID}#${KEY}`
      expect(writeSyncIntent('subscribe', `  ${link} `, 1_000, path)).toBe(
        1_000,
      )
      expect(await takeIntent(1_500)).toEqual({
        action: 'subscribe',
        at: 1_000,
        link,
      })
      expect(readFileSyncOrNull(path)).toBeNull()
      writeSyncIntent('sync', undefined, 2_000, path)
      expect(await takeIntent(2_100)).toEqual({ action: 'sync', at: 2_000 })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
      else process.env.OPENCODE_AUTH_LB_DIR = previous
    }
  })

  test('a failed write leaves no temp file and does not throw', () => {
    const removed: string[] = []
    const ops: FsOps = {
      readFileSync,
      writeFileSync: () => {
        throw new Error('disk full')
      },
      renameSync: () => undefined,
      unlinkSync: (path) => {
        removed.push(path)
      },
    }
    expect(writeSyncIntent('forget', undefined, 5, scratch('i'), ops)).toBe(5)
    expect(removed).toHaveLength(1)
    const stuck: FsOps = {
      ...ops,
      writeFileSync: () => undefined,
      renameSync: () => {
        throw new Error('busy')
      },
      unlinkSync: () => {
        throw new Error('gone')
      },
    }
    expect(writeSyncIntent('forget', undefined, 6, scratch('i'), stuck)).toBe(6)
  })

  test('waits for the answer to its own request, and gives up after the timeout', async () => {
    const answers: (SyncStatusView | undefined)[] = [
      undefined,
      { at: 1, ok: true, message: 'old', reqAt: 4 },
      { at: 2, ok: true, message: 'mine', reqAt: 5 },
    ]
    let slept = 0
    const got = await awaitSyncResult(
      5,
      () => answers.shift(),
      async () => {
        slept += 1
      },
    )
    expect(got?.message).toBe('mine')
    expect(slept).toBe(2)
    expect(
      await awaitSyncResult(
        5,
        () => undefined,
        async () => undefined,
        1_000,
        500,
      ),
    ).toBeNull()
  })

  test('the default status reader and sleeper are the real ones', async () => {
    expect(await awaitSyncResult(1, undefined, undefined, 0, 1)).toBeNull()
  })
})

describe('display', () => {
  const NOW = 10_000_000
  test('off, publishing, following', () => {
    expect(syncLines({ role: null }, NOW)).toEqual(['off'])
    expect(syncLines({ role: 'publisher' }, NOW)).toEqual(['publishing'])
    expect(
      syncLines({ role: 'publisher', syncedAt: NOW - 5_000 }, NOW),
    ).toEqual(['publishing · synced just now'])
    expect(
      syncLines({ role: 'subscriber', syncedAt: NOW - 3 * 60_000 }, NOW),
    ).toEqual(['following a gist · synced 3m ago'])
  })

  test('the latest outcome is shown, with a marker when it failed', () => {
    const ok = { at: 1, ok: true, message: 'Up to date.' }
    const bad = { at: 1, ok: false, message: 'The gist no longer exists.' }
    expect(syncLines({ role: 'subscriber', status: ok }, NOW).at(-1)).toBe(
      'Up to date.',
    )
    expect(syncLines({ role: 'subscriber', status: bad }, NOW).at(-1)).toBe(
      '! The gist no longer exists.',
    )
    expect(syncLines({ role: null, status: bad }, NOW)).toEqual([
      'off',
      '! The gist no longer exists.',
    ])
  })

  test('the menu depends on the role', () => {
    const ids = (role: 'publisher' | 'subscriber' | null) =>
      syncMenu({ role }).map((item) => item.id)
    expect(ids(null)).toEqual(['subscribe', 'upload-new'])
    expect(ids('publisher')).toEqual([
      'show-link',
      'upload',
      'upload-new',
      'forget',
    ])
    expect(ids('subscriber')).toEqual(['sync', 'subscribe', 'forget'])
    for (const role of [null, 'publisher', 'subscriber'] as const)
      for (const item of syncMenu({ role }))
        expect(item.title.length).toBeGreaterThan(5)
  })
})

function readFileSyncOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
