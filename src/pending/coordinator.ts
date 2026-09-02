import type { LockHandle } from '../pool/lock'
import { readPool } from '../pool/store'
import type { ProviderAdapter } from '../providers/types'
import type { SchedulerConfig } from '../scheduler/config'
import type { PoolFile } from '../types'
import {
  refreshUsageInBackground,
  USAGE_REFRESH_TTL_MS,
} from '../usage-refresh'
import { ignore, sleepAbortable } from '../util'
import { acquirePendingLease } from './lease'
import { classifyProviderRecovery, type ProviderRecovery } from './recovery'
import {
  listPendingForWorkspace,
  pendingKey,
  removePending,
  removePendingSession,
  upsertPending,
} from './store'
import type { PendingRef, PendingSchedule, PendingTurn } from './types'

export type CapacityWaitResult = 'available' | 'unusable'

interface RestoreUserMessage {
  id: string
  sessionID: string
  role: 'user'
  agent: string
  model: { providerID: string; modelID: string }
  system?: string
  tools?: Record<string, boolean>
}

interface RestoreAssistantMessage {
  id: string
  sessionID: string
  role: 'assistant'
  parentID: string
  finish?: string
  error?: unknown
}

type RestoreMessage = RestoreUserMessage | RestoreAssistantMessage

interface RestoreResult<T> {
  data?: T
  error?: unknown
  response?: { status: number }
}

interface RestoreReadOptions {
  path: { id: string; messageID: string }
  query: { directory: string }
}

interface RestoreSessionOptions {
  path: { id: string }
  query: { directory: string }
}

interface RestorePromptOptions extends RestoreSessionOptions {
  body: {
    messageID: string
    model: { providerID: string; modelID: string }
    agent: string
    system?: string
    tools?: Record<string, boolean>
    parts: []
  }
}

export interface PendingRestoreClient {
  session: {
    message(
      options: RestoreReadOptions,
    ): Promise<RestoreResult<{ info: RestoreMessage; parts: unknown[] }>>
    messages(
      options: RestoreSessionOptions,
    ): Promise<RestoreResult<{ info: RestoreMessage; parts: unknown[] }[]>>
    prompt(options: RestorePromptOptions): Promise<RestoreResult<unknown>>
  }
}

export interface PendingCoordinatorDependencies {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  readPool(): Promise<PoolFile>
  refreshUsage(now: number): Promise<void>
  upsert(ref: PendingRef, schedule: PendingSchedule): Promise<PendingTurn>
  remove(ref: PendingRef | string): Promise<boolean>
  acquireLease(key: string): Promise<LockHandle>
  list(workspace: string, providerID?: string): Promise<PendingTurn[]>
  removeSession(workspace: string, sessionID: string): Promise<number>
  onPending(
    ref: PendingRef,
    recovery: Extract<ProviderRecovery, { state: 'quota-blocked' }>,
  ): Promise<void> | void
  onResumed(ref: PendingRef): Promise<void> | void
  onRestored(count: number): Promise<void> | void
  onRestoreError(ref: PendingRef, error: unknown): Promise<void> | void
}

export interface PendingCoordinatorOptions {
  workspace: string
  adapter: ProviderAdapter
  config: SchedulerConfig
  dependencies?: Partial<PendingCoordinatorDependencies>
}

const disposedError = (): Error => new Error('OpenCode plugin disposed')

export class PendingCoordinator {
  readonly workspace: string
  readonly providerID: string

  private readonly adapter: ProviderAdapter
  private readonly config: SchedulerConfig
  private readonly dependencies: PendingCoordinatorDependencies
  private readonly leases = new Map<string, LockHandle>()
  private readonly acquiring = new Map<string, Promise<LockHandle>>()
  private readonly active = new Map<AbortController, PendingRef>()
  private readonly restoring = new Map<string, Promise<void>>()
  private readonly pendingToasts = new Map<string, string>()
  private disposing = false

  constructor(options: PendingCoordinatorOptions) {
    this.workspace = options.workspace
    this.providerID = options.adapter.id
    this.adapter = options.adapter
    this.config = options.config
    this.dependencies = {
      now: Date.now,
      sleep: sleepAbortable,
      readPool,
      refreshUsage: refreshUsageInBackground.bind(null, this.adapter),
      upsert: upsertPending,
      remove: removePending,
      acquireLease: acquirePendingLease,
      list: listPendingForWorkspace,
      removeSession: removePendingSession,
      onPending: ignore,
      onResumed: ignore,
      onRestored: ignore,
      onRestoreError: ignore,
      ...options.dependencies,
    }
  }

  private async ensureLease(key: string): Promise<void> {
    if (this.leases.has(key)) return
    let acquisition = this.acquiring.get(key)
    if (!acquisition) {
      acquisition = this.dependencies.acquireLease(key)
      this.acquiring.set(key, acquisition)
    }
    try {
      const handle = await acquisition
      this.leases.set(key, handle)
    } finally {
      this.acquiring.delete(key)
    }
  }

  private async releaseLease(key: string): Promise<void> {
    const handle = this.leases.get(key)
    if (!handle) return
    this.leases.delete(key)
    await handle.release()
  }

  private async notifyPending(
    ref: PendingRef,
    recovery: Extract<ProviderRecovery, { state: 'quota-blocked' }>,
  ): Promise<void> {
    const key = pendingKey(ref)
    const signature = recovery.resumeAt?.toString() ?? 'unknown'
    if (this.pendingToasts.get(key) === signature) return
    this.pendingToasts.set(key, signature)
    await Promise.resolve(this.dependencies.onPending(ref, recovery)).catch(
      ignore,
    )
  }

  private async clear(ref: PendingRef): Promise<void> {
    const key = pendingKey(ref)
    try {
      await this.dependencies.remove(ref)
      this.pendingToasts.delete(key)
    } finally {
      await this.releaseLease(key)
    }
  }

  async waitForCapacity(
    ref: PendingRef,
    initial: Extract<ProviderRecovery, { state: 'quota-blocked' }>,
    outerSignal?: AbortSignal,
  ): Promise<CapacityWaitResult> {
    const key = pendingKey(ref)
    if (this.disposing) throw disposedError()
    await this.ensureLease(key)
    try {
      await this.dependencies.upsert(ref, {
        now: this.dependencies.now(),
        nextCheckAt: initial.nextCheckAt,
        resumeAt: initial.resumeAt,
      })
    } catch (error) {
      await this.releaseLease(key)
      throw error
    }
    if (this.disposing) {
      await this.releaseLease(key)
      throw disposedError()
    }

    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(outerSignal?.reason)
    if (outerSignal?.aborted) forwardAbort()
    else outerSignal?.addEventListener('abort', forwardAbort, { once: true })
    this.active.set(controller, ref)

    let recovery = initial
    await this.notifyPending(ref, recovery)
    try {
      for (;;) {
        await this.dependencies.sleep(
          Math.max(0, recovery.nextCheckAt - this.dependencies.now()),
          controller.signal,
        )
        const now = this.dependencies.now()
        await this.dependencies.refreshUsage(now).catch(ignore)
        let next: ProviderRecovery
        try {
          const pool = await this.dependencies.readPool()
          next = classifyProviderRecovery(
            pool.accounts,
            this.providerID,
            this.config,
            now,
            USAGE_REFRESH_TTL_MS,
          )
        } catch {
          next = {
            state: 'quota-blocked',
            nextCheckAt: now + USAGE_REFRESH_TTL_MS,
            resumeAt: recovery.resumeAt,
          }
        }
        if (next.state === 'available') {
          await Promise.resolve(this.dependencies.onResumed(ref)).catch(ignore)
          return 'available'
        }
        if (next.state === 'unusable') {
          await this.clear(ref)
          return 'unusable'
        }
        recovery = next
        await this.dependencies
          .upsert(ref, {
            now,
            nextCheckAt: recovery.nextCheckAt,
            resumeAt: recovery.resumeAt,
          })
          .catch(ignore)
        await this.notifyPending(ref, recovery)
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.disposing) await this.releaseLease(key)
        else await this.clear(ref)
      } else {
        await this.releaseLease(key)
      }
      throw error
    } finally {
      outerSignal?.removeEventListener('abort', forwardAbort)
      this.active.delete(controller)
    }
  }

  /** Remove a completed/terminal turn and release any execution lease it owns. */
  async complete(ref: PendingRef): Promise<void> {
    const key = pendingKey(ref)
    if (!this.leases.has(key) && !this.pendingToasts.has(key)) return
    await this.clear(ref)
  }

  /** Explicit user cancellation removes durable state; shutdown preserves it. */
  async abort(ref: PendingRef): Promise<void> {
    const key = pendingKey(ref)
    if (!this.leases.has(key) && !this.pendingToasts.has(key)) return
    if (this.disposing) {
      this.pendingToasts.delete(key)
      await this.releaseLease(key)
      return
    }
    await this.clear(ref)
  }

  private async restoreOnce(
    turn: PendingTurn,
    client: PendingRestoreClient,
  ): Promise<void> {
    const message = await client.session.message({
      path: { id: turn.sessionID, messageID: turn.messageID },
      query: { directory: this.workspace },
    })
    if (message.response?.status === 404) {
      await this.clear(turn)
      return
    }
    if (message.error !== undefined)
      throw new Error(`Failed to read pending message ${turn.messageID}`)
    const info = message.data?.info
    if (
      !info ||
      info.role !== 'user' ||
      info.id !== turn.messageID ||
      info.sessionID !== turn.sessionID ||
      info.model.providerID !== turn.providerID
    ) {
      await this.clear(turn)
      return
    }

    const history = await client.session.messages({
      path: { id: turn.sessionID },
      query: { directory: this.workspace },
    })
    if (history.response?.status === 404) {
      await this.clear(turn)
      return
    }
    if (history.error !== undefined || !history.data)
      throw new Error(`Failed to read pending session ${turn.sessionID}`)
    const completed = history.data.some(
      (entry) =>
        entry.info.role === 'assistant' &&
        entry.info.parentID === turn.messageID &&
        typeof entry.info.finish === 'string' &&
        entry.info.finish.length > 0 &&
        entry.info.error === undefined,
    )
    if (completed) {
      await this.clear(turn)
      return
    }

    const prompt = await client.session.prompt({
      path: { id: turn.sessionID },
      query: { directory: this.workspace },
      body: {
        messageID: info.id,
        model: info.model,
        agent: info.agent,
        ...(info.system === undefined ? {} : { system: info.system }),
        ...(info.tools === undefined ? {} : { tools: info.tools }),
        parts: [],
      },
    })
    if (prompt.response?.status === 404) {
      await this.clear(turn)
      return
    }
    if (prompt.error !== undefined)
      throw new Error(`Failed to restore pending message ${turn.messageID}`)
  }

  private async restoreWithRetry(
    original: PendingTurn,
    client: PendingRestoreClient,
  ): Promise<void> {
    const controller = new AbortController()
    this.active.set(controller, original)
    let backoffMs = 1_000
    try {
      for (;;) {
        if (this.disposing) return
        try {
          const current = (
            await this.dependencies.list(this.workspace, this.providerID)
          ).find((turn) => turn.key === original.key)
          if (!current) return
          await this.ensureLease(current.key)
          try {
            await this.restoreOnce(current, client)
            return
          } finally {
            await this.releaseLease(current.key)
          }
        } catch (error) {
          if (this.disposing || controller.signal.aborted) return
          await Promise.resolve(
            this.dependencies.onRestoreError(original, error),
          ).catch(ignore)
          try {
            await this.dependencies.sleep(backoffMs, controller.signal)
          } catch (sleepError) {
            if (this.disposing || controller.signal.aborted) return
            throw sleepError
          }
          backoffMs = Math.min(backoffMs * 2, 60_000)
        }
      }
    } finally {
      this.active.delete(controller)
    }
  }

  /** Restore this workspace/provider's durable references independently. */
  async restore(client: PendingRestoreClient): Promise<void> {
    if (this.disposing) return
    const turns = (
      await this.dependencies.list(this.workspace, this.providerID)
    ).filter(
      (turn) =>
        turn.workspace === this.workspace &&
        turn.providerID === this.providerID,
    )
    if (turns.length === 0) return
    await Promise.resolve(this.dependencies.onRestored(turns.length)).catch(
      ignore,
    )
    const tasks = turns.map((turn) => {
      const existing = this.restoring.get(turn.key)
      if (existing) return existing
      const task = this.restoreWithRetry(turn, client)
      this.restoring.set(turn.key, task)
      void task
        .finally(() => {
          if (this.restoring.get(turn.key) === task)
            this.restoring.delete(turn.key)
        })
        .catch(ignore)
      return task
    })
    await Promise.allSettled(tasks)
  }

  /** Remove all pending providers for a deleted session in this workspace. */
  async removeSession(sessionID: string): Promise<number> {
    const turns = (await this.dependencies.list(this.workspace)).filter(
      (turn) => turn.sessionID === sessionID,
    )
    for (const [controller, ref] of this.active) {
      if (ref.sessionID === sessionID) controller.abort()
    }
    const removed = await this.dependencies.removeSession(
      this.workspace,
      sessionID,
    )
    await Promise.allSettled(
      turns.map(async (turn) => {
        this.pendingToasts.delete(turn.key)
        await this.releaseLease(turn.key)
      }),
    )
    return removed
  }

  /** Mark shutdown before aborting sleepers so their abort path preserves rows. */
  async dispose(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    for (const controller of this.active.keys())
      controller.abort(disposedError())
    await Promise.allSettled(
      [...this.leases.keys()].map((key) => this.releaseLease(key)),
    )
  }
}
