import { readFile } from 'node:fs/promises'

import { LockTimeoutError, withLock } from './pool/lock'
import { poolFilePath } from './pool/paths'
import { writeJsonAtomic } from './pool/store'
import { type LoopTimers, realTimers } from './sync/loop'
import {
  refreshAllUsageInBackground,
  USAGE_REFRESH_TTL_MS,
} from './usage-refresh'
import { ignore, isFiniteNumber, isPlainObject } from './util'

interface UsagePollDeps {
  now?: () => number
  refresh?: (now: number) => Promise<void>
  timers?: LoopTimers
}

async function nextPollAt(path: string): Promise<number> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isPlainObject(value) && isFiniteNumber(value.nextPollAt)
      ? value.nextPollAt
      : 0
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && 'code' in error && error.code === 'ENOENT')
    )
      return 0
    throw error
  }
}

export function startUsagePoll(deps: UsagePollDeps = {}) {
  const now = deps.now ?? Date.now
  const refresh = deps.refresh ?? refreshAllUsageInBackground
  const timers = deps.timers ?? realTimers
  let disposed = false
  let inflight: Promise<void> | undefined

  async function poll(): Promise<void> {
    const path = `${poolFilePath()}.usage-poll.json`
    try {
      await withLock(
        `${path}.lock`,
        {
          staleMs: 120_000,
          timeoutMs: 0,
          retryMs: 25,
          heartbeatMs: 5_000,
        },
        async () => {
          const at = now()
          if (at < (await nextPollAt(path))) return
          // Persist attempts too, so a failing endpoint is not retried by every window.
          await writeJsonAtomic(
            path,
            JSON.stringify({ nextPollAt: at + USAGE_REFRESH_TTL_MS }),
          )
          await refresh(at)
        },
      )
    } catch (error) {
      if (!(error instanceof LockTimeoutError)) throw error
    }
  }

  function tick(): Promise<void> {
    if (disposed) return Promise.resolve()
    inflight ??= poll().finally(() => {
      inflight = undefined
    })
    return inflight
  }

  const timer = timers.set(
    () => void tick().catch(ignore),
    USAGE_REFRESH_TTL_MS,
  )
  return {
    tick,
    async dispose(): Promise<void> {
      disposed = true
      timers.clear(timer)
      await inflight
    },
  }
}
