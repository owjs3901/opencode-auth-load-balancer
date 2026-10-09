import { access, readFile, rm } from 'node:fs/promises'

import { type LockOptions, withLock } from '../pool/lock'
import { syncIntentFilePath } from '../pool/paths'
import { isFiniteNumber, isPlainObject } from '../util'

export type SyncAction =
  'upload' | 'upload-new' | 'subscribe' | 'sync' | 'forget'

/** A TUI request is dead after this long, so an abandoned one cannot fire later. */
export const INTENT_TTL_MS = 10 * 60_000
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
    now - json.at > INTENT_TTL_MS
  )
    return null
  const link =
    typeof json.link === 'string' && json.link.length <= MAX_LINK_CHARS
      ? json.link
      : undefined
  return { action: json.action, at: json.at, ...(link ? { link } : {}) }
}

/**
 * Claim the pending request, if any: read and delete it under a lock, so of
 * several opencode processes exactly one acts on it. (A bare rename is not an
 * exclusive claim on Windows: two concurrent renames of one file can both
 * succeed.) The file is deleted even when it does not parse.
 */
export async function takeIntent(
  now: number,
  waitMs: number = CLAIM_WAIT_MS,
): Promise<SyncIntent | null> {
  const path = syncIntentFilePath()
  if (
    !(await access(path).then(
      () => true,
      () => false,
    ))
  )
    return null
  try {
    return await withLock(`${path}.lock`, claimLock(waitMs), async () => {
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text === null) return null
      await rm(path, { force: true })
      return parseIntent(text, now)
    })
  } catch {
    return null
  }
}
