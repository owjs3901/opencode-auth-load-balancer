import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  authorize as aAuthorize,
  exchange as aExchange,
  refresh as aRefresh,
} from '../providers/anthropic/oauth'
import {
  fetchUsage as aFetchUsage,
  parseUsageHeaders as aParse,
} from '../providers/anthropic/usage'
import {
  authorize as oAuthorize,
  exchange as oExchange,
  refresh as oRefresh,
} from '../providers/openai/oauth'
import {
  fetchUsage as oFetchUsage,
  parseUsageHeaders as oParse,
} from '../providers/openai/usage'
import type { PoolAccount } from '../types'

type Responder = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>

const realFetch = globalThis.fetch
let respond: Responder

beforeEach(() => {
  respond = () => new Response('{}', { status: 200 })
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url
    return Promise.resolve(respond(url, init))
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

function acct(providerID: string, accountId: string | null): PoolAccount {
  return {
    id: 'x',
    providerID,
    label: 'x',
    access: 'tok',
    refresh: 'r',
    expires: 0,
    accountId,
    usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: 0,
    lastUsedAt: 0,
  }
}

const SEC = (offsetSec: number) =>
  String(Math.floor(Date.now() / 1000) + offsetSec)

describe('anthropic oauth', () => {
  test('authorize builds max and console PKCE urls', async () => {
    expect((await aAuthorize('max')).url).toContain('claude.ai/oauth/authorize')
    const c = await aAuthorize('console')
    expect(c.url).toContain('platform.claude.com/oauth/authorize')
    expect(c.url).toContain('code_challenge=')
    expect(c.verifier).toBeTruthy()
  })

  test('exchange returns tokens for a valid callback url', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    const tok = await aExchange(
      'https://cb?code=C&state=S',
      'ver',
      'https://cb',
      'S',
    )
    expect(tok?.access).toBe('a')
    expect(tok?.refresh).toBe('r')
    expect(tok?.expires).toBeGreaterThan(Date.now())
  })

  test('exchange parses code#state and key=value formats', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 1,
        }),
        { status: 200 },
      )
    expect(await aExchange('C#S', 'v', 'cb', 'S')).not.toBeNull()
    expect(await aExchange('code=C2&state=S', 'v', 'cb', 'S')).not.toBeNull()
  })

  test('exchange returns null on unparsable input, state mismatch, and non-ok', async () => {
    expect(await aExchange('garbage', 'v', 'cb', 'S')).toBeNull()
    expect(
      await aExchange('https://cb?code=C&state=X', 'v', 'cb', 'S'),
    ).toBeNull()
    respond = () => new Response('nope', { status: 400 })
    expect(
      await aExchange('https://cb?code=C&state=S', 'v', 'cb', 'S'),
    ).toBeNull()
  })

  test('refresh returns rotated tokens and throws on non-ok', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          access_token: 'a2',
          refresh_token: 'r2',
          expires_in: 3600,
        }),
        { status: 200 },
      )
    expect((await aRefresh('r1')).refresh).toBe('r2')
    respond = () => new Response('bad', { status: 401 })
    await expect(aRefresh('r1')).rejects.toThrow('401')
  })
})

describe('anthropic usage', () => {
  test('parseUsageHeaders maps windows + status variants', () => {
    const h = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-5h-reset': SEC(3600),
      'anthropic-ratelimit-unified-7d-utilization': '0.50',
      'anthropic-ratelimit-unified-7d-reset': SEC(86400),
      'anthropic-ratelimit-unified-status': 'allowed_warning',
    })
    const u = aParse(h, 1000)
    expect(u?.hourly?.utilization).toBeCloseTo(0.1, 5)
    expect(u?.weekly?.utilization).toBeCloseTo(0.5, 5)
    expect(u?.status).toBe('warning')
    expect(
      aParse(
        new Headers({ 'anthropic-ratelimit-unified-status': 'allowed' }),
        0,
      )?.status,
    ).toBe('allowed')
    expect(
      aParse(
        new Headers({ 'anthropic-ratelimit-unified-status': 'rejected' }),
        0,
      )?.status,
    ).toBe('rejected')
  })

  test('parseUsageHeaders: null when absent, ignores NaN, zero reset when missing', () => {
    expect(aParse(new Headers(), 0)).toBeNull()
    const bad = aParse(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': 'abc',
        'anthropic-ratelimit-unified-status': 'allowed',
      }),
      0,
    )
    expect(bad?.hourly).toBeUndefined()
    expect(
      aParse(
        new Headers({ 'anthropic-ratelimit-unified-7d-utilization': '0.3' }),
        0,
      )?.weekly?.resetAt,
    ).toBe(0)
  })

  test('fetchUsage maps percent and decodes ISO + epoch-seconds resets', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 35, resets_at: '2030-01-01T00:00:00Z' },
          seven_day: { utilization: 14, resets_at: 1900000000 },
        }),
        { status: 200 },
      )
    const u = await aFetchUsage(acct('anthropic', null), 0)
    expect(u?.hourly?.utilization).toBeCloseTo(0.35, 5)
    expect(u?.weekly?.utilization).toBeCloseTo(0.14, 5)
    expect(u?.hourly?.resetAt).toBe(Date.parse('2030-01-01T00:00:00Z'))
    expect(u?.weekly?.resetAt).toBe(1900000000 * 1000)
  })

  test('fetchUsage decodes epoch-ms, numeric-string, invalid-string, and null window', async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: 1900000000000 },
          seven_day: { utilization: 20, resets_at: '1900000000' },
        }),
        { status: 200 },
      )
    let u = await aFetchUsage(acct('anthropic', null), 0)
    expect(u?.hourly?.resetAt).toBe(1900000000000)
    expect(u?.weekly?.resetAt).toBe(1900000000 * 1000)

    respond = () =>
      new Response(
        JSON.stringify({
          five_hour: null,
          seven_day: { utilization: 5, resets_at: 'not-a-date' },
        }),
        { status: 200 },
      )
    u = await aFetchUsage(acct('anthropic', null), 0)
    expect(u?.hourly).toBeNull()
    expect(u?.weekly?.resetAt).toBe(0)
  })

  test('fetchUsage returns null on non-ok, throw, and invalid JSON', async () => {
    respond = () => new Response('x', { status: 429 })
    expect(await aFetchUsage(acct('anthropic', null), 0)).toBeNull()
    respond = () => {
      throw new Error('net')
    }
    expect(await aFetchUsage(acct('anthropic', null), 0)).toBeNull()
    respond = () => new Response('notjson', { status: 200 })
    expect(await aFetchUsage(acct('anthropic', null), 0)).toBeNull()
  })
})

describe('openai oauth', () => {
  test('authorize builds an auth.openai.com PKCE url', async () => {
    const a = await oAuthorize()
    expect(a.url).toContain('auth.openai.com/oauth/authorize')
    expect(a.url).toContain('codex_cli_simplified_flow=true')
  })

  test('exchange returns tokens + account id from id_token', async () => {
    const idToken = `h.${Buffer.from(JSON.stringify({ chatgpt_account_id: 'acc_9' })).toString('base64url')}.s`
    respond = () =>
      new Response(
        JSON.stringify({
          access_token: 'a',
          refresh_token: 'r',
          id_token: idToken,
          expires_in: 3600,
        }),
        { status: 200 },
      )
    const tok = await oExchange(
      'https://cb?code=C&state=S',
      'v',
      'https://cb',
      'S',
    )
    expect(tok?.access).toBe('a')
    expect(tok?.accountId).toBe('acc_9')
  })

  test('exchange returns null on bad input and non-ok', async () => {
    expect(await oExchange('garbage', 'v', 'cb', 'S')).toBeNull()
    respond = () => new Response('x', { status: 400 })
    expect(
      await oExchange('https://cb?code=C&state=S', 'v', 'cb', 'S'),
    ).toBeNull()
  })

  test('refresh keeps the previous refresh token when the server omits one', async () => {
    respond = () =>
      new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }), {
        status: 200,
      })
    const tok = await oRefresh('r1')
    expect(tok.access).toBe('a2')
    expect(tok.refresh).toBe('r1')
    respond = () => new Response('bad', { status: 401 })
    await expect(oRefresh('r1')).rejects.toThrow('401')
  })
})

describe('openai usage', () => {
  test('parseUsageHeaders maps x-codex headers', () => {
    const h = new Headers({
      'x-codex-primary-used-percent': '12.5',
      'x-codex-primary-reset-at': '1900000000',
      'x-codex-secondary-used-percent': '40',
      'x-codex-secondary-reset-at': '1900000000',
    })
    const u = oParse(h, 0)
    expect(u?.hourly?.utilization).toBeCloseTo(0.125, 5)
    expect(u?.weekly?.utilization).toBeCloseTo(0.4, 5)
  })

  test('parseUsageHeaders: null when absent, NaN ignored, zero reset when missing', () => {
    expect(oParse(new Headers(), 0)).toBeNull()
    expect(
      oParse(new Headers({ 'x-codex-primary-used-percent': 'abc' }), 0)?.hourly,
    ).toBeUndefined()
    expect(
      oParse(new Headers({ 'x-codex-secondary-used-percent': '5' }), 0)?.weekly
        ?.resetAt,
    ).toBe(0)
  })

  test('fetchUsage maps primary/secondary and sends the account header', async () => {
    let seen: RequestInit | undefined
    respond = (_u, init) => {
      seen = init
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12, reset_at: 1900000000 },
            secondary_window: { used_percent: 40, reset_at: 1900000000 },
          },
        }),
        { status: 200 },
      )
    }
    const u = await oFetchUsage(acct('openai', 'acc_9'), 0)
    expect(u?.hourly?.utilization).toBeCloseTo(0.12, 5)
    expect(u?.weekly?.utilization).toBeCloseTo(0.4, 5)
    expect(
      (seen?.headers as Record<string, string> | undefined)?.[
        'chatgpt-account-id'
      ],
    ).toBe('acc_9')
  })

  test('fetchUsage omits the account header without an id and handles null windows', async () => {
    let seen: RequestInit | undefined
    respond = (_u, init) => {
      seen = init
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: null,
            secondary_window: { reset_at: 1 },
          },
        }),
        { status: 200 },
      )
    }
    const u = await oFetchUsage(acct('openai', null), 0)
    expect(
      (seen?.headers as Record<string, string> | undefined)?.[
        'chatgpt-account-id'
      ],
    ).toBeUndefined()
    expect(u?.hourly).toBeNull()
    expect(u?.weekly).toBeNull()
  })

  test('fetchUsage returns null on non-ok, throw, and missing rate_limit', async () => {
    respond = () => new Response('x', { status: 500 })
    expect(await oFetchUsage(acct('openai', 'a'), 0)).toBeNull()
    respond = () => {
      throw new Error('net')
    }
    expect(await oFetchUsage(acct('openai', 'a'), 0)).toBeNull()
    respond = () => new Response(JSON.stringify({}), { status: 200 })
    expect(await oFetchUsage(acct('openai', 'a'), 0)).toBeNull()
    respond = () => new Response('notjson', { status: 200 })
    expect(await oFetchUsage(acct('openai', 'a'), 0)).toBeNull()
  })
})
