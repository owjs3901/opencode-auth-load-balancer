import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test } from 'bun:test'

import { AuthLoadBalancerStatusPlugin } from '../legacy'
import { poolFilePath } from '../pool/paths'
import { mutatePool, readPool } from '../pool/store'
import { selectAccount } from '../scheduler/select'
import type { LoopTimers } from '../sync/loop'
import type { UsageSnapshot } from '../types'
import { startUsagePoll } from '../usage-poll'
import {
  refreshUsageInBackground,
  USAGE_REFRESH_TTL_MS,
} from '../usage-refresh'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'
import { responderFetch } from './fixtures/fetch-mock'

let dir: string
let clock: number
let scheduled: (() => void)[]
let periods: number[]
let cleared: unknown[]
let polls: ReturnType<typeof startUsagePoll>[]
const realFetch = globalThis.fetch
const DAY = 86_400_000

const timers: LoopTimers = {
  set(run, ms) {
    scheduled.push(run)
    periods.push(ms)
    return run
  },
  clear: (timer) => cleared.push(timer),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'auth-lb-usage-poll-'))
  process.env.OPENCODE_AUTH_LB_DIR = dir
  clock = Date.now()
  scheduled = []
  periods = []
  cleared = []
  polls = []
})

afterEach(async () => {
  await Promise.all(polls.map((poll) => poll.dispose()))
  globalThis.fetch = realFetch
  delete process.env.OPENCODE_AUTH_LB_DIR
  await rm(dir, { recursive: true, force: true })
})

function start(refresh: (now: number) => Promise<void>) {
  const poll = startUsagePoll({ refresh, now: () => clock, timers })
  polls.push(poll)
  return poll
}

const receipt = () => `${poolFilePath()}.usage-poll.json`

test('an idle quota-blocked account becomes selectable on the next periodic check after a reset', async () => {
  const cooldown = clock + 2 * DAY
  await mutatePool((pool) => {
    pool.accounts = [
      testAccount({
        id: 'usage-poll-idle',
        label: 'contact',
        expires: clock + 7 * DAY,
        cooldownUntil: cooldown,
        cooldownKind: 'quota',
        usage: {
          hourly: { utilization: 1, resetAt: cooldown },
          weekly: { utilization: 1, resetAt: cooldown },
          capturedAt: clock,
        },
      }),
    ]
  })
  let requests = 0
  const reset: UsageSnapshot = {
    hourly: { utilization: 0, resetAt: 0 },
    weekly: { utilization: 0, resetAt: 0 },
    capturedAt: clock + USAGE_REFRESH_TTL_MS,
  }
  const adapter = fakeAdapter({
    fetchUsage: async () => {
      requests += 1
      return reset
    },
  })
  const poll = start((at) => refreshUsageInBackground(adapter, at))

  expect(requests).toBe(0)
  expect(periods).toEqual([USAGE_REFRESH_TTL_MS])
  clock += USAGE_REFRESH_TTL_MS
  scheduled[0]?.()
  await poll.tick()

  const pool = await readPool()
  expect(requests).toBe(1)
  expect(pool.accounts[0]?.cooldownUntil).toBe(0)
  expect(selectAccount(pool.accounts, 'anthropic', clock)?.degraded).toBe(false)
})

test('all windows share one attempt schedule even if a usage request fails', async () => {
  let requests = 0
  const first = start(async () => {
    requests += 1
    throw new Error('Fake endpoint unavailable')
  })
  const second = start(async () => {
    requests += 1
  })

  await expect(first.tick()).rejects.toThrow('Fake endpoint unavailable')
  await second.tick()
  expect(requests).toBe(1)
  clock += USAGE_REFRESH_TTL_MS
  await second.tick()
  expect(requests).toBe(2)
})

test('overlapping ticks and another window never run the same periodic batch twice', async () => {
  let release: () => void = () => undefined
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered: () => void = () => undefined
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let requests = 0
  const first = start(async () => {
    requests += 1
    entered()
    await hold
  })
  const second = start(async () => {
    requests += 1
  })
  const inflight = first.tick()
  await started
  expect(first.tick()).toBe(inflight)
  await second.tick()
  const disposing = first.dispose()
  await first.tick()
  release()
  await disposing
  await inflight
  expect(requests).toBe(1)
  expect(cleared).toContain(scheduled[0])
})

test.each(['not-json', 'null', '{"nextPollAt":"invalid"}'])(
  'a malformed schedule %s can be repaired by a new poll',
  async (contents) => {
    await writeFile(receipt(), contents)
    let requests = 0
    const poll = start(async () => {
      requests += 1
    })
    await poll.tick()
    await poll.tick()
    expect(requests).toBe(1)
  },
)

test('an unreadable schedule fails closed rather than polling through a filesystem error', async () => {
  await mkdir(receipt())
  const poll = start(async () => {
    throw new Error('Must not reach the endpoint')
  })
  await expect(poll.tick()).rejects.toThrow()
})

test('the default poll uses the provider registry and the lifecycle disposes its timer', async () => {
  await mutatePool((pool) => {
    pool.accounts = [
      testAccount({ id: 'usage-poll-default', expires: clock + DAY }),
    ]
  })
  globalThis.fetch = responderFetch(
    () => () =>
      Response.json({
        five_hour: { utilization: 10, resets_at: null },
        seven_day: { utilization: 20, resets_at: null },
      }),
  )
  const poll = startUsagePoll()
  polls.push(poll)
  await poll.tick()
  expect((await readPool()).accounts[0]?.usage.weekly?.utilization).toBe(0.2)
  const plugin = await AuthLoadBalancerStatusPlugin({
    directory: dir,
    worktree: dir,
  })
  await plugin.dispose?.()
})
