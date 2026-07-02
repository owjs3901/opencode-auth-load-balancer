import { mkdtempSync } from 'node:fs'
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { acquireLock, LockTimeoutError, withLock } from '../pool/lock'
import { sleep } from '../util'

const ROOT = mkdtempSync(join(tmpdir(), 'auth-lb-lock-'))

let seq = 0
function lockPath(name: string): string {
  seq += 1
  return join(ROOT, `${name}-${seq}.lock`)
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const FAST = {
  staleMs: 30_000,
  timeoutMs: 1_000,
  retryMs: 10,
  heartbeatMs: 5_000,
}

describe('file lock', () => {
  test('withLock runs fn while holding the lock, then releases', async () => {
    const dir = lockPath('basic')
    let ran = false
    const result = await withLock(dir, FAST, async () => {
      ran = true
      expect(await dirExists(dir)).toBe(true) // held during fn
      return 42
    })
    expect(ran).toBe(true)
    expect(result).toBe(42)
    expect(await dirExists(dir)).toBe(false) // released after
  })

  test('withLock releases the lock even when fn throws', async () => {
    const dir = lockPath('throws')
    await expect(
      withLock(dir, FAST, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await dirExists(dir)).toBe(false)
  })

  test('a held lock blocks a second acquirer until it times out (heartbeat keeps it fresh)', async () => {
    const dir = lockPath('contended')
    const held = await acquireLock(dir, {
      staleMs: 50,
      timeoutMs: 1_000,
      retryMs: 10,
      heartbeatMs: 10,
    })
    // The heartbeat keeps `held` from ever looking stale, so the second acquirer
    // polls until its own short timeout fires rather than reclaiming the lock.
    await expect(
      acquireLock(dir, {
        staleMs: 50,
        timeoutMs: 80,
        retryMs: 10,
        heartbeatMs: 10,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError)
    await held.release()
    expect(await dirExists(dir)).toBe(false)
  })

  test('reclaims a stale lock whose holder never released', async () => {
    const dir = lockPath('stale')
    await mkdir(dir, { recursive: true })
    const meta = join(dir, 'owner.json')
    await writeFile(
      meta,
      JSON.stringify({ ownerId: 'ghost', pid: 1, host: 'x', acquiredAt: 0 }),
    )
    const old = new Date(Date.now() - 10_000)
    await utimes(meta, old, old)
    const handle = await acquireLock(dir, {
      staleMs: 1_000,
      timeoutMs: 2_000,
      retryMs: 10,
      heartbeatMs: 5_000,
    })
    await handle.release()
    expect(await dirExists(dir)).toBe(false)
  })

  test('releasing a lock reclaimed by a new owner leaves the new owner intact', async () => {
    const dir = lockPath('mismatch')
    const noHeartbeat = {
      staleMs: 5,
      timeoutMs: 1_000,
      retryMs: 5,
      heartbeatMs: 100_000,
    }
    const first = await acquireLock(dir, noHeartbeat)
    await sleep(30) // first goes stale (heartbeat never fires)
    const second = await acquireLock(dir, noHeartbeat) // reclaims + takes it
    await first.release() // must NOT delete second's lock
    expect(await dirExists(dir)).toBe(true)
    await second.release()
    expect(await dirExists(dir)).toBe(false)
  })

  test('double release is a no-op', async () => {
    const dir = lockPath('double')
    const handle = await acquireLock(dir, FAST)
    await handle.release()
    await handle.release() // second call short-circuits on the `released` flag
    expect(await dirExists(dir)).toBe(false)
  })

  test('times out against a lock dir with no owner metadata', async () => {
    const dir = lockPath('no-owner')
    await mkdir(dir, { recursive: true }) // dir exists, but owner.json never written
    await expect(
      acquireLock(dir, {
        staleMs: 10_000,
        timeoutMs: 60,
        retryMs: 10,
        heartbeatMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError)
  })

  test('stale-reclaim branch respects the acquisition deadline (no unbounded spin past timeoutMs)', async () => {
    // Regression lock for src/pool/lock.ts acquireLock. Pre-fix the stale
    // branch ended in an unconditional `continue` that skipped BOTH the
    // deadline check and the jittered sleep — so when the reclaim `rm`
    // persistently failed (its error is swallowed by `.catch(ignore)`, e.g.
    // Windows EACCES/EBUSY from an AV tool holding the stale dir), the loop
    // hot-spun forever and LockTimeoutError was never thrown. Post-fix the
    // branch re-checks the deadline after the `rm`. With an already-expired
    // deadline (timeoutMs: 0) and a stale lock present, pre-fix code
    // acquired the lock on the next spin; post-fix it throws.
    const dir = lockPath('stale-deadline')
    await mkdir(dir, { recursive: true })
    const meta = join(dir, 'owner.json')
    await writeFile(
      meta,
      JSON.stringify({ ownerId: 'ghost', pid: 1, host: 'x', acquiredAt: 0 }),
    )
    const old = new Date(Date.now() - 10_000)
    await utimes(meta, old, old)
    await expect(
      acquireLock(dir, {
        staleMs: 1_000,
        timeoutMs: 0, // deadline already passed when the stale branch runs
        retryMs: 10,
        heartbeatMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(LockTimeoutError)
  })

  test('release does NOT rm the lockDir when the owner meta is missing (race vs a concurrent reclaim mid-tryClaim)', async () => {
    // Regression lock for src/pool/lock.ts makeHandle.release. Pre-fix the
    // guard `if (current && current.meta.ownerId !== ownerId) return` treated
    // `current === null` (readMeta failed: ENOENT / mid-write) as "we still
    // own it, safe to rm" — and fired during the tiny window between a
    // stale-reclaim's `rm + mkdir` and its `writeFile(meta)`, wiping the NEW
    // owner's freshly-mkdir'd lockDir. The new owner's pending `writeFile`
    // then threw ENOENT, which propagates uncaught through acquireLock and
    // fails the caller's pool mutation / OAuth refresh — exactly the
    // cross-process critical section the `tokenGen` race tests in
    // stateful.test.ts rely on. Post-fix `if (!current || …)` keeps the
    // lockDir intact when ownership cannot be confirmed.
    const dir = lockPath('release-null-meta')
    const handle = await acquireLock(dir, FAST)
    // Simulate the race by removing our meta file (the exact disk state a
    // concurrent reclaim mid-tryClaim produces between its rm+mkdir and its
    // writeFile(meta)). We do NOT pre-fill any new meta — the point is
    // precisely that readMeta returns null here.
    await rm(join(dir, 'owner.json'))
    await handle.release()
    expect(await dirExists(dir)).toBe(true)
  })
})
