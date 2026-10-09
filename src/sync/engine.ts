/** The sync operations. Every one reports a short, link-free outcome and never throws. */
import { readPool } from '../pool/store'
import type { ProviderAdapter } from '../providers/types'
import { applyPlan } from './apply'
import { decodeKey, encodeKey, generateKey, open, seal } from './crypto'
import { describeSyncError, SyncError } from './errors'
import { createGist, parseGistLink, readGist, updateGist } from './gist'
import { discoverGithubToken, type GhRunner } from './github-auth'
import { planMerge } from './merge'
import {
  buildPayload,
  collectEntries,
  entriesDigest,
  parsePayload,
} from './payload'
import {
  readSyncState,
  type SyncState,
  updateSyncState,
  writeSyncStatus,
} from './state'

export interface EngineDeps {
  now: () => number
  runGh?: GhRunner
  adapters?: readonly ProviderAdapter[]
}

/** What an operation did; `backoffMs` asks the caller to leave GitHub alone that long. */
export interface Outcome {
  ok: boolean
  message: string
  backoffMs?: number
}

export interface SyncEngine {
  /** Download, decrypt and merge the gist (subscriber). */
  poll(reqAt?: number): Promise<Outcome>
  /** Upload the static credentials, to the same gist unless `fresh` (publisher). */
  upload(fresh: boolean, reqAt?: number): Promise<Outcome>
  /** Start following a gist link, then sync it once. */
  subscribe(link: string, reqAt?: number): Promise<Outcome>
  /** Stop syncing; imported accounts stay. */
  forget(reqAt?: number): Promise<Outcome>
  /** Whichever sync fits the current role. */
  sync(reqAt?: number): Promise<Outcome>
  /** The digest of the credentials a publisher has not uploaded yet, or null when the gist is current. */
  unpublishedDigest(): Promise<string | null>
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function createEngine(deps: EngineDeps): SyncEngine {
  const { now } = deps

  async function settle(
    run: () => Promise<string>,
    reqAt: number | undefined,
  ): Promise<Outcome> {
    let outcome: Outcome
    try {
      outcome = { ok: true, message: await run() }
    } catch (error) {
      outcome = {
        ok: false,
        message: describeSyncError(error),
        ...(error instanceof SyncError && error.retryAfterMs
          ? { backoffMs: error.retryAfterMs }
          : {}),
      }
    }
    await writeSyncStatus({
      at: now(),
      ok: outcome.ok,
      message: outcome.message,
      ...(reqAt === undefined ? {} : { reqAt }),
    })
    return outcome
  }

  /** Keep `next` only while the state still follows the gist this run read. */
  function amend(
    gistId: string,
    next: (state: SyncState) => SyncState,
  ): Promise<SyncState | null> {
    return updateSyncState((cur) => (cur?.gistId === gistId ? next(cur) : cur))
  }

  async function download(): Promise<string> {
    const state = await readSyncState()
    if (state?.role !== 'subscriber') throw new SyncError('not-set-up')
    const read = await readGist(state.gistId, state.etag, now())
    if (!read.changed) {
      await amend(state.gistId, (cur) => ({ ...cur, syncedAt: now() }))
      return 'Up to date.'
    }
    const key = decodeKey(state.key)
    if (!key) throw new SyncError('decrypt')
    const entries = parsePayload(open(read.content, key))
    const plan = planMerge((await readPool()).accounts, entries, state.imported)
    const applied = await applyPlan(plan, state.imported, deps.adapters)
    await amend(state.gistId, (cur) => ({
      ...cur,
      imported: applied.imported,
      syncedAt: now(),
      // An unverified entry must be seen again: no etag keeps the gist "changed".
      etag: applied.deferred === 0 ? read.etag : undefined,
    }))
    const tail =
      applied.deferred > 0
        ? `; ${count(applied.deferred, 'entry', 'entries')} could not be verified yet`
        : ''
    return `Synced: ${applied.added} added, ${applied.updated} updated, ${applied.removed} removed${tail}.`
  }

  async function publish(fresh: boolean): Promise<string> {
    const token = await discoverGithubToken(deps.runGh)
    if (!token) throw new SyncError('no-auth')
    const state = await readSyncState()
    const entries = collectEntries(await readPool())
    const prior = !fresh && state?.role === 'publisher' ? state : null
    const priorKey = prior ? decodeKey(prior.key) : null
    const key = priorKey ?? generateKey()
    const blob = seal(buildPayload(entries, now()), key)
    let gist: { id: string; owner?: string | undefined }
    if (prior && priorKey) {
      await updateGist(token, prior.gistId, blob, now())
      gist = { id: prior.gistId, owner: prior.owner }
    } else gist = await createGist(token, blob, now())
    await updateSyncState(() => ({
      v: 1,
      role: 'publisher',
      gistId: gist.id,
      key: encodeKey(key),
      ...(gist.owner ? { owner: gist.owner } : {}),
      syncedAt: now(),
      uploadedDigest: entriesDigest(entries),
      imported: {},
    }))
    return `Uploaded ${count(entries.length, 'credential', 'credentials')}.`
  }

  const engine: SyncEngine = {
    poll: (reqAt) => settle(download, reqAt),
    upload: (fresh, reqAt) => settle(() => publish(fresh), reqAt),
    async subscribe(link, reqAt) {
      const parsed = parseGistLink(link)
      if (!parsed)
        return settle(() => Promise.reject(new SyncError('bad-link')), reqAt)
      await updateSyncState((cur) => ({
        v: 1,
        role: 'subscriber',
        gistId: parsed.id,
        key: encodeKey(parsed.key),
        imported:
          cur?.role === 'subscriber' && cur.gistId === parsed.id
            ? cur.imported
            : {},
      }))
      return settle(download, reqAt)
    },
    async forget(reqAt) {
      return settle(async () => {
        await updateSyncState(() => null)
        return 'Stopped syncing. Imported accounts stay in the pool.'
      }, reqAt)
    },
    async sync(reqAt) {
      const state = await readSyncState()
      return state?.role === 'publisher'
        ? engine.upload(false, reqAt)
        : engine.poll(reqAt)
    },
    async unpublishedDigest() {
      const state = await readSyncState()
      if (state?.role !== 'publisher') return null
      const digest = entriesDigest(collectEntries(await readPool()))
      return digest === state.uploadedDigest ? null : digest
    },
  }
  return engine
}
