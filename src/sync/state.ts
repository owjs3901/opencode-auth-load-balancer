import { readFile, rm } from 'node:fs/promises'

import { type LockOptions, withLock } from '../pool/lock'
import { syncStateFilePath, syncStatusFilePath } from '../pool/paths'
import { writeJsonAtomic } from '../pool/store'
import { ignore, isFiniteNumber, isPlainObject } from '../util'
import { decodeKey } from './crypto'
import { GIST_ID_RE } from './gist'

/** A pool row a synced entry landed on, and a digest of the secret it carried. */
export interface ImportedRef {
  accountId: string
  fingerprint: string
}

/**
 * The latest outcome, for the TUI (its own file: there is nowhere else to say
 * "no GitHub token" before any state exists). `reqAt` echoes the request it
 * answers. Never holds the link or key.
 */
export interface SyncStatus {
  at: number
  ok: boolean
  message: string
  reqAt?: number
}

export type SyncRole = 'publisher' | 'subscriber'

/** Everything sync remembers. Holds the encryption key: the file is owner-only and not part of the pool. */
export interface SyncState {
  v: 1
  role: SyncRole
  gistId: string
  /** The link's key, base64url. */
  key: string
  /** The publisher's GitHub login, for building the link. */
  owner?: string
  etag?: string
  syncedAt?: number
  /** Digest of the entries last uploaded (publisher). */
  uploadedDigest?: string
  /** The t stamped on the last upload (publisher): the next one is strictly later, whatever the clock does. */
  uploadedAt?: number
  /** The newest snapshot t applied (subscriber): an older ciphertext replayed from the gist is refused. */
  appliedAt?: number
  /** No background download or upload before this time: the shared poll schedule, retry delay and rate-limit back-off. */
  retryAt?: number
  /** Entry id ??the local row it was imported into (subscriber). */
  imported: Record<string, ImportedRef>
}

/**
 * An id-keyed map of what was imported. Entry ids come from another machine, so the record has no prototype: `__proto__`, `constructor` and `prototype` are
 * then ordinary keys, and a lookup never finds an inherited member.
 */
export function newRefs(
  from?: Readonly<Record<string, ImportedRef>>,
): Record<string, ImportedRef> {
  const refs: Record<string, ImportedRef> = Object.create(null)
  if (from) for (const [id, ref] of Object.entries(from)) refs[id] = ref
  return refs
}

const STATE_LOCK: LockOptions = {
  staleMs: 30_000,
  timeoutMs: 30_000,
  retryMs: 25,
  heartbeatMs: 5_000,
}

function isRef(value: unknown): value is ImportedRef {
  return (
    isPlainObject(value) &&
    typeof value.accountId === 'string' &&
    typeof value.fingerprint === 'string'
  )
}

/** The state file's content, or null when it is absent, unreadable, or not a sync state. */
function parseState(text: string): SyncState | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (
    !isPlainObject(json) ||
    json.v !== 1 ||
    (json.role !== 'publisher' && json.role !== 'subscriber') ||
    typeof json.gistId !== 'string' ||
    !GIST_ID_RE.test(json.gistId) ||
    typeof json.key !== 'string' ||
    !decodeKey(json.key)
  )
    return null
  const imported = newRefs()
  if (isPlainObject(json.imported))
    for (const [id, ref] of Object.entries(json.imported))
      if (isRef(ref)) imported[id] = ref
  const { owner, etag, syncedAt, uploadedDigest } = json
  const { uploadedAt, appliedAt, retryAt } = json
  return {
    v: 1,
    role: json.role,
    gistId: json.gistId,
    key: json.key,
    imported,
    ...(typeof owner === 'string' ? { owner } : {}),
    ...(typeof etag === 'string' ? { etag } : {}),
    ...(isFiniteNumber(syncedAt) ? { syncedAt } : {}),
    ...(typeof uploadedDigest === 'string' ? { uploadedDigest } : {}),
    ...(isFiniteNumber(uploadedAt) ? { uploadedAt } : {}),
    ...(isFiniteNumber(appliedAt) ? { appliedAt } : {}),
    ...(isFiniteNumber(retryAt) ? { retryAt } : {}),
  }
}

export async function readSyncState(): Promise<SyncState | null> {
  const text = await readFile(syncStateFilePath(), 'utf8').catch(() => null)
  return text === null ? null : parseState(text)
}

/**
 * Read-modify-write the state under a cross-process lock. `fn` returns the
 * next state, or null to forget everything (the file is removed).
 */
export async function updateSyncState(
  fn: (current: SyncState | null) => SyncState | null,
): Promise<SyncState | null> {
  return withLock(`${syncStateFilePath()}.lock`, STATE_LOCK, async () => {
    const next = fn(await readSyncState())
    if (next === null) await rm(syncStateFilePath(), { force: true })
    else await writeJsonAtomic(syncStateFilePath(), JSON.stringify(next))
    return next
  })
}

/** Publish the outcome for the TUI to show; best effort, since a lost line only loses a message. */
export async function writeSyncStatus(status: SyncStatus): Promise<void> {
  await writeJsonAtomic(syncStatusFilePath(), JSON.stringify(status)).catch(
    ignore,
  )
}
