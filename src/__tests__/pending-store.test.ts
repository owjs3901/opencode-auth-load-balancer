import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, test } from 'bun:test'

import { acquirePendingLease, pendingLeasePath } from '../pending/lease'
import {
  listPendingForWorkspace,
  pendingKey,
  PendingReadError,
  readPending,
  removePending,
  removePendingSession,
  upsertPending,
} from '../pending/store'
import type { PendingRef } from '../pending/types'
import { LockTimeoutError } from '../pool/lock'
import { pendingFilePath } from '../pool/paths'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-pending-'))
const FILE = join(DIR, 'auth-load-balancer-pending.json')

const A: PendingRef = {
  workspace: 'C:\\work\\alpha',
  providerID: 'anthropic',
  sessionID: 'ses-a',
  messageID: 'msg-a',
}

const B: PendingRef = {
  workspace: 'C:\\work\\alpha',
  providerID: 'anthropic',
  sessionID: 'ses-b',
  messageID: 'msg-b',
}

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(FILE, { force: true })
  await rm(`${FILE}.lock`, { recursive: true, force: true })
})

describe('pending path and key', () => {
  test('uses the load-balancer data-dir override and a distinct file', () => {
    expect(pendingFilePath()).toBe(FILE)
  })

  test('the full reference tuple deterministically identifies one turn', () => {
    expect(pendingKey(A)).toBe(pendingKey({ ...A }))
    expect(pendingKey(A)).not.toBe(pendingKey({ ...A, providerID: 'openai' }))
    expect(pendingKey(A)).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('pending store', () => {
  test('missing, corrupt, and unknown-version files read as empty', async () => {
    expect(await readPending()).toEqual({ version: 1, turns: [] })
    await writeFile(FILE, 'not-json')
    expect(await readPending()).toEqual({ version: 1, turns: [] })
    await writeFile(FILE, JSON.stringify({ version: 2, turns: [] }))
    expect(await readPending()).toEqual({ version: 1, turns: [] })
  })

  test('drops malformed rows and reconstructs valid rows without extra payload fields', async () => {
    const valid = {
      ...A,
      key: pendingKey(A),
      createdAt: 100,
      updatedAt: 200,
      nextCheckAt: 300,
      resumeAt: null,
      prompt: 'must not survive',
      body: { secret: true },
      access: 'token',
    }
    await writeFile(
      FILE,
      JSON.stringify({
        version: 1,
        turns: [null, 'bad', { ...valid, messageID: 7 }, valid],
      }),
    )

    expect(await readPending()).toEqual({
      version: 1,
      turns: [
        {
          ...A,
          key: pendingKey(A),
          createdAt: 100,
          updatedAt: 200,
          nextCheckAt: 300,
          resumeAt: null,
        },
      ],
    })
  })

  test('deduplicates hand-edited rows by deterministic key, keeping the newest row', async () => {
    const older = {
      ...A,
      key: 'wrong',
      createdAt: 100,
      updatedAt: 200,
      nextCheckAt: 300,
      resumeAt: null,
    }
    const newer = {
      ...older,
      createdAt: 150,
      updatedAt: 250,
      nextCheckAt: 500,
      resumeAt: 500,
    }
    await writeFile(FILE, JSON.stringify({ version: 1, turns: [newer, older] }))

    expect((await readPending()).turns).toEqual([
      { ...newer, key: pendingKey(A), createdAt: 100 },
    ])
  })

  test('a real filesystem read failure is typed instead of becoming an empty store', async () => {
    await mkdir(FILE)
    try {
      await expect(readPending()).rejects.toBeInstanceOf(PendingReadError)
    } finally {
      await rm(FILE, { recursive: true, force: true })
    }
  })

  test('upsert is idempotent, preserves createdAt, and atomically updates scheduling', async () => {
    const first = await upsertPending(A, {
      now: 100,
      nextCheckAt: 200,
      resumeAt: null,
    })
    const second = await upsertPending(A, {
      now: 150,
      nextCheckAt: 500,
      resumeAt: 500,
    })

    expect(first.createdAt).toBe(100)
    expect(second).toMatchObject({
      key: pendingKey(A),
      createdAt: 100,
      updatedAt: 150,
      nextCheckAt: 500,
      resumeAt: 500,
    })
    expect((await readPending()).turns).toEqual([second])
    expect((await readFile(FILE, 'utf8')).includes('must not')).toBe(false)
  })

  test('concurrent mutations retain both independent turns', async () => {
    await Promise.all([
      upsertPending(A, { now: 100, nextCheckAt: 200, resumeAt: 200 }),
      upsertPending(B, { now: 100, nextCheckAt: 300, resumeAt: null }),
    ])

    expect(
      (await readPending()).turns.map((turn) => turn.messageID).sort(),
    ).toEqual(['msg-a', 'msg-b'])
  })

  test('filters exact workspaces and removes one turn or every turn in a session', async () => {
    const otherWorkspace = { ...B, workspace: 'C:\\work\\beta' }
    const sameSession = { ...B, sessionID: A.sessionID }
    await upsertPending(A, { now: 1, nextCheckAt: 2, resumeAt: null })
    await upsertPending(sameSession, {
      now: 1,
      nextCheckAt: 2,
      resumeAt: null,
    })
    await upsertPending(otherWorkspace, {
      now: 1,
      nextCheckAt: 2,
      resumeAt: null,
    })

    expect((await listPendingForWorkspace(A.workspace)).length).toBe(2)
    expect(await removePending(A)).toBe(true)
    expect(await removePending(A)).toBe(false)
    expect(await removePendingSession(A.workspace, A.sessionID)).toBe(1)
    expect((await readPending()).turns).toHaveLength(1)
  })
})

describe('per-turn pending lease', () => {
  test('the same turn is exclusive while different turns remain independent', async () => {
    const options = {
      staleMs: 30_000,
      timeoutMs: 20,
      retryMs: 2,
      heartbeatMs: 5_000,
    }
    const first = await acquirePendingLease(pendingKey(A), options)
    const other = await acquirePendingLease(pendingKey(B), options)
    expect(pendingLeasePath(pendingKey(A))).not.toBe(
      pendingLeasePath(pendingKey(B)),
    )
    await expect(
      acquirePendingLease(pendingKey(A), options),
    ).rejects.toBeInstanceOf(LockTimeoutError)

    await other.release()
    await first.release()
    const reacquired = await acquirePendingLease(pendingKey(A), options)
    await reacquired.release()
  })
})
