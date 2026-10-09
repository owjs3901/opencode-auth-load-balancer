/**
 * The sync schedule: claim TUI requests every second, download at start and
 * every 15 minutes (subscriber), upload a few seconds after the static
 * credentials stop changing (publisher). One run at a time per process, and
 * one per machine through a lock, so two opencode windows never both fetch.
 */
import { type LockOptions, LockTimeoutError, withLock } from '../pool/lock'
import { syncStateFilePath } from '../pool/paths'
import { ignore } from '../util'
import type { Outcome, SyncEngine } from './engine'
import { type SyncIntent, takeIntent } from './intent'
import { readSyncState } from './state'

export const TICK_MS = 1_000
export const POLL_MS = 15 * 60_000
export const CHANGE_CHECK_MS = 5_000
export const DEBOUNCE_MS = 10_000
export const PUBLISH_RETRY_MS = 5 * 60_000
const REQUEST_LOCK_WAIT_MS = 30_000
const BACKGROUND_LOCK_WAIT_MS = 200

export interface LoopTimers {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/** Timers that never keep the process alive. */
export const realTimers: LoopTimers = {
  set(run, ms) {
    const handle = setInterval(run, ms)
    handle.unref()
    return handle
  },
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** Run `fn` unless another opencode process is mid-run; resolves undefined then. */
export async function withCycleLock<T>(
  fn: () => Promise<T>,
  waitMs: number,
): Promise<T | undefined> {
  const options: LockOptions = {
    staleMs: 60_000,
    timeoutMs: waitMs,
    retryMs: 25,
    heartbeatMs: 5_000,
  }
  try {
    return await withLock(`${syncStateFilePath()}.cycle.lock`, options, fn)
  } catch (error) {
    if (error instanceof LockTimeoutError) return undefined
    throw error
  }
}

export interface LoopDeps {
  engine: SyncEngine
  now: () => number
  timers?: LoopTimers
  /** Claims the TUI's pending request; defaults to the file handshake. */
  take?: (now: number) => Promise<SyncIntent | null>
}

export interface SyncLoop {
  start(): void
  dispose(): void
  /** One scheduler step; exposed so tests drive time themselves. */
  tick(): Promise<void>
}

export function createSyncLoop(deps: LoopDeps): SyncLoop {
  const { engine, now } = deps
  const timers = deps.timers ?? realTimers
  const take = deps.take ?? takeIntent
  let handle: unknown
  let busy = false
  let disposed = false
  let pollAt = 0
  let checkAt = 0
  let backoffUntil = 0
  let publishBlockedUntil = 0
  let pending: { digest: string; since: number } | null = null

  function run(intent: SyncIntent): Promise<Outcome> {
    switch (intent.action) {
      case 'upload':
        return engine.upload(false, intent.at)
      case 'upload-new':
        return engine.upload(true, intent.at)
      case 'subscribe':
        return engine.subscribe(intent.link ?? '', intent.at)
      case 'sync':
        return engine.sync(intent.at)
      case 'forget':
        return engine.forget(intent.at)
    }
  }

  async function request(intent: SyncIntent, t: number): Promise<void> {
    const outcome = await withCycleLock(() => run(intent), REQUEST_LOCK_WAIT_MS)
    pending = null
    pollAt = t + POLL_MS
    if (outcome?.backoffMs) backoffUntil = t + outcome.backoffMs
  }

  async function download(t: number): Promise<void> {
    pollAt = t + POLL_MS
    const outcome = await withCycleLock(
      () => engine.poll(),
      BACKGROUND_LOCK_WAIT_MS,
    )
    if (outcome?.backoffMs) backoffUntil = t + outcome.backoffMs
  }

  async function publishWhenSettled(t: number): Promise<void> {
    const digest = await engine.unpublishedDigest()
    if (digest === null) {
      pending = null
      return
    }
    if (pending?.digest !== digest) {
      pending = { digest, since: t }
      return
    }
    if (t - pending.since < DEBOUNCE_MS || t < publishBlockedUntil) return
    const outcome = await withCycleLock(
      () => engine.upload(false),
      BACKGROUND_LOCK_WAIT_MS,
    )
    if (outcome?.ok) pending = null
    else if (outcome)
      publishBlockedUntil = t + (outcome.backoffMs ?? PUBLISH_RETRY_MS)
  }

  async function background(t: number): Promise<void> {
    if (t < checkAt) return
    checkAt = t + CHANGE_CHECK_MS
    const state = await readSyncState()
    if (state?.role === 'subscriber' && t >= pollAt && t >= backoffUntil)
      await download(t)
    else if (state?.role === 'publisher') await publishWhenSettled(t)
  }

  async function tick(): Promise<void> {
    if (busy || disposed) return
    busy = true
    try {
      const t = now()
      const intent = await take(t)
      if (intent) await request(intent, t)
      else await background(t)
    } catch {
      // A failed step is retried by the next one; the engine already reported it.
    } finally {
      busy = false
    }
  }

  return {
    start() {
      handle = timers.set(() => void tick().catch(ignore), TICK_MS)
      void tick().catch(ignore)
    },
    dispose() {
      disposed = true
      timers.clear(handle)
    },
    tick,
  }
}
