import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { CLAUDE_CODE_IDENTITY } from '../providers/anthropic/constants'
import { exchangeSetupToken } from '../providers/anthropic/setup-token'
import { fetchUsage } from '../providers/anthropic/usage'
import { testAccount } from './fixtures/account'
import { type Responder, responderFetch } from './fixtures/fetch-mock'

const TOKEN = 'sk-ant-oat01-Ab3_cD-9xYz0123456789abcdefGHIJ'

const realFetch = globalThis.fetch
const realBaseUrl = process.env.ANTHROPIC_BASE_URL
let respond: Responder

beforeEach(() => {
  delete process.env.ANTHROPIC_BASE_URL
  respond = () => new Response('{}', { status: 200 })
  globalThis.fetch = responderFetch(() => respond)
})
afterEach(() => {
  globalThis.fetch = realFetch
  if (realBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
  else process.env.ANTHROPIC_BASE_URL = realBaseUrl
})

interface Call {
  url: string
  init?: RequestInit
}

/** Record every request and answer it with `status` plus the given headers. */
function recordCalls(status: number, headers: Record<string, string> = {}) {
  const calls: Call[] = []
  respond = (url, init) => {
    calls.push({ url, init })
    return new Response('{}', { status, headers })
  }
  return calls
}

const setupRow = () => testAccount({ access: TOKEN, refresh: '' })

describe('setup-token usage probe', () => {
  test('measures a row without a refresh token with one Claude-Code-shaped /v1/messages request', async () => {
    const hourlyReset = Math.floor(Date.now() / 1000) + 3600
    const weeklyReset = Math.floor(Date.now() / 1000) + 3 * 86_400
    const calls = recordCalls(200, {
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': String(hourlyReset),
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-reset': String(weeklyReset),
    })

    const snapshot = await fetchUsage(setupRow(), 7)

    expect(snapshot).toEqual({
      hourly: { utilization: 0.25, resetAt: hourlyReset * 1000 },
      weekly: { utilization: 0.5, resetAt: weeklyReset * 1000 },
      capturedAt: 7,
    })
    // Never the profile-scoped usage endpoint, which 403s an inference-only token.
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.anthropic.com/v1/messages?beta=true',
    ])
    const [probe] = calls
    expect(probe?.init?.method).toBe('POST')
    expect(probe?.init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(probe?.init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
    const body = JSON.parse(String(probe?.init?.body))
    expect(body).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'quota' }],
    })
    expect(body.system.map((block: { text: string }) => block.text)).toContain(
      CLAUDE_CODE_IDENTITY,
    )
  })

  test('reads an exhausted (429) token and leaves a window it did not report unknown', async () => {
    recordCalls(429, { 'anthropic-ratelimit-unified-5h-utilization': '1' })

    const snapshot = await fetchUsage(setupRow(), 3)

    // No weekly window reported: nothing is stamped fresh, so polling continues.
    expect(snapshot).toEqual({
      hourly: { utilization: 1, resetAt: 0 },
      weekly: null,
      capturedAt: 0,
    })
  })

  test('keeps the last-known snapshot when the probe carries no rate-limit headers', async () => {
    recordCalls(401)

    expect(await fetchUsage(setupRow(), 0)).toBeNull()
  })

  test('keeps the last-known snapshot when the probe cannot be sent', async () => {
    respond = () => {
      throw new Error('net')
    }

    expect(await fetchUsage(setupRow(), 0)).toBeNull()
  })
})

describe('setup-token login', () => {
  test('verifies a pasted token with one probe and maps it to an inference-only credential', async () => {
    const calls = recordCalls(200)

    // A terminal wraps the long token, so the copy carries line breaks.
    const tokens = await exchangeSetupToken(
      `  ${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}  \r\n`,
    )

    expect(tokens).toEqual({
      access: TOKEN,
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
      inferenceOnly: true,
    })
    expect(
      calls.map((c) => new Headers(c.init?.headers).get('authorization')),
    ).toEqual([`Bearer ${TOKEN}`])
  })

  test('keys the token to the organization its probe was served for', async () => {
    recordCalls(200, { 'anthropic-organization-id': 'org-1' })

    const tokens = await exchangeSetupToken(TOKEN)

    expect(tokens?.orgId).toBe('org-1')
  })

  test('carries the usage its probe measured, so the login needs no second probe', async () => {
    const calls = recordCalls(200, {
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
    })

    const tokens = await exchangeSetupToken(TOKEN)

    expect(tokens?.usage?.weekly?.utilization).toBe(0.4)
    expect(tokens?.usage?.capturedAt).toBeGreaterThan(0)
    expect(calls).toHaveLength(1)
  })

  test('admits a valid token the probe could not fully serve (exhausted, upstream error)', async () => {
    for (const status of [429, 400, 529]) {
      recordCalls(status)
      expect(await exchangeSetupToken(TOKEN)).not.toBeNull()
    }
  })

  test('refuses a token the API rejects, or one it could not reach', async () => {
    for (const status of [401, 403]) {
      recordCalls(status)
      expect(await exchangeSetupToken(TOKEN)).toBeNull()
    }
    respond = () => {
      throw new Error('net')
    }
    expect(await exchangeSetupToken(TOKEN)).toBeNull()
  })

  test('refuses a paste that is not a setup-token without sending it anywhere', async () => {
    const calls = recordCalls(200)
    for (const paste of [
      'sk-ant-api03-abcdef', // an API key
      'sk-ant-ort01-abcdef', // a refresh token
      'https://platform.claude.com/oauth/code/callback?code=c&state=s',
      'sk-ant-oat01-',
      '',
    ])
      expect(await exchangeSetupToken(paste)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
