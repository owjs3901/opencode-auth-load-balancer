/**
 * This machine's origin: the name under which it lists entries in a gist.
 * Its own small file, not part of the sync state (that is removed on "stop
 * syncing", and rejoining must keep the same origin or the old entries would
 * look like another machine's), and not part of the pool (which many writers
 * rewrite). Random, not secret, and never derived from the host name.
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { type LockOptions, withLock } from '../pool/lock'
import { syncOriginFilePath } from '../pool/paths'
import { writeJsonAtomic } from '../pool/store'
import { isPlainObject } from '../util'
import { ORIGIN_RE } from './payload'

const ORIGIN_LOCK: LockOptions = {
  staleMs: 30_000,
  timeoutMs: 30_000,
  retryMs: 25,
  heartbeatMs: 5_000,
}

async function readOrigin(): Promise<string | null> {
  const text = await readFile(syncOriginFilePath(), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const json: unknown = JSON.parse(text)
    return isPlainObject(json) &&
      typeof json.origin === 'string' &&
      ORIGIN_RE.test(json.origin)
      ? json.origin
      : null
  } catch {
    return null
  }
}

/** This machine's origin; created on first use, under a lock so two windows never make two. */
export async function machineOrigin(): Promise<string> {
  const known = await readOrigin()
  if (known) return known
  return withLock(`${syncOriginFilePath()}.lock`, ORIGIN_LOCK, async () => {
    const raced = await readOrigin()
    if (raced) return raced
    const origin = randomBytes(16).toString('hex')
    await writeJsonAtomic(syncOriginFilePath(), JSON.stringify({ origin }))
    return origin
  })
}
