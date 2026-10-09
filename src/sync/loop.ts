/**
 * The sync schedule: serve TUI requests every second, download at start and
 * every 15 minutes (subscriber), upload a few seconds after the static
 * credentials stop changing (publisher). One run at a time per process, and
 * one per machine through a lock, so two opencode windows never both fetch.
 *
 * Every decision that matters is made again by the engine once the lock is
 * held, from the persisted state: this loop only keeps a cheap watch.
 */
import { type LockOptions, LockTimeoutError, withLock } from '../pool/lock'
import { syncStateFilePath } from '../pool/paths'
import { ignore } from '../util'
import type { Outcome, SyncEngine } from './engine'
import { intentPending, type SyncIntent, takeIntent } from './intent'
import { readSyncState, type SyncState } from './state'

export { POLL_MS, PUBLISH_RETRY_MS } from './timing'

export const TICK_MS = 1_000
export const CHANGE_CHECK_MS = 5_000
export const DEBOUNCE_MS = 10_000
/** How long one tick waits for the machine-wide lock; a busy lock is simply retried by the next tick. */
const LOCK_WAIT_MS = 500
/** How long a graceful shutdown waits for the step in flight, so the lock is released with it. */
const DISPOSE_WAIT_MS = 2_000

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

/**
 * Run `fn` unless another opencode process is mid-run; resolves undefined then.
 * `staleMs` is four heartbeats: a live holder touches the lock every 5 s, so it
 * is never stale, while a holder that died (a process killed mid-run) stops
 * blocking the machine after 20 s instead of a minute.
 */
export async function withCycleLock<T>(
  fn: () => Promise<T>,
  waitMs: number,
): Promise<T | undefined> {
  const options: LockOptions = {
    staleMs: 20_000,
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

/** Where the TUI's requests come from; the file handshake unless a test replaces it. */
export interface IntentSource {
  pending(): Promise<boolean>
  take(now: number): Promise<SyncIntent | null>
}

const fileIntents: IntentSource = { pending: intentPending, take: takeIntent }

export interface LoopDeps {
  engine: SyncEngine
  now: () => number
  timers?: LoopTimers
  intents?: IntentSource
  lockWaitMs?: number
  disposeWaitMs?: number
}

export interface SyncLoop {
  start(): void
  /** Stop ticking and wait (bounded) for the step in flight, so its lock is released. */
  dispose(): Promise<void>
  /** One scheduler step; exposed so tests drive time themselves. */
  tick(): Promise<void>
}

export function createSyncLoop(deps: LoopDeps): SyncLoop {
  const { engine, now } = deps
  const timers = deps.timers ?? realTimers
  const intents = deps.intents ?? fileIntents
  const lockWaitMs = deps.lockWaitMs ?? LOCK_WAIT_MS
  const disposeWaitMs = deps.disposeWaitMs ?? DISPOSE_WAIT_MS
  let handle: unknown
  let busy = false
  let disposed = false
  let inflight: Promise<void> = Promise.resolve()
  let checkAt = 0
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

  /**
   * Claim the request only once the lock is held: a request whose lock is busy
   * stays on disk for the next tick instead of being consumed and lost.
   */
  async function serveRequest(t: number): Promise<void> {
    await withCycleLock(async () => {
      const intent = await intents.take(t)
      if (intent) await run(intent)
    }, lockWaitMs)
    pending = null
  }

  async function publishWhenSettled(
    t: number,
    state: SyncState,
  ): Promise<void> {
    if (t < (state.retryAt ?? 0)) return
    const digest = await engine.unpublishedDigest()
    if (digest === null) {
      pending = null
      return
    }
    if (pending?.digest !== digest) {
      pending = { digest, since: t }
      return
    }
    if (t - pending.since < DEBOUNCE_MS) return
    const outcome = await withCycleLock(
      () => engine.backgroundPublish(state.gistId, digest),
      lockWaitMs,
    )
    if (outcome?.ok) pending = null
  }

  async function background(t: number): Promise<void> {
    if (t < checkAt) return
    checkAt = t + CHANGE_CHECK_MS
    const state = await readSyncState()
    if (state?.role === 'subscriber') {
      if (t >= (state.retryAt ?? 0))
        await withCycleLock(
          () => engine.backgroundPoll(state.gistId),
          lockWaitMs,
        )
    } else if (state?.role === 'publisher') await publishWhenSettled(t, state)
  }

  async function step(): Promise<void> {
    try {
      const t = now()
      if (await intents.pending()) await serveRequest(t)
      else await background(t)
    } catch {
      // A failed step is retried by the next one; the engine already reported it.
    }
  }

  function tick(): Promise<void> {
    if (busy || disposed) return Promise.resolve()
    busy = true
    inflight = step().finally(() => {
      busy = false
    })
    return inflight
  }

  return {
    start() {
      handle = timers.set(() => void tick().catch(ignore), TICK_MS)
      void tick().catch(ignore)
    },
    async dispose() {
      disposed = true
      timers.clear(handle)
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        inflight,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, disposeWaitMs)
        }),
      ])
      clearTimeout(timer)
    },
    tick,
  }
}
