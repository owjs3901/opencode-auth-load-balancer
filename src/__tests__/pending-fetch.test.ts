import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createLoadBalancedFetch, type PendingFetchCoordinator } from '../fetch'
import type { ProviderRecovery } from '../pending/recovery'
import type { PendingRef } from '../pending/types'
import { mutatePool } from '../pool/store'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import { MESSAGE_HEADER, SESSION_HEADER } from '../session'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'
import { type Responder, responderFetch } from './fixtures/fetch-mock'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-pending-fetch-'))
const POOL = join(DIR, 'auth-load-balancer.json')
const WORKSPACE = 'C:\\work\\pending-fetch'

const realFetch = globalThis.fetch
let respond: Responder

function account(over: Partial<PoolAccount> = {}): PoolAccount {
  return testAccount({
    id: 'A',
    label: 'A',
    access: 'token-A',
    expires: Date.now() + 60 * 60_000,
    usage: { hourly: null, weekly: null, capturedAt: Date.now() },
    ...over,
  })
}

function identifiedInit(body = '{}'): RequestInit {
  return {
    method: 'POST',
    body,
    headers: {
      [SESSION_HEADER]: 'session-1',
      [MESSAGE_HEADER]: 'message-1',
    },
  }
}

class FakePendingCoordinator implements PendingFetchCoordinator {
  readonly workspace = WORKSPACE
  readonly waits: {
    ref: PendingRef
    recovery: Extract<ProviderRecovery, { state: 'quota-blocked' }>
  }[] = []
  readonly completed: PendingRef[] = []
  readonly aborted: PendingRef[] = []
  onWait: () => Promise<'available' | 'unusable'> = async () => 'available'

  async waitForCapacity(
    ref: PendingRef,
    recovery: Extract<ProviderRecovery, { state: 'quota-blocked' }>,
  ): Promise<'available' | 'unusable'> {
    this.waits.push({ ref, recovery })
    return this.onWait()
  }

  async complete(ref: PendingRef): Promise<void> {
    this.completed.push(ref)
  }

  async abort(ref: PendingRef): Promise<void> {
    this.aborted.push(ref)
  }
}

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS = '0'
  await rm(POOL, { force: true })
  respond = () => new Response('ok', { status: 200 })
  globalThis.fetch = responderFetch(() => respond)
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.OPENCODE_AUTH_LB_DIR
  delete process.env.OPENCODE_AUTH_LB_MAX_WAIT_MS
})

describe('durable pending fetch integration', () => {
  test('known provider-wide exhaustion waits before any upstream request', async () => {
    const resetAt = Date.now() + 60_000
    await mutatePool((pool) => {
      pool.accounts.push(
        account({
          usage: {
            hourly: null,
            weekly: { utilization: 1, resetAt },
            capturedAt: Date.now(),
          },
        }),
      )
    })
    let upstreamCalls = 0
    respond = (_url, init) => {
      upstreamCalls += 1
      const headers = new Headers(init?.headers as HeadersInit)
      expect(headers.get(SESSION_HEADER)).toBeNull()
      expect(headers.get(MESSAGE_HEADER)).toBeNull()
      return new Response('ok', { status: 200 })
    }
    const pending = new FakePendingCoordinator()
    pending.onWait = async () => {
      expect(upstreamCalls).toBe(0)
      await mutatePool((pool) => {
        const stored = pool.accounts[0]
        if (stored) stored.usage.weekly = null
      })
      return 'available'
    }

    const lb = createLoadBalancedFetch(anthropicAdapter, {}, [], pending)
    const response = await lb(
      'https://api.anthropic.com/v1/messages',
      identifiedInit(),
    )

    expect(response.status).toBe(200)
    expect(upstreamCalls).toBe(1)
    expect(pending.waits).toHaveLength(1)
    expect(pending.waits[0]?.ref).toEqual({
      workspace: WORKSPACE,
      providerID: 'anthropic',
      sessionID: 'session-1',
      messageID: 'message-1',
    })
    expect(pending.completed).toHaveLength(1)
  })

  test('reactive account-wide 429s exhaust rotation before entering pending', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account({ id: 'A', access: 'token-A' }))
      pool.accounts.push(account({ id: 'B', label: 'B', access: 'token-B' }))
    })
    let upstreamCalls = 0
    respond = () => {
      upstreamCalls += 1
      return upstreamCalls <= 2
        ? new Response('limited', { status: 429 })
        : new Response('ok', { status: 200 })
    }
    const pending = new FakePendingCoordinator()
    pending.onWait = async () => {
      expect(upstreamCalls).toBe(2)
      await mutatePool((pool) => {
        for (const stored of pool.accounts) {
          stored.cooldownUntil = 0
          delete stored.cooldownKind
        }
      })
      return 'available'
    }

    const response = await createLoadBalancedFetch(
      anthropicAdapter,
      {},
      [],
      pending,
    )('https://api.anthropic.com/v1/messages', identifiedInit())

    expect(response.status).toBe(200)
    expect(upstreamCalls).toBe(3)
    expect(pending.waits).toHaveLength(1)
  })

  test('model-tier fallback runs before provider pending', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account())
    })
    const models: string[] = []
    let calls = 0
    respond = (_url, init) => {
      calls += 1
      models.push((JSON.parse(String(init?.body)) as { model: string }).model)
      return calls === 1
        ? new Response('tier limited', {
            status: 429,
            headers: {
              'anthropic-ratelimit-unified-representative-claim':
                'seven_day_opus',
              'anthropic-ratelimit-unified-reset': String(
                Math.floor((Date.now() + 86_400_000) / 1000),
              ),
            },
          })
        : new Response('ok', { status: 200 })
    }
    const pending = new FakePendingCoordinator()
    const body = JSON.stringify({ model: 'claude-opus-4-7', messages: [] })

    const response = await createLoadBalancedFetch(
      anthropicAdapter,
      {},
      [],
      pending,
    )('https://api.anthropic.com/v1/messages', identifiedInit(body))

    expect(response.status).toBe(200)
    expect(models).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6'])
    expect(pending.waits).toHaveLength(0)
  })

  test('auth-only exhaustion fails normally and never enters quota pending', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account())
    })
    respond = () => new Response('unauthorized', { status: 401 })
    const pending = new FakePendingCoordinator()

    await expect(
      createLoadBalancedFetch(
        anthropicAdapter,
        {},
        [],
        pending,
      )('https://api.anthropic.com/v1/messages', identifiedInit()),
    ).rejects.toThrow('returned 401')
    expect(pending.waits).toHaveLength(0)
    expect(pending.completed).toHaveLength(1)
  })

  test('quota wait becoming unusable returns the clean provider response', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(
        account({
          usage: {
            hourly: null,
            weekly: { utilization: 1, resetAt: Date.now() + 60_000 },
            capturedAt: Date.now(),
          },
        }),
      )
    })
    let upstreamCalls = 0
    respond = () => {
      upstreamCalls += 1
      return new Response('unexpected')
    }
    const pending = new FakePendingCoordinator()
    pending.onWait = async () => 'unusable'

    const response = await createLoadBalancedFetch(
      anthropicAdapter,
      {},
      [],
      pending,
    )('https://api.anthropic.com/v1/messages', identifiedInit())

    expect(response.status).toBe(401)
    expect(upstreamCalls).toBe(0)
    expect(pending.completed).toHaveLength(1)
  })

  test('client abort clears an owned pending turn instead of rotating', async () => {
    await mutatePool((pool) => {
      pool.accounts.push(account())
    })
    const controller = new AbortController()
    respond = () => {
      controller.abort(new DOMException('cancelled', 'AbortError'))
      throw controller.signal.reason
    }
    const pending = new FakePendingCoordinator()

    await expect(
      createLoadBalancedFetch(
        anthropicAdapter,
        {},
        [],
        pending,
      )('https://api.anthropic.com/v1/messages', {
        ...identifiedInit(),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled')
    expect(pending.aborted).toHaveLength(1)
    expect(pending.completed).toHaveLength(0)
  })
})
