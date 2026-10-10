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
 * An entry that was not imported because the account already has a credential:
 * the digest of the entry's secret, and the row in the way with the digest of
 * the static credential it held ('' when it holds none, such as an OAuth login).
 * While that row still holds it, the entry is not probed again.
 */
export interface SkippedRef {
  fingerprint: string
  blocker: string
  holds: string
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

/**
 * What this machine can do besides downloading, as the last cycle found it:
 * upload (`ok`), or not for lack of a GitHub login, because the GitHub account
 * cannot update the gist, or because the gist holds entries this version
 * cannot read and must not rewrite.
 */
export type SyncWrite = 'ok' | 'no-token' | 'denied' | 'unreadable'
const WRITES: readonly string[] = ['ok', 'no-token', 'denied', 'unreadable']

/** Everything sync remembers. Holds the encryption key: the file is owner-only and not part of the pool. */
export interface SyncState {
  v: 1
  gistId: string
  /** The link's key, base64url. */
  key: string
  /** This machine created the gist, so it may show the link. */
  creator: boolean
  /** The creator's GitHub login, for building the link. */
  owner?: string
  write?: SyncWrite
  /** No upload attempt before this time: the back-off after the GitHub account was refused. */
  writeCheckAt?: number
  etag?: string
  syncedAt?: number
  /** Digest of this machine's own entries as of the last cycle that brought the gist up to date. */
  uploadedDigest?: string
  /** The t stamped on the last upload: the next one is strictly later, whatever the clock does. */
  uploadedAt?: number
  /** The newest snapshot t applied: an older ciphertext replayed from the gist is refused. */
  appliedAt?: number
  /** The next scheduled download (and upload check). */
  pollAt?: number
  /** No background download or upload before this time: the retry delay and rate-limit back-off after a failure. */
  retryAt?: number
  /** Entry key (origin/id) to the local row it was imported into. */
  imported: Record<string, ImportedRef>
  /** Entry key to why it was not imported. */
  skipped: Record<string, SkippedRef>
}

/**
 * A key-indexed map. Keys come from another machine, so the record has no
 * prototype: `__proto__`, `constructor` and `prototype` are then ordinary
 * keys, and a lookup never finds an inherited member.
 */
export function newMap<T>(
  from?: Readonly<Record<string, T>>,
): Record<string, T> {
  const map: Record<string, T> = Object.create(null)
  if (from) for (const [key, value] of Object.entries(from)) map[key] = value
  return map
}

export function newRefs(
  from?: Readonly<Record<string, ImportedRef>>,
): Record<string, ImportedRef> {
  return newMap(from)
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

function isSkip(value: unknown): value is SkippedRef {
  return (
    isPlainObject(value) &&
    typeof value.fingerprint === 'string' &&
    typeof value.blocker === 'string' &&
    typeof value.holds === 'string'
  )
}

function readMap<T>(
  raw: unknown,
  accept: (value: unknown) => value is T,
): Record<string, T> {
  const map = newMap<T>()
  if (isPlainObject(raw))
    for (const [key, value] of Object.entries(raw))
      if (accept(value)) map[key] = value
  return map
}

function isWrite(value: unknown): value is SyncWrite {
  return typeof value === 'string' && WRITES.includes(value)
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
    typeof json.gistId !== 'string' ||
    !GIST_ID_RE.test(json.gistId) ||
    typeof json.key !== 'string' ||
    !decodeKey(json.key)
  )
    return null
  const { owner, etag, syncedAt, uploadedDigest, write } = json
  const { uploadedAt, appliedAt, retryAt, pollAt, writeCheckAt } = json
  return {
    v: 1,
    gistId: json.gistId,
    key: json.key,
    creator: json.creator === true,
    imported: readMap(json.imported, isRef),
    skipped: readMap(json.skipped, isSkip),
    ...(typeof owner === 'string' ? { owner } : {}),
    ...(isWrite(write) ? { write } : {}),
    ...(typeof etag === 'string' ? { etag } : {}),
    ...(isFiniteNumber(syncedAt) ? { syncedAt } : {}),
    ...(typeof uploadedDigest === 'string' ? { uploadedDigest } : {}),
    ...(isFiniteNumber(uploadedAt) ? { uploadedAt } : {}),
    ...(isFiniteNumber(appliedAt) ? { appliedAt } : {}),
    ...(isFiniteNumber(retryAt) ? { retryAt } : {}),
    ...(isFiniteNumber(pollAt) ? { pollAt } : {}),
    ...(isFiniteNumber(writeCheckAt) ? { writeCheckAt } : {}),
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
