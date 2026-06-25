import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { opencodeDataDir, poolFilePath, resolveDataDir } from '../pool/paths'
import { mergeHeaders } from '../providers/headers'
import { DEFAULT_CONFIG, loadConfig } from '../scheduler/config'
import { deriveSessionKey, SESSION_HEADER } from '../session'

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
    expect(typeof opencodeDataDir()).toBe('string')
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
})
