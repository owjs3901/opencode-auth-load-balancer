import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  kimiCodeAdapter,
  kimiCodeGlobalAdapter,
} from '../providers/kimi/adapter'
import { tokensFromApiKey } from '../providers/kimi/key'
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

  test('exchange checks the pasted key against /usages before pooling it', async () => {
    const seen: { url: string; auth: string | null }[] = []
    respond = (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      return json(LIVE)
    }
    const tokens = await kimiCodeAdapter.exchange('  sk-kimi-abc  ', '', '', '')
    expect(tokens).toEqual(tokensFromApiKey('sk-kimi-abc'))
    expect(tokens).toMatchObject({
      access: 'sk-kimi-abc',
      refresh: '',
      expires: Number.MAX_SAFE_INTEGER,
    })
    expect(seen).toEqual([
      {
        url: 'https://api.kimi.com/coding/v1/usages',
        auth: 'Bearer sk-kimi-abc',
      },
    ])
    await kimiCodeGlobalAdapter.exchange('sk-kimi-abc', '', '', '')
    expect(seen[1]?.url).toBe('https://api.kimi.ai/coding/v1/usages')
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

  test('refresh fails as invalid_grant, so a corrupted row is parked for re-login', async () => {
    await expect(kimiCodeAdapter.refresh('')).rejects.toThrow('invalid_grant')
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
