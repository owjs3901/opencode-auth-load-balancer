import { afterEach, describe, expect, test } from 'bun:test'

import { DEFAULT_OPUS_FALLBACK_MODEL } from '../providers/anthropic/constants'
import {
  downgradeModel,
  planProactiveFallback,
  planReactiveFallback,
  resolveFallbackModel,
} from '../providers/anthropic/fallback'
import { testAccount } from './fixtures/account'

const ENV = 'OPENCODE_AUTH_LB_ANTHROPIC_OPUS_FALLBACK_MODEL'
const OPUS = 'claude-opus-4-7'
const DAY = 24 * 60 * 60 * 1000

// The module memoizes the resolved model keyed by the raw env value, so simply
// restoring the env between tests forces a cache miss (raw `undefined` ≠ any
// test's value) on the next call — no explicit cache reset needed.
afterEach(() => {
  delete process.env[ENV]
})

function opusBody(model = OPUS): string {
  return JSON.stringify({ model, messages: [] })
}

function res(headers: Record<string, string>): Response {
  return new Response('', { status: 429, headers })
}

describe('resolveFallbackModel', () => {
  test('unset env → the built-in Sonnet default (feature ON)', () => {
    expect(resolveFallbackModel()).toBe(DEFAULT_OPUS_FALLBACK_MODEL)
    // Second call with the same (unset) raw exercises the cache-hit return.
    expect(resolveFallbackModel()).toBe(DEFAULT_OPUS_FALLBACK_MODEL)
  })

  test('empty / whitespace-only env → null (feature DISABLED)', () => {
    process.env[ENV] = ''
    expect(resolveFallbackModel()).toBeNull()
    process.env[ENV] = '   '
    expect(resolveFallbackModel()).toBeNull()
  })

  test('explicit env → that (trimmed) model id', () => {
    process.env[ENV] = '  claude-sonnet-4-5-20250929  '
    expect(resolveFallbackModel()).toBe('claude-sonnet-4-5-20250929')
  })
})

describe('downgradeModel', () => {
  test('disabled (empty env) → null even for an Opus body', () => {
    process.env[ENV] = ''
    expect(downgradeModel(opusBody())).toBeNull()
  })

  test('non-JSON body → null (parse guard)', () => {
    expect(downgradeModel('not json {{')).toBeNull()
  })

  test('missing or non-string model → null', () => {
    expect(downgradeModel(JSON.stringify({ messages: [] }))).toBeNull()
    expect(downgradeModel(JSON.stringify({ model: 123 }))).toBeNull()
  })

  test('non-Opus model is left alone → null', () => {
    expect(downgradeModel(opusBody('claude-sonnet-4-6'))).toBeNull()
  })

  test('model already equal to the fallback → null (no self-rewrite)', () => {
    // Fallback set to an Opus id so the `/opus/i` test passes AND from===fallback.
    process.env[ENV] = OPUS
    expect(downgradeModel(opusBody(OPUS))).toBeNull()
  })

  test('Opus body → rewritten to the fallback, reporting from/to', () => {
    const out = downgradeModel(opusBody())
    expect(out).not.toBeNull()
    expect(out?.fromModel).toBe(OPUS)
    expect(out?.toModel).toBe(DEFAULT_OPUS_FALLBACK_MODEL)
    expect((JSON.parse(out!.body) as { model: string }).model).toBe(
      DEFAULT_OPUS_FALLBACK_MODEL,
    )
    // Other fields are preserved through the round-trip.
    expect((JSON.parse(out!.body) as { messages: unknown[] }).messages).toEqual(
      [],
    )
  })
})

describe('planProactiveFallback', () => {
  test('not exhausted (opusCooldownUntil absent / 0 / past) → null', () => {
    const now = Date.now()
    expect(planProactiveFallback(opusBody(), testAccount(), now)).toBeNull()
    expect(
      planProactiveFallback(
        opusBody(),
        testAccount({ opusCooldownUntil: 0 }),
        now,
      ),
    ).toBeNull()
    expect(
      planProactiveFallback(
        opusBody(),
        testAccount({ opusCooldownUntil: now - 1000 }),
        now,
      ),
    ).toBeNull()
  })

  test('known-exhausted Opus tier → downgrades the model up front', () => {
    const now = Date.now()
    const out = planProactiveFallback(
      opusBody(),
      testAccount({ opusCooldownUntil: now + DAY }),
      now,
    )
    expect(out?.toModel).toBe(DEFAULT_OPUS_FALLBACK_MODEL)
  })
})

describe('planReactiveFallback', () => {
  test('a 429 without the seven_day_opus claim → null (normal rotation)', () => {
    const now = Date.now()
    expect(planReactiveFallback(res({}), opusBody(), now)).toBeNull()
    expect(
      planReactiveFallback(
        res({
          'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        }),
        opusBody(),
        now,
      ),
    ).toBeNull()
  })

  test('Opus claim but a non-Opus body → null (nothing to downgrade)', () => {
    const now = Date.now()
    expect(
      planReactiveFallback(
        res({
          'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
        }),
        opusBody('claude-sonnet-4-6'),
        now,
      ),
    ).toBeNull()
  })

  test('Opus claim + a valid reset header → downgraded body + parsed resetAt', () => {
    const now = Date.now()
    const resetAtSec = Math.floor((now + 2 * DAY) / 1000)
    const out = planReactiveFallback(
      res({
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
        'anthropic-ratelimit-unified-reset': String(resetAtSec),
      }),
      opusBody(),
      now,
    )
    expect(out?.fallback.toModel).toBe(DEFAULT_OPUS_FALLBACK_MODEL)
    // Seconds → ms, within the header's 1 s truncation.
    expect(out?.resetAt).toBeGreaterThanOrEqual(now + 2 * DAY - 2000)
    expect(out?.resetAt).toBeLessThanOrEqual(now + 2 * DAY + 2000)
  })

  test('a missing reset header falls back to a short (~1 h) Opus cooldown', () => {
    const now = Date.now()
    const out = planReactiveFallback(
      res({
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
      }),
      opusBody(),
      now,
    )
    expect(out?.resetAt).toBeGreaterThanOrEqual(now + 60 * 60 * 1000 - 2000)
    expect(out?.resetAt).toBeLessThanOrEqual(now + 60 * 60 * 1000 + 2000)
  })

  test('an absurd (beyond-8-day) reset is rejected → short default', () => {
    const now = Date.now()
    const out = planReactiveFallback(
      res({
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
        'anthropic-ratelimit-unified-reset': String(
          Math.floor((now + 30 * DAY) / 1000),
        ),
      }),
      opusBody(),
      now,
    )
    // Falls through to the 1 h default rather than sidelining Opus for a month.
    expect(out?.resetAt).toBeLessThanOrEqual(now + 60 * 60 * 1000 + 2000)
  })
})
