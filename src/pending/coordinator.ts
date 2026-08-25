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
import { pendingKey, removePending, upsertPending } from './store'
import type { PendingRef, PendingSchedule, PendingTurn } from './types'

export type CapacityWaitResult = 'available' | 'unusable'

export interface PendingCoordinatorDependencies {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  readPool(): Promise<PoolFile>
  refreshUsage(now: number): Promise<void>
  upsert(ref: PendingRef, schedule: PendingSchedule): Promise<PendingTurn>
  remove(ref: PendingRef | string): Promise<boolean>
  acquireLease(key: string): Promise<LockHandle>
  onPending(
    ref: PendingRef,
    recovery: Extract<ProviderRecovery, { state: 'quota-blocked' }>,
  ): Promise<void> | void
  onResumed(ref: PendingRef): Promise<void> | void
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
  private readonly active = new Set<AbortController>()
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
      onPending: ignore,
      onResumed: ignore,
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
    this.active.add(controller)

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
    await this.clear(ref)
  }

  /** Mark shutdown before aborting sleepers so their abort path preserves rows. */
  async dispose(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    for (const controller of this.active) controller.abort(disposedError())
    await Promise.allSettled(
      [...this.leases.keys()].map((key) => this.releaseLease(key)),
    )
  }
}
