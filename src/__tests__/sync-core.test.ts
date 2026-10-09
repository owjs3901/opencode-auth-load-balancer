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
import {
  blockerStands,
  hasFreedSkips,
  holdsFingerprint,
  type MergeMemory,
  planMerge,
  staticFingerprint,
} from '../sync/merge'
import { listable, ownEntries } from '../sync/own'
import {
  buildPayload,
  entriesDigest,
  entryKey,
  parsePayload,
  PAYLOAD_VERSION,
  printable,
  type SyncEntry,
} from '../sync/payload'
import type { ImportedRef } from '../sync/state'
import { type PoolFile, STATIC_CREDENTIAL_EXPIRES } from '../types'
import { testAccount } from './fixtures/account'
import { CLAUDE_TOKEN, CLAUDE_TOKEN_2, KIMI_KEY } from './fixtures/sync'

const ORIGIN = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

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
      'write-denied',
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

const collect = (p: PoolFile, imported: Record<string, ImportedRef> = {}) =>
  ownEntries(p, ORIGIN, imported)

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
    const entries = collect(pool(...rows))
    expect(entries.map((e) => e.id)).toEqual([
      'a-token-only',
      'k-key',
      'z-paired',
    ])
    expect(entries[2]).toEqual({
      origin: ORIGIN,
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
    expect(collect(pool(...rows))).toEqual([])
  })

  test('a refresh-less Kimi row with a finite-lived OAuth access token is not a key and is never collected', () => {
    const oauthShaped = kimiKeyRow({
      id: 'kimi-oauth-no-refresh',
      access: 'kimi-oauth-access-token-0123456789',
      expires: Date.now() + 3_600_000,
    })
    expect(collect(pool(oauthShaped))).toEqual([])
    expect(
      buildPayload(collect(pool(oauthShaped, kimiKeyRow())), 1),
    ).not.toContain('kimi-oauth-access-token')
  })

  test('the publisher never produces a snapshot its subscribers reject', () => {
    const rows = [
      kimiKeyRow({ id: 'long', label: 'L'.repeat(200) }),
      kimiKeyRow({ id: 'blank', label: '\u0007 \u202e ' }),
      kimiKeyRow({ id: 'bad id!' }),
      kimiKeyRow({ id: 'sneaky', label: 'a\u202eb\u200bc\u0085d' }),
    ]
    const entries = collect(pool(...rows))
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
    const entries = collect(pool(...many))
    expect(entries).toHaveLength(64)
    expect(parsePayload(buildPayload(entries, 1)).entries).toHaveLength(64)
  })

  test('the digest follows the credentials and ignores the clock', () => {
    const base = testAccount({
      id: 'a',
      refresh: '',
      inferenceToken: CLAUDE_TOKEN,
    })
    const one = collect(pool(base))
    const same = collect(pool({ ...base }))
    const changed = collect(pool({ ...base, inferenceToken: CLAUDE_TOKEN_2 }))
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
    origin: ORIGIN,
    id: 'row-1',
    providerID: 'anthropic',
    label: 'work',
    secret: CLAUDE_TOKEN,
    ...over,
  })
  const snapshot = (
    entries: unknown[],
    v: unknown = PAYLOAD_VERSION,
    at: unknown = 10,
  ) => parsePayload(JSON.stringify({ v, at, entries }))
  const parse = (entries: unknown[], v: unknown = PAYLOAD_VERSION) =>
    snapshot(entries, v).entries

  test('the format is version 2, and a version 1 gist says it was written by another version', () => {
    expect(PAYLOAD_VERSION).toBe(2)
    expect(codeOf(() => parse([], 1))).toBe('bad-version')
    expect(new SyncError('bad-version').message).toContain('newer version')
  })

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
      origin: ORIGIN,
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
    expect(codeOf(() => parsePayload('{"v":2,"at":1,"entries":{}}'))).toBe(
      'bad-blob',
    )
    expect(codeOf(() => parsePayload('{"v":2,"entries":[]}'))).toBe('bad-blob')
    expect(codeOf(() => parsePayload('{"v":2,"at":"x","entries":[]}'))).toBe(
      'bad-blob',
    )
    expect(codeOf(() => parse([], 3))).toBe('bad-version')
    expect(codeOf(() => parse(Array.from({ length: 65 }, () => entry())))).toBe(
      'too-large',
    )
    expect(snapshot([], 2, 42).at).toBe(42)
  })

  test('entries that break any rule are dropped, not trusted, and counted as unreadable', () => {
    const kept = entry({ id: 'ok' })
    const dropped = [
      null,
      'string',
      entry({ id: '' }),
      entry({ id: 'bad id!' }),
      entry({ id: 'x'.repeat(65) }),
      entry({ origin: 'not-an-origin' }),
      entry({ origin: undefined }),
      entry({ origin: 'A'.repeat(32) }),
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
    const got = snapshot([kept, ...dropped])
    expect(got.entries.map((e) => e.id)).toEqual(['ok'])
    expect(got.unreadable).toBe(dropped.length)
    expect(snapshot([kept]).unreadable).toBe(0)
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
    expect([...got.listed].sort()).toEqual(
      ['future', 'ok', 'too-long'].map((id) => `${ORIGIN}/${id}`),
    )
    expect(got.unreadable).toBe(5)
  })

  test('an entry is identified by origin and id: the same id from two machines is two entries', () => {
    const got = snapshot([
      entry({ id: 'same' }),
      entry({ id: 'same', origin: OTHER, secret: CLAUDE_TOKEN_2 }),
    ])
    expect(got.entries.map(entryKey)).toEqual([
      `${ORIGIN}/same`,
      `${OTHER}/same`,
    ])
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
    expect(got.entries.map((e) => e.id).sort()).toEqual([
      '__proto__',
      'constructor',
      'prototype',
    ])
    expect(got.listed.has(`${ORIGIN}/__proto__`)).toBe(true)
  })
})

describe('what a machine lists as its own', () => {
  const tokenOnly = (id: string, token: string) =>
    testAccount({
      id,
      label: id,
      refresh: '',
      access: token,
      inferenceToken: token,
    })
  const ref = (accountId: string, secret: string): ImportedRef => ({
    accountId,
    fingerprint: fingerprint(secret),
  })

  test('a row whose credential sync imported is never listed; any other row is', () => {
    const rows = pool(
      tokenOnly('imported', CLAUDE_TOKEN),
      tokenOnly('mine', CLAUDE_TOKEN_2),
    )
    expect(collect(rows).map((e) => e.id)).toEqual(['imported', 'mine'])
    const imported = { [`${OTHER}/p1`]: ref('imported', CLAUDE_TOKEN) }
    expect(collect(rows, imported).map((e) => e.id)).toEqual(['mine'])
  })

  test('a row the user re-pointed after the import is theirs again and is listed', () => {
    const rows = pool(tokenOnly('row', 'sk-ant-oat01-USER_pasted-9999'))
    const imported = { [`${OTHER}/p1`]: ref('row', CLAUDE_TOKEN) }
    expect(collect(rows, imported).map((e) => e.id)).toEqual(['row'])
    expect(
      collect(rows, { [`${OTHER}/p1`]: ref('gone', CLAUDE_TOKEN) }),
    ).toHaveLength(1)
  })

  test('a secret a machine with a smaller origin lists is not listed twice; a larger origin does not stop it', () => {
    const own = collect(pool(tokenOnly('mine', CLAUDE_TOKEN)))
    const theirs = (origin: string): SyncEntry => ({
      origin,
      id: 'x',
      providerID: 'anthropic',
      label: 'x',
      secret: CLAUDE_TOKEN,
    })
    const smaller = '0'.repeat(32)
    const larger = 'f'.repeat(32)
    expect(listable(own, [theirs(smaller)], ORIGIN)).toEqual([])
    expect(listable(own, [theirs(larger)], ORIGIN)).toEqual(own)
    expect(listable(own, [], ORIGIN)).toEqual(own)
  })

  test('the gist never holds more than 64 entries: the others are carried first', () => {
    const own = collect(
      pool(
        ...Array.from({ length: 5 }, (_, i) =>
          tokenOnly(`m${i}`, `${CLAUDE_TOKEN}${i}`),
        ),
      ),
    )
    const others = Array.from({ length: 62 }, (_, i) => ({
      origin: OTHER,
      id: `o${i}`,
      providerID: 'anthropic',
      label: 'o',
      secret: `${CLAUDE_TOKEN_2}${i}`,
    }))
    expect(listable(own, others, ORIGIN)).toHaveLength(2)
    expect(listable(own, [...others, ...others, ...others], ORIGIN)).toEqual([])
  })
})

describe('merge plan', () => {
  const entry = (id: string, secret = CLAUDE_TOKEN): SyncEntry => ({
    origin: OTHER,
    id,
    providerID: 'anthropic',
    label: id,
    secret,
  })
  const key = (id: string) => `${OTHER}/${id}`
  const ref = (accountId: string, secret: string) => ({
    accountId,
    fingerprint: fingerprint(secret),
  })
  const snap = (entries: SyncEntry[], extraListed: string[] = []) => ({
    entries,
    listed: new Set([...entries.map(entryKey), ...extraListed]),
  })
  const memory = (over: Partial<MergeMemory> = {}): MergeMemory => ({
    origin: ORIGIN,
    imported: {},
    skipped: {},
    ...over,
  })

  test('a new entry is imported', () => {
    expect(planMerge([], snap([entry('e1')]), memory())).toEqual({
      imports: [{ entry: entry('e1') }],
      drops: [],
      forgets: [],
    })
  })

  test("this machine's own entries are never imported back", () => {
    const mine = { ...entry('e1'), origin: ORIGIN }
    expect(planMerge([], snap([mine]), memory()).imports).toEqual([])
  })

  test('a new entry whose secret a local row already holds is left to that row', () => {
    const own = [
      testAccount({ id: 'own', refresh: '', access: CLAUDE_TOKEN }),
      testAccount({ id: 'paired', inferenceToken: CLAUDE_TOKEN_2 }),
    ]
    const plan = planMerge(
      own,
      snap([entry('e1'), entry('e2', CLAUDE_TOKEN_2)]),
      memory(),
    )
    expect(plan).toEqual({ imports: [], drops: [], forgets: [] })
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
    expect(planMerge(own, snap([entry('e1')]), memory()).imports).toHaveLength(
      1,
    )
  })

  test('a changed secret is imported again, remembering where it was', () => {
    const imported = { [key('e1')]: ref('row', CLAUDE_TOKEN) }
    const plan = planMerge(
      [],
      snap([entry('e1', CLAUDE_TOKEN_2)]),
      memory({ imported }),
    )
    expect(plan.imports).toEqual([
      {
        entry: entry('e1', CLAUDE_TOKEN_2),
        previous: imported[key('e1')],
      },
    ])
  })

  test("a rotation to a secret the user already holds releases the old one instead of claiming the user's row", () => {
    const old = ref('row', CLAUDE_TOKEN)
    const imported = { [key('e1')]: old }
    const own = [
      testAccount({ id: 'mine', refresh: '', access: CLAUDE_TOKEN_2 }),
    ]
    const plan = planMerge(
      own,
      snap([entry('e1', CLAUDE_TOKEN_2)]),
      memory({ imported }),
    )
    expect(plan).toEqual({
      imports: [],
      drops: [[key('e1'), old]],
      forgets: [],
    })
  })

  test('an unchanged secret is left alone, whatever the local row became', () => {
    const imported = { [key('e1')]: ref('gone', CLAUDE_TOKEN) }
    expect(planMerge([], snap([entry('e1')]), memory({ imported }))).toEqual({
      imports: [],
      drops: [],
      forgets: [],
    })
  })

  test('an imported entry missing from the gist is dropped; others never are', () => {
    const old = ref('row', CLAUDE_TOKEN)
    const imported = {
      [key('e1')]: old,
      [key('e2')]: ref('row2', KIMI_KEY),
    }
    const plan = planMerge(
      [testAccount({ id: 'local-own', refresh: '', access: 'mine' })],
      snap([{ ...entry('e2', KIMI_KEY), providerID: 'kimi-code-plan-cn' }]),
      memory({ imported }),
    )
    expect(plan.drops).toEqual([[key('e1'), old]])
  })

  test('an imported entry that is still listed but invalid is not dropped', () => {
    const imported = { [key('e1')]: ref('row', CLAUDE_TOKEN) }
    const plan = planMerge([], snap([], [key('e1')]), memory({ imported }))
    expect(plan).toEqual({ imports: [], drops: [], forgets: [] })
  })

  test('reserved ids never find inherited members', () => {
    const imported = { [key('other')]: ref('row', KIMI_KEY) }
    const plan = planMerge(
      [],
      snap([entry('__proto__'), entry('constructor', CLAUDE_TOKEN_2)]),
      memory({ imported }),
    )
    expect(plan.imports.map((j) => j.entry.id)).toEqual([
      '__proto__',
      'constructor',
    ])
    expect(plan.imports.every((j) => j.previous === undefined)).toBe(true)
  })

  test('an entry skipped behind a credential is not looked at again while that credential stays, and is the moment it goes', () => {
    const skip = {
      [key('e1')]: {
        fingerprint: fingerprint(CLAUDE_TOKEN),
        blocker: 'mine',
        holds: fingerprint(CLAUDE_TOKEN_2),
      },
    }
    const blocked = [
      testAccount({ id: 'mine', inferenceToken: CLAUDE_TOKEN_2 }),
    ]
    const wait = planMerge(
      blocked,
      snap([entry('e1')]),
      memory({ skipped: skip }),
    )
    expect(wait.imports).toEqual([])
    expect(hasFreedSkips(blocked, skip)).toBe(false)

    const freed = [testAccount({ id: 'mine' })]
    expect(hasFreedSkips(freed, skip)).toBe(true)
    expect(hasFreedSkips([], skip)).toBe(true)
    const again = planMerge(
      freed,
      snap([entry('e1')]),
      memory({ skipped: skip }),
    )
    expect(again.imports.map((j) => j.entry.id)).toEqual(['e1'])

    const changed = planMerge(
      blocked,
      snap([entry('e1', CLAUDE_TOKEN_2 + '9')]),
      memory({ skipped: skip }),
    )
    expect(changed.imports.map((j) => j.entry.id)).toEqual(['e1'])
  })

  test('a blocker without a static credential (an OAuth login) stands while its row does', () => {
    const skip = { fingerprint: 'f', blocker: 'oauth', holds: '' }
    expect(blockerStands([testAccount({ id: 'oauth' })], skip)).toBe(true)
    expect(blockerStands([], skip)).toBe(false)
  })

  test('skip records of entries the gist no longer lists are forgotten', () => {
    const skipped = {
      [key('gone')]: { fingerprint: 'f', blocker: 'b', holds: '' },
    }
    expect(planMerge([], snap([]), memory({ skipped })).forgets).toEqual([
      key('gone'),
    ])
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
    expect(
      staticFingerprint(testAccount({ inferenceToken: CLAUDE_TOKEN })),
    ).toBe(digest)
    expect(
      staticFingerprint(testAccount({ refresh: '', access: CLAUDE_TOKEN })),
    ).toBe(digest)
    expect(staticFingerprint(testAccount({ refresh: 'r' }))).toBe('')
  })
})
