import { randomUUID } from 'node:crypto'
import { access, readFile, rename, rm } from 'node:fs/promises'

import { type LockOptions, withLock } from '../pool/lock'
import { syncIntentFilePath } from '../pool/paths'
import { isFiniteNumber, isPlainObject } from '../util'

export type SyncAction =
  'upload' | 'upload-new' | 'subscribe' | 'sync' | 'forget'

/** A TUI request is dead after this long, so an abandoned one cannot fire later. */
export const INTENT_TTL_MS = 10 * 60_000
/** A request stamped further ahead than this is not from a sane clock; it would otherwise outlive the TTL. */
export const INTENT_SKEW_MS = 60_000
const MAX_LINK_CHARS = 2048
/** How long a claim waits for another process's claim to finish. */
const CLAIM_WAIT_MS = 2_000

function claimLock(timeoutMs: number): LockOptions {
  return { staleMs: 10_000, timeoutMs, retryMs: 10, heartbeatMs: 2_000 }
}

const ACTIONS: readonly string[] = [
  'upload',
  'upload-new',
  'subscribe',
  'sync',
  'forget',
]

/**
 * A request the TUI hands the server through a file beside the pool (the TUI
 * cannot import the plugin). `link` rides along for `subscribe` and holds the
 * key, so the file is claimed and deleted the moment the server reads it.
 */
export interface SyncIntent {
  action: SyncAction
  at: number
  link?: string
}

function isAction(value: unknown): value is SyncAction {
  return typeof value === 'string' && ACTIONS.includes(value)
}

function parseIntent(text: string, now: number): SyncIntent | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isPlainObject(json) ||
    !isAction(json.action) ||
    !isFiniteNumber(json.at) ||
    now - json.at > INTENT_TTL_MS ||
    json.at - now > INTENT_SKEW_MS
  )
    return null
  const link =
    typeof json.link === 'string' && json.link.length <= MAX_LINK_CHARS
      ? json.link
      : undefined
  return { action: json.action, at: json.at, ...(link ? { link } : {}) }
}

/** Whether a request is waiting (without claiming it). */
export function intentPending(): Promise<boolean> {
  return access(syncIntentFilePath()).then(
    () => true,
    () => false,
  )
}

/**
 * Claim the pending request, if any. Under a lock the file is renamed to a
 * name of our own and THAT file is read and deleted, so of several opencode
 * processes exactly one acts on it, and a newer request the TUI writes while
 * we read is a different file that is left alone. (A bare rename is not an
 * exclusive claim on Windows: two concurrent renames of one file can both
 * succeed, which is why it runs under the lock.) The claimed file is deleted
 * even when it does not parse. fterClaim is a test seam: it runs once the
 * request is ours and before it is read, which is where the TUI can write a
 * newer one.
 */
export async function takeIntent(
  now: number,
  waitMs: number = CLAIM_WAIT_MS,
  afterClaim?: () => Promise<void>,
): Promise<SyncIntent | null> {
  const path = syncIntentFilePath()
  if (!(await intentPending())) return null
  try {
    return await withLock(`${path}.lock`, claimLock(waitMs), async () => {
      const claimed = `${path}.${randomUUID()}.claimed`
      try {
        await rename(path, claimed)
      } catch {
        return null
      }
      try {
        await afterClaim?.()
        return parseIntent(await readFile(claimed, 'utf8'), now)
      } finally {
        await rm(claimed, { force: true })
      }
    })
  } catch {
    return null
  }
}
