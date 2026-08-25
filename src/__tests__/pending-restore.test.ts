import { describe, expect, test } from 'bun:test'

import {
  PendingCoordinator,
  type PendingRestoreClient,
} from '../pending/coordinator'
import { pendingKey } from '../pending/store'
import type { PendingTurn } from '../pending/types'
import { DEFAULT_CONFIG } from '../scheduler/config'
import { sleep } from '../util'
import { fakeAdapter } from './fixtures/adapter'

const WORKSPACE = 'C:\\work\\restore'
const OTHER_WORKSPACE = 'C:\\work\\other'
const START = 1_800_000_000_000

function turn(id: string, over: Partial<PendingTurn> = {}): PendingTurn {
  const base = {
    workspace: WORKSPACE,
    providerID: 'anthropic',
    sessionID: `session-${id}`,
    messageID: `message-${id}`,
  }
  return {
    ...base,
    key: pendingKey(base),
    createdAt: START,
    updatedAt: START,
    nextCheckAt: START - 1,
    resumeAt: START - 1,
    ...over,
  }
}

function user(pending: PendingTurn) {
  return {
    id: pending.messageID,
    sessionID: pending.sessionID,
    role: 'user' as const,
    time: { created: START },
    agent: 'build',
    model: { providerID: pending.providerID, modelID: 'claude-opus-4-7' },
    system: 'system instruction',
    tools: { bash: false, read: true },
  }
}

interface RestoreHarness {
  coordinator: PendingCoordinator
  client: PendingRestoreClient
  turns: Map<string, PendingTurn>
  prompts: unknown[]
  events: string[]
}

function harness(
  initial: PendingTurn[],
  overrides: Partial<PendingRestoreClient['session']> = {},
): RestoreHarness {
  const turns = new Map(initial.map((pending) => [pending.key, pending]))
  const prompts: unknown[] = []
  const events: string[] = []
  const client: PendingRestoreClient = {
    session: {
      message: async ({ path }) => {
        const pending = [...turns.values()].find(
          (entry) =>
            entry.sessionID === path.id && entry.messageID === path.messageID,
        )
        return pending
          ? { data: { info: user(pending), parts: [] } }
          : { error: { name: 'NotFoundError' }, response: { status: 404 } }
      },
      messages: async ({ path }) => {
        const pending = [...turns.values()].find(
          (entry) => entry.sessionID === path.id,
        )
        return pending
          ? {
              data: [
                { info: user(pending), parts: [] },
                {
                  info: {
                    id: `assistant-${pending.messageID}`,
                    sessionID: pending.sessionID,
                    role: 'assistant' as const,
                    parentID: pending.messageID,
                    error: {
                      name: 'MessageAbortedError',
                      data: { message: 'interrupted' },
                    },
                  },
                  parts: [],
                },
              ],
            }
          : { error: { name: 'NotFoundError' }, response: { status: 404 } }
      },
      prompt: async (options) => {
        prompts.push(options)
        return { data: {} }
      },
      ...overrides,
    },
  }
  const coordinator = new PendingCoordinator({
    workspace: WORKSPACE,
    adapter: fakeAdapter(),
    config: DEFAULT_CONFIG,
    dependencies: {
      list: async () => [...turns.values()],
      removeSession: async (workspace, sessionID) => {
        let removed = 0
        for (const [key, pending] of turns) {
          if (
            pending.workspace === workspace &&
            pending.sessionID === sessionID
          ) {
            turns.delete(key)
            removed += 1
          }
        }
        return removed
      },
      remove: async (pendingRef) => {
        const key =
          typeof pendingRef === 'string' ? pendingRef : pendingKey(pendingRef)
        events.push(`remove:${key}`)
        return turns.delete(key)
      },
      acquireLease: async (key) => {
        events.push(`lease:${key}`)
        return {
          release: async () => {
            events.push(`release:${key}`)
          },
        }
      },
      sleep: async (ms, signal) => {
        if (signal?.aborted) throw signal.reason
        events.push(`sleep:${ms}`)
      },
      onRestored: async (count) => {
        events.push(`restored:${count}`)
      },
      onRestoreError: async (pendingRef) => {
        events.push(`restore-error:${pendingRef.messageID}`)
      },
    },
  })
  return { coordinator, client, turns, prompts, events }
}

describe('PendingCoordinator startup restoration', () => {
  test('filters exact workspace/provider and replays the same user message metadata', async () => {
    const matching = turn('matching')
    const h = harness([
      matching,
      turn('workspace', { workspace: OTHER_WORKSPACE }),
      turn('provider', { providerID: 'openai' }),
    ])

    await h.coordinator.restore(h.client)

    expect(h.prompts).toEqual([
      {
        path: { id: matching.sessionID },
        query: { directory: WORKSPACE },
        body: {
          messageID: matching.messageID,
          model: {
            providerID: 'anthropic',
            modelID: 'claude-opus-4-7',
          },
          agent: 'build',
          system: 'system instruction',
          tools: { bash: false, read: true },
          parts: [],
        },
      },
    ])
    expect(h.turns.has(matching.key)).toBe(true)
    expect(h.events).toContain('restored:1')
  })

  test('a normal terminal assistant child removes stale pending without replay', async () => {
    const pending = turn('done')
    const h = harness([pending], {
      messages: async () => ({
        data: [
          { info: user(pending), parts: [] },
          {
            info: {
              id: 'assistant-done',
              sessionID: pending.sessionID,
              role: 'assistant',
              parentID: pending.messageID,
              finish: 'stop',
            },
            parts: [],
          },
        ],
      }),
    })

    await h.coordinator.restore(h.client)

    expect(h.prompts).toHaveLength(0)
    expect(h.turns.has(pending.key)).toBe(false)
  })

  test('missing messages and non-user references are deleted as orphans', async () => {
    const missing = turn('missing')
    const wrongRole = turn('wrong-role')
    const h = harness([missing, wrongRole], {
      message: async ({ path }) =>
        path.messageID === missing.messageID
          ? { error: {}, response: { status: 404 } }
          : {
              data: {
                info: {
                  id: wrongRole.messageID,
                  sessionID: wrongRole.sessionID,
                  role: 'assistant',
                  parentID: 'parent',
                },
                parts: [],
              },
            },
    })

    await h.coordinator.restore(h.client)

    expect(h.turns.size).toBe(0)
    expect(h.prompts).toHaveLength(0)
  })

  test('one failed restore retries exponentially while another turn proceeds', async () => {
    const flaky = turn('flaky')
    const healthy = turn('healthy')
    let flakyCalls = 0
    const h = harness([flaky, healthy], {
      prompt: async (options) => {
        const body = options.body
        h.prompts.push(options)
        if (body.messageID === flaky.messageID && flakyCalls++ < 2)
          throw new Error('server unavailable')
        return { data: {} }
      },
    })

    await h.coordinator.restore(h.client)

    expect(
      h.prompts.filter(
        (entry) =>
          (entry as { body: { messageID: string } }).body.messageID ===
          healthy.messageID,
      ),
    ).toHaveLength(1)
    expect(h.events.filter((event) => event.startsWith('sleep:'))).toEqual([
      'sleep:1000',
      'sleep:2000',
    ])
    expect(
      h.events.filter((event) => event === 'restore-error:message-flaky'),
    ).toHaveLength(2)
  })

  test('duplicate startup scans share one local restoration', async () => {
    const pending = turn('dedupe')
    let releasePrompt: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    let calls = 0
    const h = harness([pending], {
      prompt: async () => {
        calls += 1
        await gate
        return { data: {} }
      },
    })

    const first = h.coordinator.restore(h.client)
    const second = h.coordinator.restore(h.client)
    while (calls === 0) await sleep(0)
    releasePrompt()
    await Promise.all([first, second])

    expect(calls).toBe(1)
  })

  test('session deletion removes every provider row in the workspace', async () => {
    const first = turn('first', { sessionID: 'shared-session' })
    const second = turn('second', {
      sessionID: 'shared-session',
      providerID: 'openai',
    })
    const other = turn('other')
    const h = harness([first, second, other])

    expect(await h.coordinator.removeSession('shared-session')).toBe(2)
    expect([...h.turns.values()]).toEqual([other])
  })
})
