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
  /** Entry id ??the local row it was imported into (subscriber). */
  imported: Record<string, ImportedRef>
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
  const imported: Record<string, ImportedRef> = {}
  if (isPlainObject(json.imported))
    for (const [id, ref] of Object.entries(json.imported))
      if (isRef(ref)) imported[id] = ref
  const { owner, etag, syncedAt, uploadedDigest } = json
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
