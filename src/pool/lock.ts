import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { ignore, sleep } from '../util'

/**
 * Cross-process advisory file lock.
 *
 * The in-process promise-chain mutex in `store.ts` only serializes mutations
 * within ONE opencode process. Two opencode instances (two TUI windows, a server
 * + a TUI, two project dirs) share the single pool file and can therefore race a
 * read-modify-write — or, worse, both spend the same single-use OAuth refresh
 * token and brick an account. This lock serializes those critical sections across
 * processes using an atomic `mkdir` (which fails if the directory already exists
 * on every OS) as the mutual-exclusion primitive.
 *
 * It is advisory and best-effort: a crashed holder is reclaimed after `staleMs`
 * with no heartbeat. The lock SHRINKS the race window; the `tokenGen` generation
 * guard in `refresh.ts` is the data-level backstop that keeps the residual window
 * safe (a superseded refresher adopts the winner's token instead of disabling).
 */

/** Tunable lock timing. All values in ms. */
export interface LockOptions {
  /** A held lock whose heartbeat has not advanced for this long is treated as crashed. */
  readonly staleMs: number
  /** Give up acquiring after this long, throwing LockTimeoutError. */
  readonly timeoutMs: number
  /** Base poll interval between acquisition attempts (jittered up to 2x). */
  readonly retryMs: number
  /** Re-touch the held lock this often so a live holder never looks stale. */
  readonly heartbeatMs: number
}

export interface LockHandle {
  release(): Promise<void>
}

interface LockMeta {
  readonly ownerId: string
  readonly pid: number
  readonly host: string
  readonly acquiredAt: number
}

export class LockTimeoutError extends Error {
  constructor(readonly lockDir: string) {
    super(`Timed out acquiring lock: ${lockDir}`)
    this.name = 'LockTimeoutError'
  }
}

function metaFile(lockDir: string): string {
  return join(lockDir, 'owner.json')
}

async function readMeta(
  lockDir: string,
): Promise<{ meta: LockMeta; mtimeMs: number } | null> {
  try {
    const path = metaFile(lockDir)
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { meta: JSON.parse(text) as LockMeta, mtimeMs: info.mtimeMs }
  } catch {
    // Missing or mid-write: caller treats this as "freshly held, not stale".
    return null
  }
}

/** Atomically claim the lock dir, writing owner metadata. Returns false if held. */
async function tryClaim(lockDir: string, meta: LockMeta): Promise<boolean> {
  try {
    await mkdir(lockDir, { recursive: false })
  } catch {
    return false
  }
  // If meta write fails after mkdir succeeded (disk full, EACCES, EROFS, or a
  // Windows AV/backup tool holding the dir handle), the propagating error would
  // otherwise leave a dir-with-no-owner-meta behind. With no meta file every
  // future acquirer reads null from readMeta(), declines to reclaim (the stale
  // gate in acquireLock requires non-null meta), and spins until timeoutMs hits
  // — bricking the pool/refresh paths until manual cleanup. Cleaning up
  // symmetrically with writeJsonAtomic's tmp-file unlink keeps the failure
  // path reclaimable.
  try {
    await writeFile(metaFile(lockDir), JSON.stringify(meta), { mode: 0o600 })
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true }).catch(ignore)
    throw error
  }
  return true
}

function startHeartbeat(
  lockDir: string,
  meta: LockMeta,
  heartbeatMs: number,
): () => void {
  // `meta` is `readonly` for the lifetime of the lock, so the serialized payload
  // is fixed. Stringify ONCE up front rather than re-running `JSON.stringify` on
  // every tick — and mirrors the sibling `tryClaim` site, which already
  // stringifies once outside any loop. Intent ("write a fixed payload to refresh
  // mtime") becomes explicit at the call site instead of hiding inside a
  // per-tick stringification.
  const payload = JSON.stringify(meta)
  const timer = setInterval(() => {
    void writeFile(metaFile(lockDir), payload, { mode: 0o600 }).catch(ignore)
  }, heartbeatMs)
  // A heartbeat must never keep the process alive on its own.
  timer.unref?.()
  return () => clearInterval(timer)
}

function makeHandle(
  lockDir: string,
  ownerId: string,
  stopHeartbeat: () => void,
): LockHandle {
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      stopHeartbeat()
      const current = await readMeta(lockDir)
      // Only rm when we can POSITIVELY confirm we are still the owner. When
      // ownership cannot be confirmed — either because another process now
      // owns the lock, OR because `readMeta` returned null (meta missing /
      // unreadable, the exact state during a concurrent reclaim's
      // `rm + mkdir` → `writeFile(meta)` window in tryClaim) — leave the dir
      // intact. Wiping a freshly-mkdir'd lockDir there would make the new
      // owner's pending writeFile throw ENOENT and bubble up uncaught,
      // breaking the cross-process critical section. The next acquirer's
      // stale check reclaims a stranded dir naturally.
      if (!current || current.meta.ownerId !== ownerId) return
      await rm(lockDir, { recursive: true, force: true }).catch(ignore)
    },
  }
}

/** Acquire `lockDir`, waiting for a current holder up to `timeoutMs`. */
export async function acquireLock(
  lockDir: string,
  opts: LockOptions,
): Promise<LockHandle> {
  await mkdir(dirname(lockDir), { recursive: true }).catch(ignore)
  const meta: LockMeta = {
    ownerId: randomUUID(),
    pid: process.pid,
    host: hostname(),
    acquiredAt: Date.now(),
  }
  const deadline = Date.now() + opts.timeoutMs
  for (;;) {
    if (await tryClaim(lockDir, meta)) {
      return makeHandle(
        lockDir,
        meta.ownerId,
        startHeartbeat(lockDir, meta, opts.heartbeatMs),
      )
    }
    const current = await readMeta(lockDir)
    if (current !== null && Date.now() - current.mtimeMs > opts.staleMs) {
      // Holder crashed without releasing: reclaim and retry immediately.
      await rm(lockDir, { recursive: true, force: true }).catch(ignore)
      continue
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(lockDir)
    await sleep(opts.retryMs + Math.floor(Math.random() * opts.retryMs))
  }
}

/** Run `fn` while holding `lockDir`, releasing it even if `fn` throws. */
export async function withLock<T>(
  lockDir: string,
  opts: LockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireLock(lockDir, opts)
  try {
    return await fn()
  } finally {
    await handle.release()
  }
}
