/** The sync operations. Every one reports a short, link-free outcome and never throws. */
import { readPool } from '../pool/store'
import type { ProviderAdapter } from '../providers/types'
import { encodeKey, generateKey, seal } from './crypto'
import { type CycleReport, runCycle } from './cycle'
import { describeSyncError, SyncError } from './errors'
import { createGist, parseGistLink } from './gist'
import { discoverGithubToken, type GhRunner } from './github-auth'
import { machineOrigin } from './origin'
import { ownEntries } from './own'
import { buildPayload, entriesDigest } from './payload'
import {
  newMap,
  newRefs,
  readSyncState,
  updateSyncState,
  writeSyncStatus,
} from './state'
import { POLL_MS } from './timing'

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
  /** One full cycle: download and apply, then upload this machine's own changes when it may. */
  sync(reqAt?: number): Promise<Outcome>
  /**
   * "Upload now": a cycle that insists on writing (it needs a GitHub token),
   * or with `fresh` (or when this machine follows nothing) a new gist.
   */
  upload(fresh: boolean, reqAt?: number): Promise<Outcome>
  /** Start following a gist link, then sync it once. */
  subscribe(link: string, reqAt?: number): Promise<Outcome>
  /** Stop syncing; imported accounts stay. */
  forget(reqAt?: number): Promise<Outcome>
  /**
   * The digest of this machine's own credentials when the gist may be out of
   * date and this machine may write, else null.
   */
  unpublishedDigest(): Promise<string | null>
  /**
   * The scheduled cycle. Call it with the cycle lock held: it looks at the
   * persisted state again and returns null (does nothing) unless this machine
   * still follows gist gistId and a cycle is due.
   */
  backgroundPoll(gistId: string): Promise<Outcome | null>
  /**
   * The automatic upload, decided again under the lock: null unless this
   * machine still follows gist gistId, no back-off is running, and its
   * credentials still differ from the upload by digest.
   */
  backgroundPublish(gistId: string, digest: string): Promise<Outcome | null>
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function createEngine(deps: EngineDeps): SyncEngine {
  const { now } = deps

  /**
   * Run `work` and record when background work may next run: a success pushes
   * the next scheduled cycle out by the poll interval, a failure waits as long
   * as GitHub asked, or the cycle's own retry delay.
   */
  async function settle(
    work: (report: CycleReport) => Promise<string>,
    reqAt: number | undefined,
    scheduled: boolean,
  ): Promise<Outcome> {
    const report: CycleReport = { retryMs: POLL_MS }
    let outcome: Outcome
    try {
      outcome = { ok: true, message: await work(report) }
    } catch (error) {
      outcome = {
        ok: false,
        message: describeSyncError(error),
        ...(error instanceof SyncError && error.retryAfterMs
          ? { backoffMs: error.retryAfterMs }
          : {}),
      }
    }
    if (scheduled) {
      const wait = outcome.backoffMs ?? report.retryMs
      await updateSyncState(
        (cur) =>
          cur &&
          (outcome.ok
            ? { ...cur, pollAt: now() + POLL_MS, retryAt: undefined }
            : { ...cur, retryAt: now() + wait }),
      )
    }
    await writeSyncStatus({
      at: now(),
      ok: outcome.ok,
      message: outcome.message,
      ...(reqAt === undefined ? {} : { reqAt }),
    })
    return outcome
  }

  const cycle = (force: boolean) => (report: CycleReport) =>
    runCycle(deps, force, report)

  /** A new secret gist holding this machine's own credentials, which this machine then follows as its creator. */
  async function create(): Promise<string> {
    const token = await discoverGithubToken(deps.runGh)
    if (!token) throw new SyncError('no-auth')
    const origin = await machineOrigin()
    const own = ownEntries(await readPool(), origin, newRefs())
    const key = generateKey()
    const at = now()
    const gist = await createGist(
      token,
      seal(buildPayload(own, at), key),
      now(),
    )
    await updateSyncState(() => ({
      v: 1,
      gistId: gist.id,
      key: encodeKey(key),
      creator: true,
      ...(gist.owner ? { owner: gist.owner } : {}),
      write: 'ok',
      syncedAt: now(),
      uploadedDigest: entriesDigest(own),
      uploadedAt: at,
      appliedAt: at,
      pollAt: now() + POLL_MS,
      imported: newRefs(),
      skipped: newMap(),
    }))
    return `Uploaded ${count(own.length, 'credential', 'credentials')}.`
  }

  async function unpublishedDigest(): Promise<string | null> {
    const state = await readSyncState()
    if (
      !state ||
      state.write === 'no-token' ||
      state.write === 'unreadable' ||
      (state.write === 'denied' && now() < (state.writeCheckAt ?? 0))
    )
      return null
    const own = ownEntries(
      await readPool(),
      await machineOrigin(),
      state.imported,
    )
    const digest = entriesDigest(own)
    return digest === state.uploadedDigest ? null : digest
  }

  const engine: SyncEngine = {
    sync: (reqAt) => settle(cycle(false), reqAt, true),
    async upload(fresh, reqAt) {
      const state = await readSyncState()
      return fresh || !state
        ? settle(create, reqAt, false)
        : settle(cycle(true), reqAt, true)
    },
    async subscribe(link, reqAt) {
      const parsed = parseGistLink(link)
      if (!parsed)
        return settle(
          () => Promise.reject(new SyncError('bad-link')),
          reqAt,
          false,
        )
      await updateSyncState((cur) => {
        const prior = cur?.gistId === parsed.id ? cur : null
        return {
          v: 1,
          gistId: parsed.id,
          key: encodeKey(parsed.key),
          creator: prior?.creator ?? false,
          ...(prior?.owner ? { owner: prior.owner } : {}),
          imported: prior?.imported ?? newRefs(),
          skipped: prior?.skipped ?? newMap(),
        }
      })
      return settle(cycle(false), reqAt, true)
    },
    async forget(reqAt) {
      return settle(
        async () => {
          await updateSyncState(() => null)
          return 'Stopped syncing. Imported accounts stay in the pool.'
        },
        reqAt,
        false,
      )
    },
    unpublishedDigest,
    async backgroundPoll(gistId) {
      const state = await readSyncState()
      if (
        state?.gistId !== gistId ||
        now() < Math.max(state.pollAt ?? 0, state.retryAt ?? 0)
      )
        return null
      return engine.sync()
    },
    async backgroundPublish(gistId, digest) {
      const state = await readSyncState()
      if (
        state?.gistId !== gistId ||
        now() < (state.retryAt ?? 0) ||
        (await unpublishedDigest()) !== digest
      )
        return null
      return engine.sync()
    },
  }
  return engine
}
