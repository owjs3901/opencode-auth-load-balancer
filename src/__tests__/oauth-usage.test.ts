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

  test('refresh keeps the previous refresh token when the server omits one', async () => {
    // RFC 6749 §5.1: the authorization server MAY omit a rotated refresh_token.
    // Pre-fix, the Anthropic helper blindly assigned json.refresh_token, so a
    // 200 response without the field wrote `undefined` onto the live
    // PoolAccount; mutatePool then persisted it, and the next refresh shipped
    // a body missing refresh_token entirely, getting 400/invalid_grant and
    // permanently sidelining the account (disabledReason: 're-login required').
    // Symmetric with the OpenAI test of the same name.
    respond = () =>
      new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }), {
        status: 200,
      })
    const tok = await aRefresh('r1')
    expect(tok.access).toBe('a2')
    expect(tok.refresh).toBe('r1')
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

  test('parseUsageHeaders: falls back to zero resetAt when seconds-times-1000 overflows', () => {
    // Regression lock symmetric with applyCooldown's `1e308` retry-after test
    // (plugin.test.ts:363). `Number('1e308') = 1e308` is finite, but
    // `1e308 * 1000` exceeds Number.MAX_VALUE (~1.798e308) and collapses to
    // +Infinity. Pre-fix the inner `window()` helper committed `Infinity` to
    // pool.usage.{hourly,weekly}.resetAt, which then silently broke
    // isWindowExpired (never expires), weeklyUrgency (Infinity → 0 score,
    // permanently sidelining the account), and relTime rendering
    // ('InfinitydNaNh' in the TUI / CLI / auth_lb_status tool).
    const u = aParse(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.10',
        'anthropic-ratelimit-unified-5h-reset': '1e308',
        'anthropic-ratelimit-unified-7d-utilization': '0.50',
        'anthropic-ratelimit-unified-7d-reset': '1e308',
      }),
      0,
    )
    expect(u?.hourly?.resetAt).toBe(0)
    expect(u?.weekly?.resetAt).toBe(0)
    expect(Number.isFinite(u?.hourly?.resetAt ?? Infinity)).toBe(true)
    expect(Number.isFinite(u?.weekly?.resetAt ?? Infinity)).toBe(true)
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

  test('fetchUsage falls back to zero resetAt when endpoint resets_at is non-finite (JSON Infinity)', async () => {
    // Regression lock symmetric with the OpenAI endpoint reset_at overflow test
    // below (~line 490), the Anthropic parseUsageHeaders overflow test (~line
    // 200), and the applyCooldown 1e308 retry-after test (plugin.test.ts:363).
    // `JSON.parse('1e500')` yields Infinity in V8/Bun; pre-fix the number
    // branch of parseResetAt short-circuited the ms-vs-seconds heuristic
    // (`Infinity > 1e12` is true) and committed Infinity to
    // pool.usage.{hourly,weekly}.resetAt, silently breaking isWindowExpired
    // (Infinity never <= now), weeklyUrgency (drainable / Infinity = 0 → the
    // account sinks to 0 urgency forever), and relTime rendering until the
    // next disk roundtrip (JSON.stringify(Infinity) === 'null' caps the
    // on-disk blast radius, but the live in-memory snapshot stays corrupt).
    //
    // The body is a RAW JSON string, NOT JSON.stringify of a JS object:
    // `JSON.stringify({ resets_at: 1e500 })` collapses Infinity to `null`
    // (Infinity isn't valid JSON), which would land in the existing
    // string/Date.parse branch and miss the regression entirely — same trick
    // the OpenAI overflow test (~line 469) uses, for the same reason.
    respond = () =>
      new Response(
        '{"five_hour":{"utilization":10,"resets_at":1e500},"seven_day":{"utilization":20,"resets_at":1e500}}',
        { status: 200 },
      )
    const u = await aFetchUsage(acct('anthropic', null), 0)
    expect(u?.hourly?.resetAt).toBe(0)
    expect(u?.weekly?.resetAt).toBe(0)
    expect(Number.isFinite(u?.hourly?.resetAt ?? Infinity)).toBe(true)
    expect(Number.isFinite(u?.weekly?.resetAt ?? Infinity)).toBe(true)
  })

  test('fetchUsage rejects endpoint windows with missing or non-finite utilization', async () => {
    // Missing utilization (undefined after JSON.parse): the pre-fix code
    // silently produced { utilization: 0 } and the scheduler then ranked the
    // account as having full headroom. Symmetric with parseUsageHeaders() and
    // the OpenAI endpoint helper, the window must be rejected as null.
    respond = () =>
      new Response(
        JSON.stringify({
          five_hour: { resets_at: '2030-01-01T00:00:00Z' },
          seven_day: null,
        }),
        { status: 200 },
      )
    let u = await aFetchUsage(acct('anthropic', null), 0)
    expect(u?.hourly).toBeNull()
    expect(u?.weekly).toBeNull()

    // Non-number utilization (string) — same outcome.
    respond = () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: '50%', resets_at: 1900000000 },
          seven_day: { utilization: null, resets_at: 1900000000 },
        }),
        { status: 200 },
      )
    u = await aFetchUsage(acct('anthropic', null), 0)
    expect(u?.hourly).toBeNull()
    expect(u?.weekly).toBeNull()
  })

  test('fetchUsage treats resets_at:null as "no reset" (regression: parseResetAt(null) used to throw)', async () => {
    // Regression lock: pre-fix, parseResetAt(null) hit `value.trim()` and threw
    // TypeError ("Cannot read properties of null (reading 'trim')") because
    // Number(null) === 0 is finite and the `&& value.trim() !== ''` guard
    // executed null.trim(). The throw escaped endpointWindow → fetchUsage and
    // was silenced by refreshUsageInBackground's outer try/catch — silently
    // dropping the entire usage snapshot for the poll. Symmetric with the
    // OpenAI sibling endpointWindow (openai/usage.ts:90), which defaults any
    // non-number reset_at to 0. Note the propagation amplifier: in fetchUsage
    // `hourly: endpointWindow(json.five_hour)` runs BEFORE the weekly call in
    // the return object literal, so a single null on the 5h side previously
    // took the 7d snapshot with it (the second call never ran).
    respond = () =>
      new Response(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: null },
          seven_day: { utilization: 20, resets_at: null },
        }),
        { status: 200 },
      )
    const u = await aFetchUsage(acct('anthropic', null), 0)
    expect(u?.hourly?.utilization).toBeCloseTo(0.1, 5)
    expect(u?.hourly?.resetAt).toBe(0)
    expect(u?.weekly?.utilization).toBeCloseTo(0.2, 5)
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

  test('fetchUsage bounds the usage poll with an AbortSignal (no socket leak on a hung server)', async () => {
    // Regression lock symmetric with the OpenAI fetchUsage signal test below.
    // `fetchUsage` is invoked fire-and-forget by refreshUsageInBackground from
    // (a) auth.loader startup seeding and (b) every request via fetch.ts. The
    // `lastPoll` per-account throttle prevents same-account re-poll within
    // SEED_TTL_MS but does NOT cancel an in-flight hung fetch. Without an
    // AbortSignal, a TCP-black-holed /api/oauth/usage holds a socket open
    // until the OS keepalive eventually closes it (Linux default ≈ 2 h), and
    // on EVERY new lastPoll window the call is re-attempted → hung fetches
    // accumulate per account over a sustained upstream stall. Symmetric with
    // the OAUTH_HTTP_TIMEOUT_MS bound already on exchange/refresh.
    let seen: RequestInit | undefined
    respond = (_u, init) => {
      seen = init
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 10, resets_at: 1900000000 },
          seven_day: { utilization: 20, resets_at: 1900000000 },
        }),
        { status: 200 },
      )
    }
    await aFetchUsage(acct('anthropic', null), 0)
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
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

  test('parseUsageHeaders: falls back to zero resetAt when seconds-times-1000 overflows', () => {
    // Regression lock symmetric with applyCooldown's `1e308` retry-after test
    // (plugin.test.ts:363) and the Anthropic header overflow test above:
    // `windowFromPercent` must reject a reset value whose seconds form is finite
    // but whose *1000 overflows to +Infinity, so the pool never stores Infinity.
    const u = oParse(
      new Headers({
        'x-codex-primary-used-percent': '12.5',
        'x-codex-primary-reset-at': '1e308',
        'x-codex-secondary-used-percent': '40',
        'x-codex-secondary-reset-at': '1e308',
      }),
      0,
    )
    expect(u?.hourly?.resetAt).toBe(0)
    expect(u?.weekly?.resetAt).toBe(0)
    expect(Number.isFinite(u?.hourly?.resetAt ?? Infinity)).toBe(true)
    expect(Number.isFinite(u?.weekly?.resetAt ?? Infinity)).toBe(true)
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

  test('fetchUsage rejects endpoint windows with non-finite used_percent', async () => {
    // Regression lock: pre-fix, `typeof w.used_percent !== 'number'` alone let
    // Infinity / -Infinity through (JSON.parse('1e500') === Infinity in V8/Bun),
    // then clamp01(Infinity/100) collapsed to 0 — the scheduler then ranked
    // the malformed account as having FULL headroom and selected it first.
    // The OpenAI endpoint helper must enforce the same Number.isFinite gate
    // that parseUsageHeaders() / windowFromPercent and the Anthropic endpoint
    // helper already do (and that the comment on the Anthropic test
    // explicitly claims is symmetric across the three).
    //
    // The body is a RAW JSON string, not JSON.stringify of a JS object:
    // `JSON.stringify({ used_percent: 1e500 })` collapses Infinity to `null`
    // (Infinity isn't valid JSON), which would land in the existing
    // `typeof !== 'number'` branch — the pre-fix code. Only `response.json()`
    // parsing a literal `1e500` reproduces the Infinity input shape that
    // escapes the typeof check.
    respond = () =>
      new Response(
        '{"rate_limit":{"primary_window":{"used_percent":1e500,"reset_at":1900000000},"secondary_window":{"used_percent":-1e500,"reset_at":1900000000}}}',
        { status: 200 },
      )
    const u = await oFetchUsage(acct('openai', 'a'), 0)
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

  test('fetchUsage falls back to zero resetAt when endpoint reset_at overflows on *1000', async () => {
    // Regression lock symmetric with applyCooldown's `1e308` retry-after test
    // (plugin.test.ts:363) and the two header-helper tests above. The endpoint
    // helper applied `resetSec * 1000` without re-checking finiteness, so a
    // JSON `reset_at: 1e308` (finite as a number, but its *1000 overflows)
    // landed on the pool as `Infinity` — same scheduler corruption.
    respond = () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12, reset_at: 1e308 },
            secondary_window: { used_percent: 40, reset_at: 1e308 },
          },
        }),
        { status: 200 },
      )
    const u = await oFetchUsage(acct('openai', 'a'), 0)
    expect(u?.hourly?.resetAt).toBe(0)
    expect(u?.weekly?.resetAt).toBe(0)
    expect(Number.isFinite(u?.hourly?.resetAt ?? Infinity)).toBe(true)
    expect(Number.isFinite(u?.weekly?.resetAt ?? Infinity)).toBe(true)
  })

  test('fetchUsage bounds the usage poll with an AbortSignal (no socket leak on a hung server)', async () => {
    // Regression lock symmetric with the Anthropic fetchUsage signal test above.
    // `fetchUsage` is invoked fire-and-forget by refreshUsageInBackground from
    // (a) auth.loader startup seeding and (b) every request via fetch.ts. The
    // `lastPoll` per-account throttle prevents same-account re-poll within
    // SEED_TTL_MS but does NOT cancel an in-flight hung fetch. Without an
    // AbortSignal, a TCP-black-holed /wham/usage holds a socket open until the
    // OS keepalive eventually closes it (Linux default ≈ 2 h), and on EVERY
    // new lastPoll window the call is re-attempted → hung fetches accumulate
    // per account over a sustained upstream stall. Symmetric with the
    // OAUTH_HTTP_TIMEOUT_MS bound already on exchange/refresh.
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
    await oFetchUsage(acct('openai', 'acc_9'), 0)
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
  })
})
