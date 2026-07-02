import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  emptyUsage,
  type PoolAccount,
  type PoolFile,
  type SessionAssignment,
  type UsageWindow,
} from '../types'
import { ignore, isPlainObject, sleep } from '../util'
import { type LockOptions, withLock as withFileLock } from './lock'
import { poolFilePath } from './paths'

function emptyPool(): PoolFile {
  return { version: 1, accounts: [], lastSelected: {}, sessions: {} }
}

/**
 * The pool-file write lock is held only across one JSON read-modify-write (ms),
 * so a generous timeout still never blocks a real request. It serializes pool
 * mutations across opencode processes (the in-process `chain` below only covers
 * one process); without it two instances can lost-update usage/cooldowns.
 */
const POOL_WRITE_LOCK: LockOptions = {
  staleMs: 30_000,
  timeoutMs: 30_000,
  retryMs: 25,
  heartbeatMs: 5_000,
}

function poolLockDir(): string {
  return `${poolFilePath()}.lock`
}

const RENAME_RETRIES = 5
const RENAME_RETRY_MS = 20

/** Thrown when the pool file cannot be written atomically after retries. */
export class PoolWriteError extends Error {
  constructor(
    readonly path: string,
    readonly reason: unknown,
  ) {
    super(`Failed to write pool file atomically: ${path}`)
    this.name = 'PoolWriteError'
  }
}

/**
 * Thrown when the pool file exists but cannot be READ (EACCES, EMFILE, Windows
 * EBUSY/EPERM from an AV tool, EISDIR…). Deliberately distinct from the two
 * tolerated read outcomes (missing file, corrupt JSON → empty pool): inside
 * `mutatePool` a swallowed transient read fault would mutate an EMPTY pool and
 * write it back — atomically WIPING every registered account. Bubbling a typed
 * error lets `bestEffort` skip the bookkeeping write instead.
 */
export class PoolReadError extends Error {
  constructor(
    readonly path: string,
    readonly reason: unknown,
  ) {
    super(`Failed to read pool file: ${path}`)
    this.name = 'PoolReadError'
  }
}

/**
 * In-process mutex. opencode issues many concurrent requests through one process,
 * and every request may read-modify-write the pool (usage updates, cooldowns,
 * token refresh). Serializing those mutations prevents lost updates.
 */
let chain: Promise<unknown> = Promise.resolve()
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(ignore, ignore)
  return run
}

/**
 * Heal a hand-edited usage window shape. A window missing a numeric
 * `utilization` is unusable — map it to `null` (the same "malformed window is
 * unusable" rule the providers' `endpointWindow` helpers apply). A usable
 * window whose `resetAt` is not a number (deleted, or `"2026-01-01"`) would
 * otherwise flow into `relTime`'s `Math.round((undefined - now) / 60_000)`
 * and render the literal string `NaNdNaNh` in the status tool/CLI dashboards —
 * coerce it to `0` ("no reset scheduled"). Scoring is already safe
 * (`clamp01`/`?? 0` absorb these), so this is purely a display/type boundary.
 */
function normalizeWindow(w: unknown): UsageWindow | null {
  if (w == null || typeof w !== 'object') return null
  const win = w as Partial<UsageWindow>
  if (!Number.isFinite(win.utilization)) return null
  if (!Number.isFinite(win.resetAt)) win.resetAt = 0
  return win as UsageWindow
}

/**
 * Row-level trust boundary for the user-editable pool file. `Array.isArray`
 * alone trusts each row wholesale, but the README invites hand-editing — and a
 * `null` element or a row missing `usage` throws a TypeError inside
 * `selectForSession`, which runs OUTSIDE the try in `createLoadBalancedFetch`,
 * failing EVERY request (and `buildStatus`, so the dashboard too) until the
 * user repairs the file by hand. Drop non-object rows and default the fields
 * the scheduler dereferences unconditionally: `usage` (→ `emptyUsage()`),
 * `usage.capturedAt` (non-number → `NaN` comparisons that suppress usage
 * seeding forever), and `cooldownUntil` (non-number → `Math.max(undefined, …)`
 * persists `NaN` → JSON `null`). `mutatePool` writes the normalized pool back,
 * so the file self-heals on the next bookkeeping write.
 */
function normalizeAccounts(rows: PoolAccount[]): PoolAccount[] {
  const accounts: PoolAccount[] = []
  for (const row of rows) {
    if (row == null || typeof row !== 'object') continue
    if (row.usage == null || typeof row.usage !== 'object') {
      row.usage = emptyUsage()
    } else {
      if (!Number.isFinite(row.usage.capturedAt)) row.usage.capturedAt = 0
      row.usage.hourly = normalizeWindow(row.usage.hourly)
      row.usage.weekly = normalizeWindow(row.usage.weekly)
    }
    if (!Number.isFinite(row.cooldownUntil)) row.cooldownUntil = 0
    // A hand-edited non-number `expires` ("tomorrow") makes `needsRefresh`'s
    // `expires - skew <= now` compare NaN → false FOREVER: the long-expired
    // access token is treated as eternally fresh, every request 401s into an
    // auth cooldown, and the account soft-bricks despite a valid refresh
    // token. Coercing to 0 forces a refresh that repairs the row on first use.
    // (JSON.parse cannot produce NaN, but it CAN produce Infinity —
    // `JSON.parse('1e999') === Infinity` — which fails the same way forever,
    // so the guard must be Number.isFinite, not typeof.)
    if (!Number.isFinite(row.expires)) row.expires = 0
    // The dashboard dereferences `label` unconditionally (`renderStatus`
    // computes `a.label.length` / `a.label.padEnd(...)`), so a hand-edited row
    // whose `label` was deleted (or set to a number) crashes the status tool
    // and CLI until the user repairs the file. An empty label renders blank
    // but never throws; the next bookkeeping write heals the file.
    if (typeof row.label !== 'string') row.label = ''
    accounts.push(row)
  }
  return accounts
}

/**
 * Row-level trust boundary for `sessions` (mirrors `normalizeAccounts`' drop
 * semantics). `isPlainObject` validates only the CONTAINER; a hand-edited row
 * (`"k": "oops"`, or an object with a non-string `accountId` / non-finite
 * `updatedAt`) would otherwise evade the TTL prune FOREVER: `now -
 * pin.updatedAt` is NaN and `NaN > ttlMs` is false, so the garbage entry is
 * rewritten verbatim by every `mutatePool`. `findPinned` tolerates it (returns
 * null), so the impact is a permanent stray row — drop it here instead; the
 * file self-heals on the next bookkeeping write.
 */
function normalizeSessions(
  rows: Record<string, SessionAssignment>,
): Record<string, SessionAssignment> {
  for (const key of Object.keys(rows)) {
    const row: unknown = rows[key]
    if (!isPlainObject(row)) {
      delete rows[key]
      continue
    }
    const pin = row as Partial<SessionAssignment>
    if (typeof pin.accountId !== 'string' || !Number.isFinite(pin.updatedAt)) {
      delete rows[key]
    }
  }
  return rows
}

async function readRaw(): Promise<PoolFile> {
  let text: string
  try {
    text = await readFile(poolFilePath(), 'utf8')
  } catch (error) {
    // Only "file absent" means an empty pool. Any other fs failure (EACCES,
    // EMFILE, Windows EBUSY/EPERM, EISDIR…) is transient/environmental — see
    // PoolReadError above for why it must NOT be treated as an empty pool.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPool()
    throw new PoolReadError(poolFilePath(), error)
  }
  try {
    const parsed = JSON.parse(text) as Partial<PoolFile>
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      return emptyPool()
    }
    return {
      version: 1,
      // `Array.isArray` above narrows to `PoolAccount[]` (no cast needed);
      // `normalizeAccounts` is the row-level trust boundary on top of it.
      accounts: normalizeAccounts(parsed.accounts),
      // `isPlainObject` (not `??`) so hand-edited primitives/arrays are also
      // healed — `??` only replaces `null`/`undefined`, and a surviving
      // primitive (`"sessions": "oops"`) makes `recordSuccess`'s property
      // assignment throw a TypeError that is NOT a tolerated bookkeeping
      // error, discarding an already-served response. `mutatePool` writes the
      // normalized pool back on the next bookkeeping write, same self-heal
      // contract as `normalizeAccounts`.
      lastSelected: isPlainObject(parsed.lastSelected)
        ? parsed.lastSelected
        : {},
      sessions: isPlainObject(parsed.sessions)
        ? normalizeSessions(parsed.sessions)
        : {},
    }
  } catch {
    // The pool file is user-editable; tolerate hand-broken JSON as empty.
    return emptyPool()
  }
}

/** Injectable fs surface so the atomic-write fallback path is unit-testable. */
export interface FsOps {
  mkdir: (path: string, opts: { recursive: boolean }) => Promise<unknown>
  writeFile: (
    path: string,
    data: string,
    opts: { mode: number },
  ) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  unlink: (path: string) => Promise<void>
}

const realFsOps: FsOps = { mkdir, writeFile, rename, unlink }

/**
 * Write JSON atomically: temp file + rename (atomic on POSIX and modern Windows).
 * If the rename fails — e.g. a concurrent process briefly holds the target open
 * (Windows EPERM) — retry a few times, then clean up the temp file and throw. We
 * never fall back to a direct overwrite: that sacrifices atomicity and can shred a
 * concurrent writer's update. Mutations already run under the cross-process pool
 * lock, so a sustained rename failure is a real disk fault worth surfacing.
 */
export async function writeJsonAtomic(
  path: string,
  payload: string,
  ops: FsOps = realFsOps,
): Promise<void> {
  // mkdir and writeFile failures must also surface as PoolWriteError, otherwise
  // `bestEffort` (which only swallows LockTimeoutError | PoolWriteError) lets a
  // raw fs error escape and kill an already-served request. EACCES/ENOSPC/EROFS,
  // and Windows EBUSY/EPERM when a virus scanner holds the file or dir, all hit
  // these two paths. The rename-failure branch below already wraps the same way.
  try {
    await ops.mkdir(dirname(path), { recursive: true })
  } catch (error) {
    throw new PoolWriteError(path, error)
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await ops.writeFile(tmp, payload, { mode: 0o600 })
  } catch (error) {
    // Mirror the rename-failure cleanup: most fs implementations do not leave a
    // partial tmp on a failed writeFile, but unlink is harmless when absent and
    // locks the invariant against a regression that drops the cleanup.
    await ops.unlink(tmp).catch(ignore)
    throw new PoolWriteError(path, error)
  }
  let lastError: unknown = null
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await ops.rename(tmp, path)
      return
    } catch (error) {
      lastError = error
      // The sleep separates ATTEMPTS; after the final failure there is nothing
      // left to wait for — throw immediately instead of one useless backoff.
      if (attempt < RENAME_RETRIES - 1) await sleep(RENAME_RETRY_MS)
    }
  }
  await ops.unlink(tmp).catch(ignore)
  throw new PoolWriteError(path, lastError)
}

async function writeRaw(pool: PoolFile): Promise<void> {
  await writeJsonAtomic(poolFilePath(), JSON.stringify(pool, null, 2))
}

/** Read the pool (serialized against in-flight mutations). */
export async function readPool(): Promise<PoolFile> {
  return withLock(readRaw)
}

/**
 * Atomically read-modify-write the pool. The callback mutates `pool` in place;
 * its return value is forwarded to the caller.
 */
export async function mutatePool<T>(
  fn: (pool: PoolFile) => T | Promise<T>,
): Promise<T> {
  // In-process chain first (cheap, collapses same-process callers), then the
  // cross-process file lock around the actual read-modify-write so two opencode
  // instances can't interleave their mutations.
  return withLock(() =>
    withFileLock(poolLockDir(), POOL_WRITE_LOCK, async () => {
      const pool = await readRaw()
      const result = await fn(pool)
      await writeRaw(pool)
      return result
    }),
  )
}

/** Find an account by id within a pool object. */
export function findAccount(
  pool: PoolFile,
  id: string,
): PoolAccount | undefined {
  return pool.accounts.find((a) => a.id === id)
}

/** Read a single account by id from the on-disk pool (serialized read). */
export async function readPoolAccount(
  id: string,
): Promise<PoolAccount | undefined> {
  return findAccount(await readPool(), id)
}
