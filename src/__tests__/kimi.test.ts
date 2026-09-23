import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  kimiCodeAdapter,
  kimiCodeGlobalAdapter,
} from '../providers/kimi/adapter'
import { KIMI_CODE } from '../providers/kimi/constants'
import { tokensFromApiKey } from '../providers/kimi/key'
import {
  type PollClock,
  refreshOAuth,
  startDeviceLogin,
} from '../providers/kimi/oauth'
import { parseUsages } from '../providers/kimi/usage'
import { adapterFor, ADAPTERS } from '../providers/registry'
import { testAccount } from './fixtures/account'
import { type Responder, responderFetch } from './fixtures/fetch-mock'

const realFetch = globalThis.fetch
let respond: Responder

beforeEach(() => {
  respond = () => new Response('{}', { status: 200 })
  globalThis.fetch = responderFetch(() => respond)
})
afterEach(() => {
  globalThis.fetch = realFetch
})

/** A live `GET /usages` body: both generations of the quota shape side by side. */
const LIVE = {
  usage: {
    limit: '100',
    used: '17',
    remaining: '83',
    resetTime: '2026-09-22T07:32:31.932152Z',
  },
  limits: [
    {
      window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
      detail: {
        limit: '100',
        used: '9',
        remaining: '91',
        resetTime: '2026-09-20T18:32:31.932152Z',
      },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0.086628, reset_time: '2026-09-20T18:32:31Z' },
    limit_7d: { used_ratio: 0.171279, reset_time: '2026-09-22T07:32:31Z' },
  },
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('kimi /usages parser', () => {
  test('reads the ratio windows first', () => {
    const snap = parseUsages(LIVE, 123)
    expect(snap?.hourly).toEqual({
      utilization: 0.086628,
      resetAt: Date.parse('2026-09-20T18:32:31Z'),
    })
    expect(snap?.weekly).toEqual({
      utilization: 0.171279,
      resetAt: Date.parse('2026-09-22T07:32:31Z'),
    })
    expect(snap?.capturedAt).toBe(123)
  })

  test('falls back to the counter shape window by window', () => {
    const counters = parseUsages({ ...LIVE, usages: undefined }, 1)
    expect(counters?.hourly).toEqual({
      utilization: 0.09,
      resetAt: Date.parse('2026-09-20T18:32:31.932Z'),
    })
    expect(counters?.weekly?.utilization).toBeCloseTo(0.17)
    // A ratio for one window only: the other still comes from the counters.
    const mixed = parseUsages(
      { ...LIVE, usages: { limit_7d: LIVE.usages.limit_7d } },
      1,
    )
    expect(mixed?.hourly?.utilization).toBeCloseTo(0.09)
    expect(mixed?.weekly?.utilization).toBe(0.171279)
  })

  test('reads proto3 counters with their zero-valued fields omitted', () => {
    const weekly = (usage: unknown) => parseUsages({ usage }, 0)?.weekly
    expect(weekly({ limit: '100', remaining: '30' })?.utilization).toBe(0.7)
    expect(weekly({ limit: '100' })?.utilization).toBe(0) // unused window
    expect(weekly({ limit: '100', used: '100' })?.utilization).toBe(1)
    expect(weekly({ limit: 200, used: 50 })?.utilization).toBe(0.25)
    expect(weekly({ limit: '100', used: '140' })?.utilization).toBe(1)
  })

  test('finds the five-hour window by duration, not position', () => {
    const hourly = parseUsages(
      {
        limits: [
          null,
          { window: 'x' },
          { window: { duration: 'x', timeUnit: 'TIME_UNIT_MINUTE' } },
          { window: { duration: 300, timeUnit: 'TIME_UNIT_FORTNIGHT' } },
          {
            window: { duration: 1, timeUnit: 'TIME_UNIT_DAY' },
            detail: { limit: '10', used: '10' },
          },
          {
            window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
            detail: { limit: '10', used: '2' },
          },
        ],
      },
      0,
    )?.hourly
    expect(hourly?.utilization).toBe(0.2)
    // No five-hour entry: the hourly window stays unknown.
    const noFiveHour = parseUsages(
      {
        usage: LIVE.usage,
        limits: [
          {
            window: { duration: 60, timeUnit: 'TIME_UNIT_MINUTE' },
            detail: LIVE.usage,
          },
        ],
      },
      0,
    )
    expect(noFiveHour?.hourly).toBeNull()
    expect(noFiveHour?.weekly).not.toBeNull()
    // A five-hour entry (here in seconds) whose detail is malformed: unknown, not 0%.
    expect(
      parseUsages(
        {
          limits: [
            {
              window: { duration: 18000, timeUnit: 'TIME_UNIT_SECOND' },
              detail: 'x',
            },
          ],
        },
        0,
      ),
    ).toBeNull()
  })

  test('returns null when no window parses, keeping the last-known snapshot', () => {
    for (const body of [
      null,
      'x',
      [],
      {},
      { usage: { limit: '0', used: '0' } },
      { usage: { limit: 'x' } },
      { usages: { limit_5h: { used_ratio: 'x' } } },
      { usages: 'x', usage: null, limits: 'x' },
    ])
      expect(parseUsages(body, 0)).toBeNull()
  })

  test('clamps ratios and drops unusable reset times', () => {
    const window = (raw: unknown) =>
      parseUsages({ usages: { limit_7d: raw } }, 0)?.weekly
    expect(window({ used_ratio: '0.5' })).toEqual({
      utilization: 0.5,
      resetAt: 0,
    })
    expect(window({ used_ratio: 1.4 })?.utilization).toBe(1)
    expect(window({ used_ratio: -1 })?.utilization).toBe(0)
    expect(window({ used_ratio: 0, reset_time: 'soon' })?.resetAt).toBe(0)
    expect(window({ used_ratio: 0, reset_time: 1 })?.resetAt).toBe(0)
    expect(
      window({ used_ratio: 0, reset_time: '2999-01-01T00:00:00Z' })?.resetAt,
    ).toBe(0)
  })
})

describe('kimi key login', () => {
  test('authorize sends the user to the deployment console for a key', async () => {
    const cn = await kimiCodeAdapter.authorize()
    expect(cn.url).toBe('https://www.kimi.com/code/console')
    expect(cn.instructions).toBe('Paste your Kimi Code API key here:')
    expect((await kimiCodeGlobalAdapter.authorize()).url).toBe(
      'https://www.kimi.ai/code/console',
    )
  })

  test('exchange checks the pasted key against /me and keys it by the Kimi account', async () => {
    const seen: { url: string; auth: string | null }[] = []
    respond = (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return json({ user_id: 'u_1', nickname: 'moon' })
    }
    const tokens = await kimiCodeAdapter.exchange('  sk-kimi-abc  ', '', '', '')
    expect(tokens).toEqual({
      ...tokensFromApiKey('sk-kimi-abc'),
      accountId: 'u_1',
    })
    expect(tokens).toMatchObject({
      access: 'sk-kimi-abc',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    })
    expect(seen).toEqual([
      { url: 'https://api.kimi.com/coding/v1/me', auth: 'Bearer sk-kimi-abc' },
    ])
    // A profile without an account id still admits the key, keyed by its fingerprint.
    respond = (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return json({ nickname: 'moon' })
    }
    expect(
      await kimiCodeGlobalAdapter.exchange('sk-kimi-abc', '', '', ''),
    ).toEqual(tokensFromApiKey('sk-kimi-abc'))
    expect(seen[1]?.url).toBe('https://api.kimi.ai/coding/v1/me')
  })

  test('exchange rejects a key the API refuses, and a non-key paste unsent', async () => {
    let calls = 0
    respond = () => {
      calls++
      return json({ error: 'unauthorized' }, 401)
    }
    expect(await kimiCodeAdapter.exchange('sk-kimi-bad', '', '', '')).toBeNull()
    expect(calls).toBe(1)
    for (const paste of ['two words', '  ', ''])
      expect(await kimiCodeAdapter.exchange(paste, '', '', '')).toBeNull()
    expect(calls).toBe(1)
  })

  test('the same key always maps to the same account id, and only that key', () => {
    const a = tokensFromApiKey('sk-kimi-a')
    expect(a.accountId).toMatch(/^key:[0-9a-f]{16}$/)
    expect(tokensFromApiKey('sk-kimi-a').accountId).toBe(a.accountId)
    expect(tokensFromApiKey('sk-kimi-b').accountId).not.toBe(a.accountId)
  })

  test('a key row cannot refresh: invalid_grant parks a corrupted one for re-login', async () => {
    let calls = 0
    respond = () => {
      calls++
      return json({})
    }
    await expect(kimiCodeAdapter.refresh('')).rejects.toThrow('invalid_grant')
    expect(calls).toBe(0)
  })
})

describe('kimi device login', () => {
  interface Call {
    url: string
    headers: Record<string, string>
    body: URLSearchParams
  }

  /** Scripted OAuth host: device authorization, then one reply per token poll. */
  function oauthHost(polls: Response[], device: object = {}): Call[] {
    const calls: Call[] = []
    respond = (url, init) => {
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: new URLSearchParams(String(init?.body ?? '')),
      })
      if (url.endsWith('/api/oauth/device_authorization'))
        return json({
          device_code: 'dc',
          user_code: 'ABCD-1234',
          verification_uri: 'https://www.kimi.com/code/authorize_device',
          verification_uri_complete:
            'https://www.kimi.com/code/authorize_device?user_code=ABCD-1234',
          expires_in: 1800,
          interval: 5,
          ...device,
        })
      if (url.endsWith('/api/oauth/token'))
        return polls.shift() ?? json({ error: 'authorization_pending' }, 400)
      return json({ user_id: 'u_42' })
    }
    return calls
  }

  /** A clock that only advances when the poll loop sleeps. */
  function fakeClock(): PollClock & { slept: number[] } {
    let now = 1_000_000
    const slept: number[] = []
    return {
      slept,
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms)
        now += ms
      },
    }
  }

  const approved = () =>
    json({
      access_token: 'kimi-at',
      refresh_token: 'kimi-rt',
      expires_in: 3600,
      token_type: 'Bearer',
    })

  test('polls until approved, slows down on request, and keys the login by account', async () => {
    const calls = oauthHost([
      json({ error: 'authorization_pending' }, 400),
      json({ error: 'slow_down' }, 400),
      approved(),
    ])
    const clock = fakeClock()
    const login = await startDeviceLogin(KIMI_CODE, clock)
    expect(login.url).toBe(
      'https://www.kimi.com/code/authorize_device?user_code=ABCD-1234',
    )
    expect(login.instructions).toContain('ABCD-1234')
    const tokens = await login.complete()
    expect(tokens).toMatchObject({
      access: 'kimi-at',
      refresh: 'kimi-rt',
      accountId: 'u_42',
    })
    expect(clock.slept).toEqual([5000, 10_000])

    const [authorize, poll] = calls
    expect(authorize?.url).toBe(
      'https://auth.kimi.com/api/oauth/device_authorization',
    )
    expect(authorize?.body.get('client_id')).toBe(
      '17e5f671-d194-4dfb-9706-5516cb48c098',
    )
    expect(authorize?.headers['X-Msh-Platform']).toBe(
      'opencode_auth_load_balancer',
    )
    expect(authorize?.headers['X-Msh-Device-Id']).toMatch(/^[0-9a-f]{32}$/)
    expect(poll?.body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    )
    expect(poll?.body.get('device_code')).toBe('dc')
    expect(calls.at(-1)?.url).toBe('https://api.kimi.com/coding/v1/me')
  })

  test('gives up when the user denies, the code expires, or the reply is malformed', async () => {
    for (const reply of [
      json({ error: 'access_denied' }, 400),
      json({ error: 'expired_token' }, 400),
      new Response('bad gateway', { status: 502 }),
      json({ access_token: 'kimi-at' }),
    ]) {
      oauthHost([reply])
      const login = await startDeviceLogin(KIMI_CODE, fakeClock())
      expect(await login.complete()).toBeNull()
    }
  })

  test('stops before a poll would land past the deadline', async () => {
    // 12 s to approve at a 5 s interval: polls at 0, 5 and 10 s — none at 15 s.
    const calls = oauthHost([], { expires_in: 12 })
    const clock = fakeClock()
    const login = await startDeviceLogin(KIMI_CODE, clock)
    expect(await login.complete()).toBeNull()
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(3)
    expect(clock.slept).toEqual([5000, 5000])
  })

  test('defaults a missing interval to 5 s and caps the wait at 15 minutes', async () => {
    const calls = oauthHost([], { interval: undefined, expires_in: undefined })
    const clock = fakeClock()
    expect(
      await (await startDeviceLogin(KIMI_CODE, clock)).complete(),
    ).toBeNull()
    expect(clock.slept.every((ms) => ms === 5000)).toBe(true)
    // 15 min at 5 s apart: 180 polls (0 s .. 895 s).
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(180)
  })

  test('keeps an approved login when the profile lookup has no account id', async () => {
    oauthHost([approved()])
    respond = ((inner) => (url: string, init?: RequestInit) =>
      url.endsWith('/me') ? json({}, 401) : inner(url, init))(respond)
    const tokens = await (
      await startDeviceLogin(KIMI_CODE, fakeClock())
    ).complete()
    expect(tokens).toMatchObject({ access: 'kimi-at', refresh: 'kimi-rt' })
    expect(tokens?.accountId).toBeUndefined()
  })

  test('device authorization failures throw with the HTTP status', async () => {
    respond = () => new Response('down', { status: 503 })
    await expect(startDeviceLogin(KIMI_CODE, fakeClock())).rejects.toThrow(
      'HTTP 503',
    )
    respond = () => json({ device_code: 'dc' })
    await expect(startDeviceLogin(KIMI_CODE, fakeClock())).rejects.toThrow(
      'HTTP 200',
    )
  })

  test('the adapters start the login on their own OAuth host', async () => {
    const calls = oauthHost([])
    await kimiCodeAdapter.startDeviceLogin?.()
    await kimiCodeGlobalAdapter.startDeviceLogin?.()
    expect(calls.map((c) => c.url)).toEqual([
      'https://auth.kimi.com/api/oauth/device_authorization',
      'https://auth.kimi.ai/api/oauth/device_authorization',
    ])
  })
})

describe('kimi oauth refresh', () => {
  test('refreshes on the OAuth host and keeps the old refresh token if none returns', async () => {
    const bodies: URLSearchParams[] = []
    const urls: string[] = []
    respond = (url, init) => {
      urls.push(url)
      bodies.push(new URLSearchParams(String(init?.body)))
      return json({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
    }
    expect(await refreshOAuth(KIMI_CODE, 'r1')).toMatchObject({
      access: 'a2',
      refresh: 'r2',
    })
    expect(urls[0]).toBe('https://auth.kimi.com/api/oauth/token')
    expect(bodies[0]?.get('grant_type')).toBe('refresh_token')
    expect(bodies[0]?.get('refresh_token')).toBe('r1')
    respond = () => json({ access_token: 'a3', expires_in: 3600 })
    expect((await kimiCodeGlobalAdapter.refresh('r2')).refresh).toBe('r2')
  })

  test('a revoked grant — 400 invalid_grant, 401 or 403 — reads as invalid_grant', async () => {
    respond = () => json({ error: 'invalid_grant' }, 400)
    await expect(refreshOAuth(KIMI_CODE, 'r1')).rejects.toThrow(
      /^Token refresh failed: 400/,
    )
    respond = () => json({ error: 'forbidden' }, 403)
    await expect(refreshOAuth(KIMI_CODE, 'r1')).rejects.toThrow('invalid_grant')
    respond = () => new Response('busy', { status: 503 })
    await expect(refreshOAuth(KIMI_CODE, 'r1')).rejects.toThrow(
      /^Token refresh failed: 503/,
    )
  })
})

describe('kimi adapter', () => {
  test('one registered adapter per models.dev deployment', () => {
    expect(adapterFor(ADAPTERS, 'kimi-code-plan-cn')).toBe(kimiCodeAdapter)
    expect(adapterFor(ADAPTERS, 'kimi-code-plan-global')).toBe(
      kimiCodeGlobalAdapter,
    )
  })

  test('applyAuth sends the pooled key as the Bearer and drops the SDK key', () => {
    const headers = new Headers({ 'x-api-key': '', authorization: 'Bearer ' })
    kimiCodeAdapter.applyAuth(
      headers,
      testAccount({ providerID: 'kimi-code-plan-cn', access: 'sk-kimi-x' }),
    )
    expect(headers.get('authorization')).toBe('Bearer sk-kimi-x')
    expect(headers.has('x-api-key')).toBe(false)
  })

  test('passes requests through and classifies statuses like the others', () => {
    const url = 'https://api.kimi.com/coding/v1/chat/completions'
    const res = new Response('ok')
    expect(kimiCodeAdapter.transformUrl(url)).toBe(url)
    expect(kimiCodeAdapter.transformBody('{"a":1}')).toBe('{"a":1}')
    expect(kimiCodeAdapter.transformResponse(res)).toBe(res)
    expect(
      kimiCodeAdapter.parseUsageHeaders(new Headers({ 'x-ratelimit': '1' })),
    ).toBeNull()
    expect(kimiCodeAdapter.classifyError(429)).toBe('account')
    expect(kimiCodeAdapter.classifyError(401)).toBe('auth')
  })

  test('fetchUsage polls the deployment /usages with the pooled key', async () => {
    const urls: string[] = []
    respond = (url) => {
      urls.push(url)
      return json(LIVE)
    }
    const account = testAccount({
      providerID: 'kimi-code-plan-global',
      access: 'sk-kimi-g',
    })
    const snap = await kimiCodeGlobalAdapter.fetchUsage(account, 7)
    expect(snap?.weekly?.utilization).toBe(0.171279)
    expect(snap?.capturedAt).toBe(7)
    expect(urls).toEqual(['https://api.kimi.ai/coding/v1/usages'])
    respond = () => new Response('down', { status: 503 })
    expect(await kimiCodeGlobalAdapter.fetchUsage(account, 7)).toBeNull()
  })
})
