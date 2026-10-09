import { describe, expect, test } from 'bun:test'

import {
  BLOB_VERSION,
  decodeKey,
  encodeKey,
  fingerprint,
  generateKey,
  MAX_BLOB_BYTES,
  open,
  seal,
} from '../sync/crypto'
import {
  describeSyncError,
  SyncError,
  type SyncErrorCode,
} from '../sync/errors'
import { holdsFingerprint, planMerge } from '../sync/merge'
import {
  buildPayload,
  collectEntries,
  entriesDigest,
  parsePayload,
  printable,
  type SyncEntry,
} from '../sync/payload'
import { type PoolFile, STATIC_CREDENTIAL_EXPIRES } from '../types'
import { testAccount } from './fixtures/account'
import { CLAUDE_TOKEN, CLAUDE_TOKEN_2, KIMI_KEY } from './fixtures/sync'

function codeOf(fn: () => unknown): SyncErrorCode | undefined {
  try {
    fn()
  } catch (error) {
    return error instanceof SyncError ? error.code : undefined
  }
  return undefined
}

describe('crypto', () => {
  test('round trips text and gives every upload a fresh nonce', () => {
    const key = generateKey()
    const a = seal('héllo 한국어 🔑', key)
    const b = seal('héllo 한국어 🔑', key)
    expect(open(a, key)).toBe('héllo 한국어 🔑')
    expect(open(b, key)).toBe('héllo 한국어 🔑')
    expect(a).not.toBe(b)
    expect(JSON.parse(a).v).toBe(BLOB_VERSION)
  })

  test('the blob holds no plaintext', () => {
    const blob = seal(`secret ${CLAUDE_TOKEN}`, generateKey())
    expect(blob).not.toContain('sk-ant')
    expect(blob).not.toContain('secret')
  })

  test('keys are 32 random bytes that survive the link fragment', () => {
    const key = generateKey()
    expect(key.length).toBe(32)
    const text = encodeKey(key)
    expect(text).toMatch(/^[\w-]{43}$/)
    expect(decodeKey(text)?.equals(key)).toBe(true)
    expect(generateKey().equals(key)).toBe(false)
  })

  test('a fragment that is not a 32-byte base64url key is refused', () => {
    expect(decodeKey('')).toBeNull()
    expect(decodeKey('short')).toBeNull()
    expect(decodeKey(`${'a'.repeat(42)}=`)).toBeNull()
    expect(decodeKey('a'.repeat(44))).toBeNull()
  })

  test('the wrong key and any tampering fail as one undistinguishing error', () => {
    const key = generateKey()
    const blob = JSON.parse(seal('payload', key))
    const flip = (value: string): string =>
      `${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`
    expect(codeOf(() => open(JSON.stringify(blob), generateKey()))).toBe(
      'decrypt',
    )
    for (const field of ['c', 't'])
      expect(
        codeOf(() =>
          open(JSON.stringify({ ...blob, [field]: flip(blob[field]) }), key),
        ),
      ).toBe('decrypt')
    expect(
      codeOf(() =>
        open(JSON.stringify({ ...blob, n: JSON.parse(seal('x', key)).n }), key),
      ),
    ).toBe('decrypt')
  })

  test('a blob of another version, or no version, is refused', () => {
    const key = generateKey()
    const blob = JSON.parse(seal('x', key))
    expect(codeOf(() => open(JSON.stringify({ ...blob, v: 2 }), key))).toBe(
      'bad-version',
    )
    expect(codeOf(() => open(JSON.stringify({ ...blob, v: '1' }), key))).toBe(
      'bad-blob',
    )
    expect(
      codeOf(() => open(JSON.stringify({ ...blob, v: undefined }), key)),
    ).toBe('bad-blob')
  })

  test('malformed blobs are refused before any decryption', () => {
    const key = generateKey()
    const blob = JSON.parse(seal('x', key))
    for (const text of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...blob, n: 'AAAA' }),
      JSON.stringify({ ...blob, t: 'AAAA' }),
      JSON.stringify({ ...blob, c: 'not base64 !' }),
      JSON.stringify({ ...blob, c: 5 }),
    ])
      expect(codeOf(() => open(text, key))).toBe('bad-blob')
  })

  test('an oversize blob is refused', () => {
    expect(
      codeOf(() => open('x'.repeat(MAX_BLOB_BYTES + 1), generateKey())),
    ).toBe('too-large')
  })

  test('fingerprints identify a secret without revealing it', () => {
    expect(fingerprint('a')).toBe(fingerprint('a'))
    expect(fingerprint('a')).not.toBe(fingerprint('b'))
    expect(fingerprint('a')).toMatch(/^[\da-f]{32}$/)
  })
})

describe('sync errors', () => {
  test('every code carries a short message that never holds a link or key', () => {
    const codes: SyncErrorCode[] = [
      'bad-link',
      'not-set-up',
      'bad-blob',
      'bad-version',
      'decrypt',
      'too-large',
      'rate-limited',
      'not-found',
      'network',
      'no-auth',
      'http',
    ]
    for (const code of codes) {
      const error = new SyncError(code)
      expect(error.message.length).toBeGreaterThan(10)
      expect(error.message).not.toMatch(/#[\w-]{20}|[\da-f]{32}/)
      expect(describeSyncError(error)).toBe(error.message)
    }
    expect(new SyncError('rate-limited', 5).retryAfterMs).toBe(5)
  })

  test('a foreign error becomes a generic line', () => {
    expect(describeSyncError(new Error('boom: https://x#key'))).toBe(
      'Sync failed.',
    )
  })
})

const pool = (...accounts: PoolFile['accounts']): PoolFile => ({
  version: 1,
  accounts,
  lastSelected: {},
  sessions: {},
})

const kimiKeyRow = (over: Partial<PoolFile['accounts'][number]> = {}) =>
  testAccount({
    id: 'k-key',
    providerID: 'kimi-code-plan-cn',
    label: 'kimi',
    access: KIMI_KEY,
    refresh: '',
    expires: STATIC_CREDENTIAL_EXPIRES,
    ...over,
  })

describe('payload: what is collected', () => {
  test('only static credentials, never an OAuth field, sorted by row id', () => {
    const rows = [
      testAccount({
        id: 'z-paired',
        label: 'paired',
        access: 'OAUTH-ACCESS-SECRET',
        refresh: 'OAUTH-REFRESH-SECRET',
        refreshExpires: 99,
        tokenGen: 4,
        inferenceToken: CLAUDE_TOKEN,
        inferenceExpires: 123,
        orgId: 'org-1',
      }),
      testAccount({
        id: 'a-token-only',
        label: 'token-only',
        access: CLAUDE_TOKEN_2,
        refresh: '',
        inferenceToken: CLAUDE_TOKEN_2,
      }),
      kimiKeyRow(),
    ]
    const entries = collectEntries(pool(...rows))
    expect(entries.map((e) => e.id)).toEqual([
      'a-token-only',
      'k-key',
      'z-paired',
    ])
    expect(entries[2]).toEqual({
      id: 'z-paired',
      providerID: 'anthropic',
      label: 'paired',
      secret: CLAUDE_TOKEN,
      expiresAt: 123,
    })
    const text = buildPayload(entries, 1)
    for (const secret of [
      'OAUTH-ACCESS-SECRET',
      'OAUTH-REFRESH-SECRET',
      'refreshExpires',
      'tokenGen',
      'usage',
      'cooldown',
      'org-1',
    ])
      expect(text).not.toContain(secret)
  })

  test('rows without a static credential, or with a dead one, are left out', () => {
    const rows = [
      testAccount({ id: 'oauth-only', access: 'a', refresh: 'r' }),
      kimiKeyRow({ id: 'kimi-oauth', refresh: 'r' }),
      testAccount({
        id: 'codex',
        providerID: 'openai',
        access: KIMI_KEY,
        refresh: '',
        expires: STATIC_CREDENTIAL_EXPIRES,
      }),
      testAccount({
        id: 'disabled',
        refresh: '',
        inferenceToken: CLAUDE_TOKEN,
        disabledReason: 'manually disabled',
      }),
      testAccount({
        id: 'lost',
        inferenceToken: CLAUDE_TOKEN,
        lostLogins: { token: { at: 1, reason: '401' } },
      }),
      testAccount({ id: 'odd', inferenceToken: 'not-a-claude-token' }),
      kimiKeyRow({ id: 'short-key', access: 'abc' }),
      testAccount({ id: 'constructor', providerID: 'constructor' }),
      testAccount({ id: 'proto', providerID: '__proto__' }),
    ]
    expect(collectEntries(pool(...rows))).toEqual([])
  })

  test('a refresh-less Kimi row with a finite-lived OAuth access token is not a key and is never collected', () => {
    const oauthShaped = kimiKeyRow({
      id: 'kimi-oauth-no-refresh',
      access: 'kimi-oauth-access-token-0123456789',
      expires: Date.now() + 3_600_000,
    })
    expect(collectEntries(pool(oauthShaped))).toEqual([])
    expect(
      buildPayload(collectEntries(pool(oauthShaped, kimiKeyRow())), 1),
    ).not.toContain('kimi-oauth-access-token')
  })

  test('the publisher never produces a snapshot its subscribers reject', () => {
    const rows = [
      kimiKeyRow({ id: 'long', label: 'L'.repeat(200) }),
      kimiKeyRow({ id: 'blank', label: '\u0007 \u202e ' }),
      kimiKeyRow({ id: 'bad id!' }),
      kimiKeyRow({ id: 'sneaky', label: 'a\u202eb\u200bc\u0085d' }),
    ]
    const entries = collectEntries(pool(...rows))
    expect(entries.map((e) => [e.id, e.label])).toEqual([
      ['blank', 'kimi-code-plan-cn'],
      ['long', 'L'.repeat(80)],
      ['sneaky', 'a b c d'],
    ])
    const text = buildPayload(entries, 1)
    expect(parsePayload(text).entries).toEqual(entries)
  })

  test('at most 64 entries are produced', () => {
    const many = Array.from({ length: 70 }, (_, i) =>
      kimiKeyRow({
        id: `k${String(i).padStart(3, '0')}`,
        access: `${KIMI_KEY}-${i}`,
      }),
    )
    const entries = collectEntries(pool(...many))
    expect(entries).toHaveLength(64)
    expect(parsePayload(buildPayload(entries, 1)).entries).toHaveLength(64)
  })

  test('the digest follows the credentials and ignores the clock', () => {
    const base = testAccount({
      id: 'a',
      refresh: '',
      inferenceToken: CLAUDE_TOKEN,
    })
    const one = collectEntries(pool(base))
    const same = collectEntries(pool({ ...base }))
    const changed = collectEntries(
      pool({ ...base, inferenceToken: CLAUDE_TOKEN_2 }),
    )
    expect(entriesDigest(one)).toBe(entriesDigest(same))
    expect(entriesDigest(one)).not.toBe(entriesDigest(changed))
    expect(buildPayload(one, 1)).not.toBe(buildPayload(one, 2))
  })
})

describe('labels', () => {
  test('controls, C1, bidi and zero-width characters become spaces', () => {
    expect(printable('a\u0000b\nc\u007fd\u0085e\u009ff')).toBe('a b c d e f')
    expect(printable('x\u202ey\u2066z\u2069w\u200ev\u061cu')).toBe(
      'x y z w v u',
    )
    expect(printable('a\u200bb\u2060c\ufeffd\u2028e')).toBe('a b c d e')
    expect(printable('  plain 한국어 🔑  ')).toBe('plain 한국어 🔑')
  })
})

describe('payload: an untrusted read', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'row-1',
    providerID: 'anthropic',
    label: 'work',
    secret: CLAUDE_TOKEN,
    ...over,
  })
  const snapshot = (entries: unknown[], v: unknown = 1, at: unknown = 10) =>
    parsePayload(JSON.stringify({ v, at, entries }))
  const parse = (entries: unknown[], v: unknown = 1): SyncEntry[] =>
    snapshot(entries, v).entries

  test('a well-formed entry survives, and only its allow-listed fields', () => {
    const [got] = parse([
      entry({
        orgId: 'org-9',
        expiresAt: 5,
        refresh: 'EVIL',
        access: 'EVIL',
        refreshExpires: 1,
        usage: {},
      }),
    ])
    expect(got).toEqual({
      id: 'row-1',
      providerID: 'anthropic',
      label: 'work',
      secret: CLAUDE_TOKEN,
      expiresAt: 5,
    })
  })

  test('envelope errors', () => {
    expect(codeOf(() => parsePayload('nope'))).toBe('bad-blob')
    expect(codeOf(() => parsePayload('[]'))).toBe('bad-blob')
    expect(codeOf(() => parsePayload('{"v":1,"at":1,"entries":{}}'))).toBe(
      'bad-blob',
    )
    expect(codeOf(() => parsePayload('{"v":1,"entries":[]}'))).toBe('bad-blob')
    expect(codeOf(() => parsePayload('{"v":1,"at":"x","entries":[]}'))).toBe(
      'bad-blob',
    )
    expect(codeOf(() => parse([], 2))).toBe('bad-version')
    expect(codeOf(() => parse(Array.from({ length: 65 }, () => entry())))).toBe(
      'too-large',
    )
    expect(snapshot([], 1, 42).at).toBe(42)
  })

  test('entries that break any rule are dropped, not trusted', () => {
    const kept = entry({ id: 'ok' })
    const dropped = [
      null,
      'string',
      entry({ id: '' }),
      entry({ id: 'bad id!' }),
      entry({ id: 'x'.repeat(65) }),
      entry({ providerID: 'openai' }),
      entry({ providerID: 5 }),
      entry({ providerID: 'constructor' }),
      entry({ providerID: '__proto__' }),
      entry({ label: '' }),
      entry({ label: '  \t ' }),
      entry({ label: 'x'.repeat(81) }),
      entry({ secret: 'sk-ant-api03-notanoauthtoken' }),
      entry({ secret: `${CLAUDE_TOKEN} with space` }),
      entry({ secret: 'x'.repeat(513) }),
      entry({ providerID: 'kimi-code-plan-cn', secret: 'short' }),
    ]
    expect(parse([kept, ...dropped]).map((e) => e.id)).toEqual(['ok'])
  })

  test('an entry that fails validation is still listed, so it never reads as removed', () => {
    const got = snapshot([
      entry({ id: 'too-long', label: 'x'.repeat(81) }),
      entry({ id: 'future', providerID: 'future-provider' }),
      entry({ id: 'ok' }),
      entry({ id: 'ok', label: 'second' }),
      entry({ id: 'bad id!' }),
      null,
      { id: 5 },
    ])
    expect(got.entries.map((e) => e.id)).toEqual(['ok'])
    expect([...got.listed].sort()).toEqual(['future', 'ok', 'too-long'])
  })

  test('duplicates keep the first; control characters in a label become spaces', () => {
    const got = parse([
      entry({ id: 'd', label: 'a\u0000b\nc\u007fd' }),
      entry({ id: 'd', label: 'second' }),
    ])
    expect(got).toHaveLength(1)
    expect(got[0]?.label).toBe('a b c d')
  })

  test('expiresAt is a Claude-only positive number', () => {
    const got = parse([
      entry({ id: 'a', expiresAt: 'soon' }),
      entry({ id: 'b', expiresAt: -1 }),
      entry({ id: 'c', expiresAt: 7 }),
      entry({
        id: 'k',
        providerID: 'kimi-code-plan-cn',
        secret: KIMI_KEY,
        expiresAt: 5,
      }),
    ])
    expect(got.map((e) => e.expiresAt)).toEqual([
      undefined,
      undefined,
      7,
      undefined,
    ])
  })

  test('ids such as __proto__ and constructor are ordinary ids', () => {
    const got = snapshot([
      entry({ id: '__proto__' }),
      entry({ id: 'constructor', secret: CLAUDE_TOKEN_2 }),
      entry({ id: 'prototype', secret: `${CLAUDE_TOKEN_2}x` }),
    ])
    expect(got.entries.map((e) => e.id)).toEqual([
      '__proto__',
      'constructor',
      'prototype',
    ])
    expect(got.listed.has('__proto__')).toBe(true)
  })
})

describe('merge plan', () => {
  const entry = (id: string, secret = CLAUDE_TOKEN): SyncEntry => ({
    id,
    providerID: 'anthropic',
    label: id,
    secret,
  })
  const ref = (accountId: string, secret: string) => ({
    accountId,
    fingerprint: fingerprint(secret),
  })
  const snap = (entries: SyncEntry[], extraListed: string[] = []) => ({
    entries,
    listed: new Set([...entries.map((e) => e.id), ...extraListed]),
  })

  test('a new entry is imported', () => {
    expect(planMerge([], snap([entry('e1')]), {})).toEqual({
      imports: [{ entry: entry('e1') }],
      drops: [],
    })
  })

  test('a new entry whose secret a local row already holds is left to that row', () => {
    const own = [
      testAccount({ id: 'own', refresh: '', access: CLAUDE_TOKEN }),
      testAccount({ id: 'paired', inferenceToken: CLAUDE_TOKEN_2 }),
    ]
    const plan = planMerge(
      own,
      snap([entry('e1'), entry('e2', CLAUDE_TOKEN_2)]),
      {},
    )
    expect(plan).toEqual({ imports: [], drops: [] })
  })

  test('a held secret of another provider does not block the import', () => {
    const own = [
      testAccount({
        id: 'o',
        providerID: 'openai',
        refresh: '',
        access: CLAUDE_TOKEN,
      }),
    ]
    expect(planMerge(own, snap([entry('e1')]), {}).imports).toHaveLength(1)
  })

  test('a changed secret is imported again, remembering where it was', () => {
    const imported = { e1: ref('row', CLAUDE_TOKEN) }
    const plan = planMerge([], snap([entry('e1', CLAUDE_TOKEN_2)]), imported)
    expect(plan.imports).toEqual([
      { entry: entry('e1', CLAUDE_TOKEN_2), previous: imported.e1 },
    ])
  })

  test("a rotation to a secret the user already holds releases the old one instead of claiming the user's row", () => {
    const imported = { e1: ref('row', CLAUDE_TOKEN) }
    const own = [
      testAccount({ id: 'mine', refresh: '', access: CLAUDE_TOKEN_2 }),
    ]
    const plan = planMerge(own, snap([entry('e1', CLAUDE_TOKEN_2)]), imported)
    expect(plan).toEqual({ imports: [], drops: [['e1', imported.e1]] })
  })

  test('an unchanged secret is left alone, whatever the local row became', () => {
    const imported = { e1: ref('gone', CLAUDE_TOKEN) }
    expect(planMerge([], snap([entry('e1')]), imported)).toEqual({
      imports: [],
      drops: [],
    })
  })

  test('an imported entry missing from the gist is dropped; others never are', () => {
    const imported = { e1: ref('row', CLAUDE_TOKEN), e2: ref('row2', KIMI_KEY) }
    const plan = planMerge(
      [testAccount({ id: 'local-own', refresh: '', access: 'mine' })],
      snap([entry('e2', KIMI_KEY)]),
      imported,
    )
    expect(plan.drops).toEqual([['e1', imported.e1]])
  })

  test('an imported entry that is still listed but invalid is not dropped', () => {
    const imported = { e1: ref('row', CLAUDE_TOKEN) }
    const plan = planMerge([], snap([], ['e1']), imported)
    expect(plan).toEqual({ imports: [], drops: [] })
  })

  test('reserved ids never find inherited members', () => {
    const imported = { other: ref('row', KIMI_KEY) }
    const plan = planMerge(
      [],
      snap([entry('__proto__'), entry('constructor', CLAUDE_TOKEN_2)]),
      imported,
    )
    expect(plan.imports.map((j) => j.entry.id)).toEqual([
      '__proto__',
      'constructor',
    ])
    expect(plan.imports.every((j) => j.previous === undefined)).toBe(true)
  })

  test('holdsFingerprint reads the static credential of either row shape', () => {
    const digest = fingerprint(CLAUDE_TOKEN)
    expect(
      holdsFingerprint(testAccount({ inferenceToken: CLAUDE_TOKEN }), digest),
    ).toBe(true)
    expect(
      holdsFingerprint(
        testAccount({ refresh: '', access: CLAUDE_TOKEN }),
        digest,
      ),
    ).toBe(true)
    expect(
      holdsFingerprint(
        testAccount({ refresh: 'r', access: CLAUDE_TOKEN }),
        digest,
      ),
    ).toBe(false)
    expect(
      holdsFingerprint(testAccount({ inferenceToken: 'other' }), digest),
    ).toBe(false)
  })
})
