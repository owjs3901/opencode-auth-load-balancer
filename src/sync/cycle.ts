/**
 * One sync cycle of a member of a gist, always in this order: read the gist,
 * apply it locally, and only then, if this machine may write, put its own
 * entries back. A machine never uploads on top of a snapshot it has not
 * merged, carries every other machine's entries over untouched, and changes the
 * gist only when the list would actually differ.
 */
import { readPool } from '../pool/store'
import type { ProviderAdapter } from '../providers/types'
import { type ApplyResult, applySnapshot } from './apply'
import { decodeKey, open, seal } from './crypto'
import { SyncError } from './errors'
import { readGist, updateGist } from './gist'
import { discoverGithubToken, type GhRunner } from './github-auth'
import { hasFreedSkips } from './merge'
import { machineOrigin } from './origin'
import { listable, ownEntries } from './own'
import {
  buildPayload,
  entriesDigest,
  parsePayload,
  sortEntries,
  type SyncEntry,
} from './payload'
import { readSyncState, type SyncWrite, updateSyncState } from './state'
import { POLL_MS, PUBLISH_RETRY_MS } from './timing'

export interface CycleDeps {
  now: () => number
  runGh?: GhRunner
  adapters?: readonly ProviderAdapter[]
}

/** What the cycle tells the scheduler: how soon to try again if it fails. */
export interface CycleReport {
  retryMs: number
}

/** After GitHub refuses the account's write, nothing is attempted for this long (downloads go on). */
export const WRITE_BACKOFF_MS = 3_600_000
const UNREADABLE_NOTE =
  'The gist has entries this version cannot read; update this plugin to upload.'

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Save what applying a snapshot did to the pool: the import records, and the newest snapshot applied. */
function recordApplied(
  gistId: string,
  at: number,
  applied: ApplyResult,
  syncedAt: number,
): Promise<unknown> {
  return updateSyncState((cur) =>
    cur?.gistId === gistId
      ? {
          ...cur,
          imported: applied.imported,
          skipped: applied.skipped,
          appliedAt: Math.max(at, cur.appliedAt ?? 0),
          syncedAt,
          etag: undefined,
        }
      : cur,
  )
}
/**
 * Run one cycle. `force` is "Upload now": it needs a GitHub token (and says so
 * if there is none), reads the gist afresh, and tries to write even inside the
 * back-off after a refusal. Never writes without the lock the caller holds.
 */
export async function runCycle(
  deps: CycleDeps,
  force: boolean,
  report: CycleReport,
): Promise<string> {
  const { now } = deps
  const state = await readSyncState()
  if (!state) throw new SyncError('not-set-up')
  const key = decodeKey(state.key) ?? Buffer.alloc(32)
  const origin = await machineOrigin()
  const token = await discoverGithubToken(deps.runGh)
  if (force && !token) throw new SyncError('no-auth')
  const pool = await readPool()
  const backedOff =
    state.write === 'denied' && !force && now() < (state.writeCheckAt ?? 0)
  const mayWrite = token !== null && !backedOff
  const before = entriesDigest(ownEntries(pool, origin, state.imported))
  const dirty = mayWrite && before !== state.uploadedDigest
  report.retryMs = dirty ? PUBLISH_RETRY_MS : POLL_MS
  const reread = force || dirty || hasFreedSkips(pool.accounts, state.skipped)
  const auth = token ?? undefined
  let read = await readGist(state.gistId, state.etag, now(), auth)
  if (!read.changed && reread)
    read = await readGist(state.gistId, undefined, now(), auth)
  const standing: SyncWrite =
    token === null ? 'no-token' : backedOff ? 'denied' : 'ok'
  if (!read.changed) {
    const write =
      standing === 'ok' && state.write === 'unreadable'
        ? 'unreadable'
        : standing
    await updateSyncState((cur) =>
      cur?.gistId === state.gistId ? { ...cur, syncedAt: now(), write } : cur,
    )
    return 'Up to date.'
  }

  const snapshot = parsePayload(open(read.content, key))
  const stale = state.appliedAt !== undefined && snapshot.at < state.appliedAt
  if (stale && !mayWrite) throw new SyncError('rolled-back')
  // What was applied is on record before anything can fail (the upload, a
  // later pass): the pool has the rows, so the state must know they came from
  // the gist. No etag is kept until the whole cycle, write included, is done,
  // so a failed cycle is read again instead of answered 304.
  const applied = stale
    ? null
    : await applySnapshot(
        snapshot,
        { origin, imported: state.imported, skipped: state.skipped },
        {
          ...(deps.adapters ? { adapters: deps.adapters } : {}),
          afterPass: (soFar) =>
            recordApplied(state.gistId, snapshot.at, soFar, now()),
        },
      )
  const own = ownEntries(
    await readPool(),
    origin,
    applied?.imported ?? state.imported,
  )
  const unreadable = snapshot.unreadable > 0
  let write: SyncWrite = standing
  let wrote: SyncEntry[] | null = null
  let stamped = 0
  let denied = false
  if (mayWrite && unreadable) write = 'unreadable'
  if (mayWrite && !unreadable) {
    const others = snapshot.entries.filter((e) => e.origin !== origin)
    const next = sortEntries([...others, ...listable(own, others, origin)])
    const same =
      JSON.stringify(next) === JSON.stringify(sortEntries(snapshot.entries))
    if (!same || stale) {
      stamped = Math.max(
        now(),
        snapshot.at + 1,
        (state.uploadedAt ?? 0) + 1,
        (state.appliedAt ?? 0) + 1,
      )
      try {
        await updateGist(
          token,
          state.gistId,
          seal(buildPayload(next, stamped), key),
          now(),
        )
        wrote = next.filter((e) => e.origin === origin)
      } catch (error) {
        if (!(error instanceof SyncError) || error.code !== 'write-denied')
          throw error
        denied = true
        write = 'denied'
      }
    }
  }
  const deferred = applied?.deferred ?? 0
  await updateSyncState((cur) =>
    cur?.gistId === state.gistId
      ? {
          ...cur,
          syncedAt: now(),

          etag:
            wrote || stale || deferred > 0 || denied ? undefined : read.etag,
          write,
          writeCheckAt: denied
            ? now() + WRITE_BACKOFF_MS
            : backedOff
              ? cur.writeCheckAt
              : undefined,
          uploadedDigest:
            mayWrite && !unreadable && !denied
              ? entriesDigest(own)
              : cur.uploadedDigest,
          ...(wrote ? { uploadedAt: stamped } : {}),
        }
      : cur,
  )
  const parts: string[] = []
  const moved = applied
    ? applied.added + applied.updated + applied.removed + deferred
    : 0
  if (applied && moved > 0) {
    const tail =
      deferred > 0
        ? `; ${count(deferred, 'entry', 'entries')} could not be verified yet`
        : ''
    parts.push(
      `Synced: ${applied.added} added, ${applied.updated} updated, ${applied.removed} removed${tail}.`,
    )
  } else if (!wrote) parts.push('Up to date.')
  if (wrote)
    parts.push(`Uploaded ${count(wrote.length, 'credential', 'credentials')}.`)
  if (denied) parts.push(new SyncError('write-denied').message)
  if (mayWrite && unreadable && state.write !== 'unreadable')
    parts.push(UNREADABLE_NOTE)
  return parts.join(' ')
}
