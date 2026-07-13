import { afterEach, describe, expect, test } from 'bun:test'

import { DEFAULT_OPUS_FALLBACK_MODEL } from '../providers/anthropic/constants'
import {
  downgradeModel,
  modelFamily,
  planReactiveFallback,
  requestModelTier,
  resolveFallbackSetting,
  resolveFamilyOrder,
} from '../providers/anthropic/fallback'

const ENV = 'OPENCODE_AUTH_LB_ANTHROPIC_OPUS_FALLBACK_MODEL'
const ORDER_ENV = 'OPENCODE_AUTH_LB_ANTHROPIC_FAMILY_ORDER'
const OPUS = 'claude-opus-4-7'
const FABLE = 'claude-fable-5'
const DAY = 24 * 60 * 60 * 1000

/** A representative provider catalog for ladder tests. */
const CATALOG = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-9',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]

// The module memoizes resolved settings keyed by the raw env value, so simply
// restoring the env between tests forces a cache miss (raw `undefined` ≠ any
// test's value) on the next call — no explicit cache reset needed.
afterEach(() => {
  delete process.env[ENV]
  delete process.env[ORDER_ENV]
})

function body(model: unknown = OPUS): string {
  return JSON.stringify({ model, messages: [] })
}

function res(headers: Record<string, string>): Response {
  return new Response('', { status: 429, headers })
}

describe('modelFamily', () => {
  test('extracts the first alphabetic segment after the vendor prefix', () => {
    expect(modelFamily('claude-opus-4-7')).toBe('opus')
    expect(modelFamily('claude-fable-5')).toBe('fable')
    expect(modelFamily('claude-sonnet-4-6')).toBe('sonnet')
    // Old-style ids put the version BEFORE the family.
    expect(modelFamily('claude-3-5-sonnet-latest')).toBe('sonnet')
    // Case-insensitive (defensive against hand-configured ids).
    expect(modelFamily('Claude-Opus-4')).toBe('opus')
  })

  test('no alphabetic family segment → null (never participates in tier logic)', () => {
    expect(modelFamily('claude-3-5')).toBeNull()
    expect(modelFamily('claude')).toBeNull()
  })

  test('non-first-party ids never participate in tier logic', () => {
    expect(modelFamily('gpt-4-turbo')).toBeNull()
    expect(modelFamily('gemini-1-5-pro')).toBeNull()
  })
})

describe('requestModelTier', () => {
  test('reads the tier from a JSON body', () => {
    expect(requestModelTier(body(FABLE))).toBe('fable')
    expect(requestModelTier(body(OPUS))).toBe('opus')
  })

  test('non-JSON / missing / non-string / family-less model → null', () => {
    expect(requestModelTier('not json {{')).toBeNull()
    expect(requestModelTier(JSON.stringify({ messages: [] }))).toBeNull()
    expect(requestModelTier(body(123))).toBeNull()
    expect(requestModelTier(body('claude-3-5'))).toBeNull()
  })
})

describe('resolveFamilyOrder', () => {
  test('unset env → the built-in best→worst default', () => {
    expect(resolveFamilyOrder()).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    // Second call with the same (unset) raw exercises the cache-hit return.
    expect(resolveFamilyOrder()).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })

  test('custom env → trimmed, lowercased, empties dropped; blank env → default', () => {
    process.env[ORDER_ENV] = ' Myth , fable ,, opus '
    expect(resolveFamilyOrder()).toEqual(['myth', 'fable', 'opus'])
    process.env[ORDER_ENV] = '  '
    expect(resolveFamilyOrder()).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})

describe('resolveFallbackSetting', () => {
  test('unset env → ladder mode (feature ON)', () => {
    expect(resolveFallbackSetting()).toEqual({ kind: 'ladder' })
    // Second call with the same (unset) raw exercises the cache-hit return.
    expect(resolveFallbackSetting()).toEqual({ kind: 'ladder' })
  })

  test('empty / whitespace-only env → disabled', () => {
    process.env[ENV] = ''
    expect(resolveFallbackSetting()).toEqual({ kind: 'disabled' })
    process.env[ENV] = '   '
    expect(resolveFallbackSetting()).toEqual({ kind: 'disabled' })
  })

  test('explicit env → that (trimmed) model id, pinned', () => {
    process.env[ENV] = '  claude-sonnet-4-5-20250929  '
    expect(resolveFallbackSetting()).toEqual({
      kind: 'pinned',
      model: 'claude-sonnet-4-5-20250929',
    })
  })
})

describe('downgradeModel', () => {
  test('disabled (empty env) → null even for a premium-tier body', () => {
    process.env[ENV] = ''
    expect(downgradeModel(body(), CATALOG)).toBeNull()
  })

  test('non-JSON body → null (parse guard)', () => {
    expect(downgradeModel('not json {{', CATALOG)).toBeNull()
  })

  test('missing or non-string model → null', () => {
    expect(downgradeModel(JSON.stringify({ messages: [] }), CATALOG)).toBeNull()
    expect(downgradeModel(body(123), CATALOG)).toBeNull()
  })

  test('family-less model → null (unknown ids never downgrade)', () => {
    expect(downgradeModel(body('claude-3-5'), CATALOG)).toBeNull()
  })

  test('ladder: a capped Fable body is rewritten to the best Opus (the user-visible headline)', () => {
    const out = downgradeModel(body(FABLE), CATALOG)
    expect(out?.fromModel).toBe(FABLE)
    expect(out?.toModel).toBe('claude-opus-4-9')
    // The triggering tier is threaded through for notify.ts's de-dupe key.
    expect(out?.fromTier).toBe('fable')
    expect((JSON.parse(out!.body) as { model: string }).model).toBe(
      'claude-opus-4-9',
    )
    // Other fields are preserved through the round-trip.
    expect((JSON.parse(out!.body) as { messages: unknown[] }).messages).toEqual(
      [],
    )
  })

  test('ladder: a capped Opus body descends to Sonnet', () => {
    expect(downgradeModel(body(OPUS), CATALOG)?.toModel).toBe(
      'claude-sonnet-4-6',
    )
  })

  test('version comparison handles old-style, dated, and an exactly-tied id', () => {
    // Old-style 3-5 loses to 4-6; the dated snapshot extends (and wins) a
    // tie against its undated alias; an EXACT version tie keeps the first
    // catalog entry (deterministic first-wins, like the scheduler's sorts).
    const catalog = [
      'claude-3-5-sonnet-latest',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6-20260101',
      'claude-4-6-sonnet-20260101', // same [4,6,20260101] vector — tie
    ]
    expect(downgradeModel(body(OPUS), catalog)?.toModel).toBe(
      'claude-sonnet-4-6-20260101',
    )
  })

  test('a bare-major dated id never outranks a sibling with a real minor version', () => {
    // `claude-opus-4-20250514` (no minor) and `claude-opus-4-1-20250805`
    // (minor `1`) both have a dated snapshot at major version 4 — the date
    // must never be compared as if it were the minor-version digit, or the
    // undated-minor "4.0" release would incorrectly outrank "4.1".
    const catalog = [
      'claude-fable-5',
      'claude-opus-4-20250514',
      'claude-opus-4-1-20250805',
    ]
    expect(downgradeModel(body(FABLE), catalog)?.toModel).toBe(
      'claude-opus-4-1-20250805',
    )
  })

  test('EMPTY catalog degrades to the static last-resort default (Sonnet)', () => {
    expect(downgradeModel(body(OPUS), [])?.toModel).toBe(
      DEFAULT_OPUS_FALLBACK_MODEL,
    )
    // ...unless the body is already in the default's family — a same-tier
    // rewrite cannot escape that tier's cap.
    expect(downgradeModel(body('claude-sonnet-4-6'), [])).toBeNull()
    expect(downgradeModel(body('claude-3-5-sonnet-latest'), [])).toBeNull()
  })

  test('pinned override bypasses the ladder; a same-family pin → null', () => {
    process.env[ENV] = 'claude-sonnet-4-5-20250929'
    expect(downgradeModel(body(FABLE), CATALOG)?.toModel).toBe(
      'claude-sonnet-4-5-20250929',
    )
    // Pin in the Opus family blocks Opus bodies (cannot escape the capped tier).
    process.env[ENV] = OPUS
    expect(downgradeModel(body('claude-opus-4-1'), CATALOG)).toBeNull()
  })
})

describe('planReactiveFallback', () => {
  test('a 429 without a tier-scoped claim → null (normal rotation)', () => {
    const now = Date.now()
    expect(planReactiveFallback(res({}), body(), now, CATALOG)).toBeNull()
    // Bare account-wide claims are NOT tiers.
    for (const claim of ['seven_day', 'five_hour']) {
      expect(
        planReactiveFallback(
          res({ 'anthropic-ratelimit-unified-representative-claim': claim }),
          body(),
          now,
          CATALOG,
        ),
      ).toBeNull()
    }
  })

  test('a tier claim but a non-downgradable body → null (nothing to fall back to)', () => {
    // A Sonnet body with no lower catalog family: the ladder yields nothing
    // and the static default sits in the SAME family — no escape possible.
    const now = Date.now()
    expect(
      planReactiveFallback(
        res({
          'anthropic-ratelimit-unified-representative-claim':
            'seven_day_sonnet',
        }),
        body('claude-sonnet-4-6'),
        now,
        ['claude-sonnet-4-6'],
      ),
    ).toBeNull()
  })

  test.each([
    ['seven_day_fable', 'fable', FABLE, 'claude-opus-4-9'],
    ['seven_day_opus', 'opus', OPUS, 'claude-sonnet-4-6'],
    ['five_hour_opus', 'opus', OPUS, 'claude-sonnet-4-6'],
  ])(
    'claim %s + a valid reset header → tier "%s", ladder body, parsed resetAt',
    (claim, tier, model, target) => {
      const now = Date.now()
      const resetAtSec = Math.floor((now + 2 * DAY) / 1000)
      const out = planReactiveFallback(
        res({
          'anthropic-ratelimit-unified-representative-claim': claim,
          'anthropic-ratelimit-unified-reset': String(resetAtSec),
        }),
        body(model),
        now,
        CATALOG,
      )
      expect(out?.tier).toBe(tier)
      expect(out?.fallback.toModel).toBe(target)
      // Seconds → ms, within the header's 1 s truncation.
      expect(out?.resetAt).toBeGreaterThanOrEqual(now + 2 * DAY - 2000)
      expect(out?.resetAt).toBeLessThanOrEqual(now + 2 * DAY + 2000)
    },
  )

  test('a non-family claim suffix (overage_included) keys the cooldown by the REQUEST family, not the suffix', () => {
    // Anthropic emits `seven_day_overage_included` (the premium/overage bucket)
    // for a capped fable request. "overage_included" is NOT a model family, so
    // keying on it recorded a dead `modelCooldownsUntil.overage_included` that
    // the proactive skip (`modelCooldownsUntil[requestModelTier="fable"]`) could
    // never consult — the account kept receiving+429ing every fable request.
    // The key MUST be the request's own family ("fable"). Both windows.
    const now = Date.now()
    for (const claim of [
      'seven_day_overage_included',
      'five_hour_overage_included',
    ]) {
      const out = planReactiveFallback(
        res({
          'anthropic-ratelimit-unified-representative-claim': claim,
          'anthropic-ratelimit-unified-reset': String(
            Math.floor((now + 2 * DAY) / 1000),
          ),
        }),
        body(FABLE),
        now,
        CATALOG,
      )
      expect(out?.tier).toBe('fable') // request family, NOT "overage_included"
      expect(out?.fallback.toModel).toBe('claude-opus-4-9')
    }
  })

  test('a missing reset header falls back to a short (~1 h) tier cooldown', () => {
    const now = Date.now()
    const out = planReactiveFallback(
      res({
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
      }),
      body(),
      now,
      CATALOG,
    )
    expect(out?.tier).toBe('opus')
    expect(out?.resetAt).toBeGreaterThanOrEqual(now + 60 * 60 * 1000 - 2000)
    expect(out?.resetAt).toBeLessThanOrEqual(now + 60 * 60 * 1000 + 2000)
  })

  test('an absurd (beyond-8-day) reset is rejected → short default', () => {
    const now = Date.now()
    const out = planReactiveFallback(
      res({
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable',
        'anthropic-ratelimit-unified-reset': String(
          Math.floor((now + 30 * DAY) / 1000),
        ),
      }),
      body(FABLE),
      now,
      CATALOG,
    )
    // Falls through to the 1 h default rather than sidelining the tier for a month.
    expect(out?.resetAt).toBeLessThanOrEqual(now + 60 * 60 * 1000 + 2000)
  })
})
