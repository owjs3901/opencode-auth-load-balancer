import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { ignore, sleep } from '../util'

// `os.hostname()` crosses the JS↔native boundary on every call
// (`gethostname(2)` on Linux/macOS, `GetComputerNameW` on Windows), yet the
// hostname is constant for the life of the process. `acquireLock` sits under
// every `mutatePool` call (cross-process pool-write lock around usage
// records, cooldowns, session pins, refresh commits), so an active session
// resolves it multiple times per turn. Capture it ONCE at module load and
// reuse the string in every lock-meta record — `pid: process.pid` and
// `acquiredAt: Date.now()` are property reads and stay per-call; only
// `randomUUID()` MUST stay per-call by the lock-ownership contract.
const HOSTNAME = hostname()

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

interface LockHandle {
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

/**
 * The mtime the staleness gate keys on, via `stat` only — the meta file's
 * CONTENT is irrelevant here (the gate never distinguishes valid from corrupt
 * meta, so parsing it would be dead work on every contended acquisition poll).
 * A corrupt `owner.json` (holder crashed mid-`writeFile`, disk corruption)
 * still reports its mtime and is reclaimed once stale; a LIVE holder is never
 * stolen because its heartbeat keeps rewriting the file, refreshing the mtime.
 *
 * When `owner.json` is missing entirely, fall back to the DIR's mtime: a
 * holder that hard-crashed between tryClaim's mkdir and its writeFile(meta) —
 * kill -9, power loss, OOM; tryClaim's in-process cleanup only covers THROWN
 * errors — leaves a meta-less dir that would otherwise never satisfy the
 * stale gate, so every acquirer spins to LockTimeoutError forever (every
 * `mutatePool` degrades to a 30 s timeout silently absorbed by `bestEffort`,
 * until manual cleanup). The dir mtime gives that state the same "reclaimable
 * once stale" contract. A LIVE holder is never stolen through this path
 * either: creating/deleting `owner.json` updates the dir mtime, the heartbeat
 * re-CREATES a missing meta within heartbeatMs (« staleMs), and "dir mtime =
 * mkdir time gone stale" is only reachable when the hold outlives staleMs —
 * which no caller's hold does (pool lock: ms-scale hold vs 30 s stale;
 * refresh lock: ≤ ~60 s hold vs 120 s stale). When the DIR is gone too (lock
 * released between the caller's failed tryClaim and this read), return null —
 * "not held".
 */
async function lockMtime(lockDir: string): Promise<number | null> {
  const fileStat = await stat(metaFile(lockDir)).catch(ignore)
  if (fileStat) return fileStat.mtimeMs
  const dirStat = await stat(lockDir).catch(ignore)
  return dirStat ? dirStat.mtimeMs : null
}

/**
 * Read ONLY the owner id from the lock's meta file. The release path compares
 * ownership, so it needs the file's CONTENT — unlike the acquire path's
 * staleness gate (`lockMtime`), which needs only an mtime — but it skips the
 * `stat` that gate pays: `release()` runs once per `mutatePool` (usage
 * records, session pins, cooldowns, refresh commits), making that a wasted fs
 * syscall per pool mutation. Returns null when the file is missing,
 * unreadable, or corrupt — exactly the states where release must leave the
 * dir intact.
 */
async function readOwnerId(lockDir: string): Promise<string | null> {
  try {
    const meta = JSON.parse(
      await readFile(metaFile(lockDir), 'utf8'),
    ) as Partial<LockMeta> | null
    return typeof meta?.ownerId === 'string' ? meta.ownerId : null
  } catch {
    return null
  }
}

/**
 * Atomically claim the lock dir, writing owner metadata. `'held'` means the
 * mkdir lost to a current holder (EEXIST — the common contended case);
 * `'noparent'` means it failed because the PARENT dir is missing (ENOENT — a
 * once-ever cold-start case), so the caller knows a parent-ensure + retry can
 * succeed where "wait for the holder" cannot. Collapsing both into one
 * `false` forced `acquireLock` to pay an unconditional parent mkdir plus a
 * whole extra claim round on every contended acquisition.
 */
async function tryClaim(
  lockDir: string,
  meta: LockMeta,
): Promise<'claimed' | 'held' | 'noparent'> {
  try {
    await mkdir(lockDir, { recursive: false })
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'noparent'
      : 'held'
  }
  // If meta write fails after mkdir succeeded (disk full, EACCES, EROFS, or a
  // Windows AV/backup tool holding the dir handle), the propagating error would
  // otherwise leave a dir-with-no-owner-meta behind. lockMtime's dir-mtime
  // fallback does reclaim such a dir eventually, but only once it goes STALE —
  // every acquirer in between still spins to LockTimeoutError, degrading the
  // pool/refresh paths for up to staleMs. Cleaning up symmetrically with
  // writeJsonAtomic's tmp-file unlink keeps this in-process failure path
  // immediately reclaimable; the fallback remains for hard crashes this
  // try/catch cannot survive.
  try {
    await writeFile(metaFile(lockDir), JSON.stringify(meta), { mode: 0o600 })
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true }).catch(ignore)
    throw error
  }
  return 'claimed'
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
      const currentOwner = await readOwnerId(lockDir)
      // Only rm when we can POSITIVELY confirm we are still the owner. When
      // ownership cannot be confirmed — because another process now owns the
      // lock, or `readOwnerId` returned null (meta missing / unreadable, the
      // exact state during a concurrent reclaim's `rm + mkdir` →
      // `writeFile(meta)` window in tryClaim, or a corrupt meta body) —
      // leave the dir intact. Wiping a freshly-mkdir'd lockDir there would
      // make the new owner's pending writeFile throw ENOENT and bubble up
      // uncaught, breaking the cross-process critical section. The next
      // acquirer's stale check reclaims a stranded dir naturally.
      if (currentOwner !== ownerId) return
      await rm(lockDir, { recursive: true, force: true }).catch(ignore)
    },
  }
}

/** Acquire `lockDir`, waiting for a current holder up to `timeoutMs`. */
export async function acquireLock(
  lockDir: string,
  opts: LockOptions,
): Promise<LockHandle> {
  const meta: LockMeta = {
    ownerId: randomUUID(),
    pid: process.pid,
    host: HOSTNAME,
    acquiredAt: Date.now(),
  }
  const deadline = Date.now() + opts.timeoutMs
  // Parent-dir self-heal runs ONLY when a claim failed BECAUSE the parent is
  // missing (`'noparent'`), at most once per acquisition. `acquireLock` sits
  // under every `mutatePool` (usage records, cooldowns, session pins, refresh
  // commits) plus every per-account refresh lock; in the steady state the
  // parent (the pool data dir) always exists, so a failed claim means "held"
  // and goes straight to the stale check — no wasted parent mkdir or extra
  // claim round on the contended path. When the parent IS missing,
  // `tryClaim`'s non-recursive mkdir fails ENOENT, the branch below creates
  // the parent, and the immediate retry claims. The `parentEnsured` guard
  // keeps an UNCREATABLE parent (mkdir keeps failing) converging to
  // LockTimeoutError via the deadline path instead of self-heal spinning.
  let parentEnsured = false
  for (;;) {
    const claim = await tryClaim(lockDir, meta)
    if (claim === 'claimed') {
      return makeHandle(
        lockDir,
        meta.ownerId,
        startHeartbeat(lockDir, meta, opts.heartbeatMs),
      )
    }
    if (claim === 'noparent' && !parentEnsured) {
      parentEnsured = true
      await mkdir(dirname(lockDir), { recursive: true }).catch(ignore)
      continue
    }
    const mtime = await lockMtime(lockDir)
    if (mtime !== null && Date.now() - mtime > opts.staleMs) {
      // Holder crashed without releasing: reclaim and retry immediately.
      await rm(lockDir, { recursive: true, force: true }).catch(ignore)
      // Respect the acquisition deadline even on this fast path. The `rm` above
      // swallows failures, so if the reclaim persistently fails (Windows
      // EACCES/EBUSY from an AV/backup tool holding the stale dir), an
      // unconditional `continue` would skip BOTH the deadline check and the
      // jittered sleep below — degenerating into an unbounded, sleep-free hot
      // spin that never throws the LockTimeoutError its callers (`bestEffort`)
      // are designed to absorb. A successful reclaim still retries immediately.
      if (Date.now() >= deadline) throw new LockTimeoutError(lockDir)
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
