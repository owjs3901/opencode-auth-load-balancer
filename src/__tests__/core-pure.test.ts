import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { poolFilePath, resolveDataDir } from '../pool/paths'
import { mergeHeaders } from '../providers/headers'
import { DEFAULT_CONFIG, loadConfig } from '../scheduler/config'
import { deriveSessionKey, SESSION_HEADER } from '../session'
import { preserveWeeklyAnchor, rollWeeklyAnchorForward } from '../usage-merge'
import { secondsToMs, sleepAbortable } from '../util'

const WEEK = 7 * 24 * 60 * 60 * 1000

describe('rollWeeklyAnchorForward (fixed weekly anchors repeat every 7d)', () => {
  const now = 1_000_000_000_000
  test('no usable anchor stays unknown', () => {
    expect(rollWeeklyAnchorForward(0, now)).toBe(0)
    expect(rollWeeklyAnchorForward(-5, now)).toBe(0)
    expect(rollWeeklyAnchorForward(Number.NaN, now)).toBe(0)
    expect(rollWeeklyAnchorForward(Number.POSITIVE_INFINITY, now)).toBe(0)
  })
  test('a future anchor is returned untouched', () => {
    expect(rollWeeklyAnchorForward(now + 123, now)).toBe(now + 123)
  })
  test('a past anchor rolls forward by whole weeks to the NEXT occurrence', () => {
    expect(rollWeeklyAnchorForward(now - 1, now)).toBe(now - 1 + WEEK)
    expect(rollWeeklyAnchorForward(now - WEEK - 1, now)).toBe(
      now - 1 + WEEK, // two periods past -> +2 weeks
    )
  })
  test('an anchor exactly at now rolls to the NEXT week (strictly future)', () => {
    expect(rollWeeklyAnchorForward(now, now)).toBe(now + WEEK)
  })
})

describe('preserveWeeklyAnchor (anchor survives resets_at-less merges)', () => {
  const now = 1_000_000_000_000
  test('incoming null / incoming with its own reset pass through untouched', () => {
    expect(
      preserveWeeklyAnchor(null, { utilization: 1, resetAt: 9 }, now),
    ).toBe(null)
    const fresh = { utilization: 0.2, resetAt: now + 5 }
    expect(
      preserveWeeklyAnchor(fresh, { utilization: 1, resetAt: now + 999 }, now),
    ).toBe(fresh)
  })
  test('anchor-less incoming adopts the stored FUTURE anchor, keeping incoming utilization', () => {
    expect(
      preserveWeeklyAnchor(
        { utilization: 0, resetAt: 0 },
        { utilization: 1, resetAt: now + 7 * 60 * 60 * 1000 },
        now,
      ),
    ).toEqual({ utilization: 0, resetAt: now + 7 * 60 * 60 * 1000 })
  })
  test('anchor-less incoming adopts a stored PAST anchor rolled forward a week', () => {
    expect(
      preserveWeeklyAnchor(
        { utilization: 0, resetAt: 0 },
        { utilization: 0.9, resetAt: now - 1000 },
        now,
      ),
    ).toEqual({ utilization: 0, resetAt: now - 1000 + WEEK })
  })
  test('no stored anchor -> incoming stays as-is (unknown stays unknown)', () => {
    const incoming = { utilization: 0, resetAt: 0 }
    expect(preserveWeeklyAnchor(incoming, null, now)).toBe(incoming)
    expect(preserveWeeklyAnchor(incoming, undefined, now)).toBe(incoming)
    expect(
      preserveWeeklyAnchor(incoming, { utilization: 0.5, resetAt: 0 }, now),
    ).toBe(incoming)
  })
})

describe('secondsToMs (epoch-seconds -> epoch-ms, bounded against broken-clock resets)', () => {
  const nowSec = Math.floor(Date.now() / 1000)
  test('non-finite / zero / negative inputs -> 0 (no usable reset)', () => {
    expect(secondsToMs(0)).toBe(0)
    expect(secondsToMs(-5)).toBe(0)
    expect(secondsToMs(Number.NaN)).toBe(0)
    expect(secondsToMs(Number.POSITIVE_INFINITY)).toBe(0)
  })
  test('the *1000 overflow case -> 0', () => {
    expect(secondsToMs(1e308)).toBe(0)
  })
  test('a realistic near-future reset (a few hours/days out) passes through as-is', () => {
    expect(secondsToMs(nowSec + 3600)).toBe((nowSec + 3600) * 1000)
    expect(secondsToMs(nowSec + 86400)).toBe((nowSec + 86400) * 1000)
  })
  test('an absolute epoch-seconds value in the PAST always passes (expired, not broken)', () => {
    // 604800 (7 days since epoch, i.e. 1970-01-08) is hugely in the past relative to
    // any real `now` -- an elapsed reset is simply "expired" (isWindowExpired), never
    // a broken-clock symptom, so it is never rejected by the future-bound.
    expect(secondsToMs(604800)).toBe(604800000)
  })
  test('a finite-but-implausibly-far-future reset -> 0 (broken server/proxy clock)', () => {
    // Regression lock for the gap that let a malformed
    // `anthropic-ratelimit-unified-7d-reset` / `x-codex-secondary-reset-at` header
    // (e.g. `99999999999` seconds ≈ year 5138) permanently near-zero-rank an
    // otherwise-healthy account in weeklyUrgency (days² in the denominator).
    expect(secondsToMs(99999999999)).toBe(0)
    // Just past the 8-day bound from the real current time.
    expect(secondsToMs(nowSec + 9 * 24 * 60 * 60)).toBe(0)
    // Just inside the 8-day bound stays valid.
    const withinBoundSec = nowSec + 7 * 24 * 60 * 60
    expect(secondsToMs(withinBoundSec)).toBe(withinBoundSec * 1000)
  })
})

describe('resolveDataDir', () => {
  test('override wins over everything', () => {
    expect(
      resolveDataDir({ override: '/tmp/x', xdgDataHome: '/xdg' }, '/home/u'),
    ).toBe('/tmp/x')
  })
  test('XDG_DATA_HOME is used when set', () => {
    expect(resolveDataDir({ xdgDataHome: '/xdg' }, '/home/u')).toBe(
      join('/xdg', 'opencode'),
    )
  })
  test('defaults to ~/.local/share/opencode on every OS (matches xdg-basedir)', () => {
    expect(resolveDataDir({}, '/home/u')).toBe(
      join('/home/u', '.local', 'share', 'opencode'),
    )
  })
  test('live wrappers resolve a pool file path', () => {
    expect(poolFilePath().endsWith('auth-load-balancer.json')).toBe(true)
  })
})

describe('loadConfig', () => {
  test('returns defaults for an empty env', () => {
    expect(loadConfig({})).toEqual(DEFAULT_CONFIG)
  })
  test('parses numeric overrides and ignores invalid numbers', () => {
    // migrateAt is a scoring field (read via score-core's loadScoreConfig)...
    expect(loadConfig({ OPENCODE_AUTH_LB_MIGRATE_AT: '0.8' }).migrateAt).toBe(
      0.8,
    )
    expect(loadConfig({ OPENCODE_AUTH_LB_MIGRATE_AT: 'abc' }).migrateAt).toBe(
      DEFAULT_CONFIG.migrateAt,
    )
    // weeklyDrainTarget is migrateAt's WEEKLY counterpart (also via loadScoreConfig):
    // the 5h window migrates at migrateAt, the weekly window migrates at weeklyDrainTarget.
    expect(
      loadConfig({ OPENCODE_AUTH_LB_WEEKLY_DRAIN_TARGET: '0.9' })
        .weeklyDrainTarget,
    ).toBe(0.9)
    expect(
      loadConfig({ OPENCODE_AUTH_LB_WEEKLY_DRAIN_TARGET: 'abc' })
        .weeklyDrainTarget,
    ).toBe(DEFAULT_CONFIG.weeklyDrainTarget)
    // ...sessionTtlMs is a server-only field (read via config.ts's own num()).
    expect(
      loadConfig({ OPENCODE_AUTH_LB_SESSION_TTL_MS: '123' }).sessionTtlMs,
    ).toBe(123)
    expect(
      loadConfig({ OPENCODE_AUTH_LB_SESSION_TTL_MS: 'abc' }).sessionTtlMs,
    ).toBe(DEFAULT_CONFIG.sessionTtlMs)
  })
  test('parses boolean overrides (truthy/falsey/empty)', () => {
    expect(
      loadConfig({ OPENCODE_AUTH_LB_DRAIN_MIGRATE: 'true' }).drainMigrate,
    ).toBe(true)
    expect(
      loadConfig({ OPENCODE_AUTH_LB_DRAIN_MIGRATE: 'on' }).drainMigrate,
    ).toBe(true)
    expect(
      loadConfig({ OPENCODE_AUTH_LB_DRAIN_MIGRATE: '0' }).drainMigrate,
    ).toBe(false)
    expect(
      loadConfig({ OPENCODE_AUTH_LB_DRAIN_MIGRATE: '' }).drainMigrate,
    ).toBe(DEFAULT_CONFIG.drainMigrate)
  })
  test('treats empty-string numeric overrides as unset (fall back to default)', () => {
    // An unset upstream var in a wrapper (`OPENCODE_AUTH_LB_EXHAUSTED_AT=$X opencode ...`
    // with `$X` unset, Docker-compose `"${X:-}"`, Windows `set FOO=`, a k8s ConfigMap with
    // an empty `value:`) all surface as `''`. The bool helper above already falls back to
    // the default; the num helpers must do the same -- otherwise `Number('') === 0` silently
    // zeros the knob (e.g. `exhaustedAt=0` excludes every account, `sessionTtlMs=0` prunes
    // every session affinity entry on the next write).
    // sessionTtlMs lives in config.ts's own num().
    expect(
      loadConfig({ OPENCODE_AUTH_LB_SESSION_TTL_MS: '' }).sessionTtlMs,
    ).toBe(DEFAULT_CONFIG.sessionTtlMs)
    // migrateAt and exhaustedAt are scoring fields read via score-core.ts's num()
    // (loadConfig spreads loadScoreConfig), so this asserts BOTH num helpers in one test.
    expect(loadConfig({ OPENCODE_AUTH_LB_MIGRATE_AT: '' }).migrateAt).toBe(
      DEFAULT_CONFIG.migrateAt,
    )
    expect(loadConfig({ OPENCODE_AUTH_LB_EXHAUSTED_AT: '' }).exhaustedAt).toBe(
      DEFAULT_CONFIG.exhaustedAt,
    )
  })
  test('treats whitespace-only numeric overrides as unset (fall back to default)', () => {
    // `Number('  ') === 0` (finite), so pre-fix a whitespace-only value slipped
    // past the `raw === ''` guard and silently zeroed the knob — e.g.
    // `exhaustedAt=0` ranks every account with any usage as exhausted, and
    // `sessionTtlMs=0` prunes every session-affinity entry on the next write.
    // Both knobs parse through score-core's readEnvNumber (config.ts's num()
    // delegates to it): exhaustedAt via loadScoreConfig, sessionTtlMs via
    // loadConfig's server-only fields.
    expect(loadConfig({ OPENCODE_AUTH_LB_EXHAUSTED_AT: ' ' }).exhaustedAt).toBe(
      DEFAULT_CONFIG.exhaustedAt,
    )
    expect(
      loadConfig({ OPENCODE_AUTH_LB_SESSION_TTL_MS: '\t ' }).sessionTtlMs,
    ).toBe(DEFAULT_CONFIG.sessionTtlMs)
  })
})

describe('deriveSessionKey', () => {
  test('prefers the session header', () => {
    expect(
      deriveSessionKey(new Headers({ [SESSION_HEADER]: 'abc' }), undefined),
    ).toBe('s:abc')
  })
  test('hashes an anthropic body (system string + first user message)', () => {
    const body = JSON.stringify({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
    })
    const key = deriveSessionKey(new Headers(), body)
    expect(key?.startsWith('b:')).toBe(true)
    // stable across turns of the same conversation
    const grown = JSON.stringify({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x' },
      ],
    })
    expect(deriveSessionKey(new Headers(), grown)).toBe(key)
  })
  test('hashes an openai body (instructions + first user input)', () => {
    const body = JSON.stringify({
      instructions: 'ins',
      input: [{ role: 'user', content: [{ text: 'hi' }] }],
    })
    expect(deriveSessionKey(new Headers(), body)?.startsWith('b:')).toBe(true)
  })
  test('handles a body with an object system and no first user message', () => {
    const body = JSON.stringify({
      system: { type: 'text', text: 's' },
      messages: [{ role: 'assistant', content: 'x' }],
    })
    expect(deriveSessionKey(new Headers(), body)?.startsWith('b:')).toBe(true)
  })
  test('hashes bodies with non-text user content (number / non-text block)', () => {
    expect(
      deriveSessionKey(
        new Headers(),
        JSON.stringify({ messages: [{ role: 'user', content: 5 }] }),
      )?.startsWith('b:'),
    ).toBe(true)
    expect(
      deriveSessionKey(
        new Headers(),
        JSON.stringify({
          input: [{ role: 'user', content: [{ type: 'image' }] }],
        }),
      )?.startsWith('b:'),
    ).toBe(true)
  })

  test('returns null with neither header nor body', () => {
    expect(deriveSessionKey(new Headers(), undefined)).toBeNull()
  })
  test('returns null on invalid JSON body', () => {
    expect(deriveSessionKey(new Headers(), '{not json')).toBeNull()
  })
})

describe('mergeHeaders', () => {
  test('copies headers off a Request input', () => {
    const req = new Request('https://x', { headers: { a: '1' } })
    expect(mergeHeaders(req).get('a')).toBe('1')
  })
  test('copies a Headers init', () => {
    expect(
      mergeHeaders('https://x', { headers: new Headers({ b: '2' }) }).get('b'),
    ).toBe('2')
  })
  test('copies an array init and skips undefined values', () => {
    const arr = [
      ['c', '3'],
      ['d', undefined],
    ] as unknown as HeadersInit
    const h = mergeHeaders('https://x', { headers: arr })
    expect(h.get('c')).toBe('3')
    expect(h.get('d')).toBeNull()
  })
  test('copies an array init and skips undefined keys', () => {
    // Without the `key !== undefined` guard the pair would coerce into a
    // literal "undefined" header name — assert exactly one key survives.
    const arr = [
      [undefined, 'v'],
      ['k', '1'],
    ] as unknown as HeadersInit
    const h = mergeHeaders('https://x', { headers: arr })
    expect(h.get('k')).toBe('1')
    expect([...h.keys()]).toHaveLength(1)
  })
  test('copies an object init and skips undefined values', () => {
    const obj = { e: '4', f: undefined } as Record<
      string,
      string | undefined
    > as HeadersInit
    const h = mergeHeaders('https://x', { headers: obj })
    expect(h.get('e')).toBe('4')
    expect(h.get('f')).toBeNull()
  })
  test('returns empty headers when there is no init', () => {
    expect([...mergeHeaders('https://x').keys()]).toHaveLength(0)
  })
  test('init headers override same-named Request headers; others survive', () => {
    const req = new Request('https://x', { headers: { a: '1', keep: 'r' } })
    const h = mergeHeaders(req, { headers: { a: '2' } })
    expect(h.get('a')).toBe('2')
    expect(h.get('keep')).toBe('r')
  })
})

describe('sleepAbortable', () => {
  test('resolves after the delay when no signal is given', async () => {
    await expect(sleepAbortable(10)).resolves.toBeUndefined()
  })

  test('resolves after the delay when a live (never-aborted) signal is given', async () => {
    const ac = new AbortController()
    await expect(sleepAbortable(10, ac.signal)).resolves.toBeUndefined()
  })

  test('rejects immediately when the signal is already aborted (no wait)', async () => {
    const ac = new AbortController()
    ac.abort()
    const start = Date.now()
    await expect(sleepAbortable(10_000, ac.signal)).rejects.toBeDefined()
    expect(Date.now() - start).toBeLessThan(1000) // did not block the full 10 s
  })

  test('rejects the moment the signal aborts mid-wait (does not block the full delay)', async () => {
    const ac = new AbortController()
    const start = Date.now()
    const p = sleepAbortable(10_000, ac.signal)
    setTimeout(() => ac.abort(), 20)
    await expect(p).rejects.toBeDefined()
    expect(Date.now() - start).toBeLessThan(1000) // woke on abort, not after 10 s
  })
})
