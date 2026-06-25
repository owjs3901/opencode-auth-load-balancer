import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PoolAccount, PoolFile } from '../types'
import { ignore } from '../util'
import { poolFilePath } from './paths'

function emptyPool(): PoolFile {
  return { version: 1, accounts: [], lastSelected: {}, sessions: {} }
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

async function readRaw(): Promise<PoolFile> {
  try {
    const text = await readFile(poolFilePath(), 'utf8')
    const parsed = JSON.parse(text) as Partial<PoolFile>
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      return emptyPool()
    }
    return {
      version: 1,
      accounts: parsed.accounts as PoolAccount[],
      lastSelected: parsed.lastSelected ?? {},
      sessions: parsed.sessions ?? {},
    }
  } catch {
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
 * If the rename fails — e.g. a concurrent process holds the target open (Windows
 * EPERM) — fall back to a direct overwrite.
 */
export async function writeJsonAtomic(
  path: string,
  payload: string,
  ops: FsOps = realFsOps,
): Promise<void> {
  await ops.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await ops.writeFile(tmp, payload, { mode: 0o600 })
    await ops.rename(tmp, path)
  } catch {
    await ops.writeFile(path, payload, { mode: 0o600 })
    await ops.unlink(tmp).catch(ignore)
  }
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
  return withLock(async () => {
    const pool = await readRaw()
    const result = await fn(pool)
    await writeRaw(pool)
    return result
  })
}

/** Find an account by id within a pool object. */
export function findAccount(
  pool: PoolFile,
  id: string,
): PoolAccount | undefined {
  return pool.accounts.find((a) => a.id === id)
}
