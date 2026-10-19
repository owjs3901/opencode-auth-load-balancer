import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { syncStateFilePath } from '../pool/paths'
import { encodeKey, fingerprint, generateKey } from '../sync/crypto'
import {
  compareLogins,
  LOGIN_PROVIDERS,
  type LoginRecord,
  loginsDigest,
  MAX_LOGINS,
  parseLogin,
  parseLoginList,
} from '../sync/login-payload'
import { buildPayload, parsePayload } from '../sync/payload'
import { marks, newMap, readSyncState } from '../sync/state'
import { boundedString } from '../sync/text'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-logins-wire-'))

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(syncStateFilePath(), { force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
})

const wire = (over: Record<string, unknown> = {}) => ({
  key: 'openai:acct-1',
  providerID: 'openai',
  label: 'work',
  access: 'FAKE-ACCESS',
  refresh: 'FAKE-REFRESH',
  expires: 2_000_000,
  accountId: 'acct-1',
  rev: 3,
  at: 500,
  ...over,
})

const record = (over: Partial<LoginRecord> = {}): LoginRecord => {
  const parsed = parseLogin(wire(over))
  if (!parsed) throw new Error('fixture is not a valid login')
  return parsed
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('a login read back is parsed through an allow-list', () => {
  test('a well-formed login survives with only its allow-listed fields', () => {
    const got = parseLogin(
      wire({
        orgId: 'org-1',
        refreshExpires: 9_000_000,
        usage: { hourly: 1 },
        inferenceToken: 'EVIL',
        id: 'local-id',
        tokenGen: 4,
      }),
    )
    expect(got).toEqual({
      key: 'openai:acct-1',
      providerID: 'openai',
      label: 'work',
      access: 'FAKE-ACCESS',
      refresh: 'FAKE-REFRESH',
      expires: 2_000_000,
      accountId: 'acct-1',
      orgId: 'org-1',
      refreshExpires: 9_000_000,
      rev: 3,
      at: 500,
    })
  })

  test('long JWT-sized tokens are fine, up to 8192 characters', () => {
    const long = 'a'.repeat(8192)
    expect(parseLogin(wire({ access: long, refresh: long }))?.access).toBe(long)
    expect(parseLogin(wire({ access: `${long}a` }))).toBeNull()
    expect(parseLogin(wire({ refresh: `${long}a` }))).toBeNull()
  })

  test('all four login providers are known, and an inherited member is not a provider', () => {
    expect([...LOGIN_PROVIDERS].sort()).toEqual([
      'anthropic',
      'kimi-code-plan-cn',
      'kimi-code-plan-global',
      'openai',
    ])
    for (const providerID of ['constructor', '__proto__', 'toString', 'other'])
      expect(
        parseLogin(
          wire({
            providerID,
            key: `${providerID}:acct-1`,
            accountId: 'acct-1',
          }),
        ),
      ).toBeNull()
  })

  test.each([
    ['not an object', 'text'],
    ['an array', []],
    ['null', null],
    ['a key that is not provider:account', { key: 'openai:other' }],
    ['a key of another provider', { key: 'anthropic:acct-1' }],
    ['no key', { key: undefined }],
    ['no provider', { providerID: undefined }],
    ['an empty label', { label: '' }],
    ['a blank label', { label: ' \t\u202e ' }],
    ['an oversized label', { label: 'x'.repeat(81) }],
    ['an empty access token', { access: '' }],
    ['an access token with whitespace', { access: 'FAKE ACCESS' }],
    ['a refresh token that is not text', { refresh: 5 }],
    ['an empty refresh token', { refresh: '' }],
    ['an oversized account id', { accountId: 'a'.repeat(129) }],
    ['an account id with whitespace', { accountId: 'acct 1' }],
    ['no expiry', { expires: undefined }],
    ['a zero expiry', { expires: 0 }],
    ['an infinite expiry', { expires: Number.POSITIVE_INFINITY }],
    ['a fractional rev', { rev: 1.5 }],
    ['a zero rev', { rev: 0 }],
    ['an unsafe rev', { rev: 2 ** 53 }],
    ['a rev that is text', { rev: '3' }],
    ['a negative time', { at: -1 }],
    ['a time that is text', { at: 'now' }],
  ])('%s is refused', (_name, over) => {
    const raw =
      over !== null && typeof over === 'object' && !Array.isArray(over)
        ? wire(over as Record<string, unknown>)
        : over
    expect(parseLogin(raw)).toBeNull()
  })

  test('a bad optional field is dropped, not trusted; the login stays', () => {
    const got = parseLogin(
      wire({ orgId: 'org 1', refreshExpires: -5, label: 'a\u0000b' }),
    )
    expect(got).toMatchObject({ label: 'a b' })
    expect(got).not.toHaveProperty('orgId')
    expect(got).not.toHaveProperty('refreshExpires')
    expect(parseLogin(wire({ orgId: 'o'.repeat(129) }))).not.toHaveProperty(
      'orgId',
    )
  })

  test('a list keeps the first valid login of a key, lists every key, and counts the unreadable', () => {
    const first = wire({ access: 'FIRST' })
    const parsed = parseLoginList([
      first,
      wire({ access: 'SECOND' }),
      wire({ key: 'openai:acct-2', accountId: 'acct-2', rev: 0 }),
      wire({ key: 'openai:acct-2', accountId: 'acct-2' }),
      wire({ key: 'openai:acct-3', accountId: 'acct-3', label: '' }),
      'junk',
    ])
    expect(parsed.logins.map((l) => [l.key, l.access])).toEqual([
      ['openai:acct-1', 'FIRST'],
      ['openai:acct-2', 'FAKE-ACCESS'],
    ])
    expect([...parsed.loginsListed].sort()).toEqual([
      'openai:acct-1',
      'openai:acct-2',
      'openai:acct-3',
    ])
    expect(parsed.loginsUnreadable).toBe(3)
  })

  test('a key longer than the bound is not listed, but the login is still unreadable', () => {
    const parsed = parseLoginList([wire({ key: `openai:${'a'.repeat(300)}` })])
    expect(parsed.loginsListed.size).toBe(0)
    expect(parsed.loginsUnreadable).toBe(1)
    expect(boundedString('', 5)).toBeUndefined()
  })
})

describe('the shared order of two copies of one login', () => {
  const v = (rev: number, at: number, refresh: string) => ({ rev, at, refresh })

  test('revision first, then time, then the refresh token fingerprint', () => {
    expect(compareLogins(v(2, 0, 'a'), v(1, 999, 'z'))).toBeGreaterThan(0)
    expect(compareLogins(v(1, 999, 'z'), v(2, 0, 'a'))).toBeLessThan(0)
    expect(compareLogins(v(2, 5, 'a'), v(2, 4, 'z'))).toBeGreaterThan(0)
    expect(compareLogins(v(2, 4, 'z'), v(2, 5, 'a'))).toBeLessThan(0)
  })

  test('a tie of revision and time is settled the same way from either side, and only the same token ties', () => {
    const [a, b] = [v(2, 5, 'token-a'), v(2, 5, 'token-b')]
    const forward = compareLogins(a, b)
    expect(forward).not.toBe(0)
    expect(Math.sign(compareLogins(b, a))).toBe(-Math.sign(forward))
    expect(Math.sign(forward)).toBe(
      fingerprint('token-a') < fingerprint('token-b') ? -1 : 1,
    )
    expect(compareLogins(a, v(2, 5, 'token-a'))).toBe(0)
  })

  test('the digest ignores order and notices any change of a token', () => {
    const [x, y] = [record(), record({ key: 'openai:b', accountId: 'b' })]
    expect(loginsDigest([x, y])).toBe(loginsDigest([y, x]))
    expect(loginsDigest([x])).not.toBe(loginsDigest([record({ access: 'N' })]))
    expect(loginsDigest([])).toBe(fingerprint('[]'))
  })
})

describe('payload version 3', () => {
  const snap = (body: Record<string, unknown>) =>
    parsePayload(JSON.stringify({ at: 10, entries: [], ...body }))

  test('everything written is version 3 with its logins sorted by key', () => {
    const [b, a] = [record({ key: 'openai:b', accountId: 'b' }), record()]
    const text = buildPayload([], 7, [b, a])
    expect(JSON.parse(text)).toMatchObject({ v: 3, at: 7 })
    expect(parsePayload(text).logins.map((l) => l.key)).toEqual([
      'openai:acct-1',
      'openai:b',
    ])
    expect(JSON.parse(buildPayload([], 7)).logins).toEqual([])
  })

  test('version 2 is read with no logins; version 3 without a list reads as none', () => {
    const v2 = snap({ v: 2, logins: [wire()] })
    expect(v2.logins).toEqual([])
    expect(v2.loginsUnreadable).toBe(0)
    expect(snap({ v: 3 }).logins).toEqual([])
  })

  test('unreadable logins are counted, listed logins are keyed, and the cap is enforced', () => {
    const got = snap({ v: 3, logins: [wire(), wire({ key: 'x:y' })] })
    expect(got.logins).toHaveLength(1)
    expect(got.loginsUnreadable).toBe(1)
    expect([...got.loginsListed]).toEqual(['openai:acct-1', 'x:y'])
    expect(codeOf(() => snap({ v: 3, logins: {} }))).toBe('bad-blob')
    const many = Array.from({ length: MAX_LOGINS + 1 }, (_, i) =>
      wire({ key: `openai:a${i}`, accountId: `a${i}` }),
    )
    expect(codeOf(() => snap({ v: 3, logins: many }))).toBe('too-large')
    expect(
      snap({ v: 3, logins: many.slice(0, MAX_LOGINS) }).logins,
    ).toHaveLength(MAX_LOGINS)
    expect(codeOf(() => snap({ v: 4 }))).toBe('bad-version')
  })
})

describe('the deletion marks in the sync state file', () => {
  const stateText = (over: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      gistId: 'b'.repeat(32),
      key: encodeKey(generateKey()),
      creator: false,
      imported: {},
      skipped: {},
      ...over,
    })

  test('known and suppressed keys round trip as prototype-less maps; anything but true is dropped', async () => {
    await writeFile(
      syncStateFilePath(),
      stateText({
        loginKnown: { 'openai:a': true, 'openai:b': 'yes', __proto__x: true },
        loginSuppressed: { 'openai:c': true, 'openai:d': false },
      }),
    )
    const got = await readSyncState()
    expect(Object.keys(got?.loginKnown ?? {}).sort()).toEqual([
      '__proto__x',
      'openai:a',
    ])
    expect(Object.keys(got?.loginSuppressed ?? {})).toEqual(['openai:c'])
    expect(Object.getPrototypeOf(got?.loginKnown)).toBeNull()
    expect(Object.getPrototypeOf(got?.loginSuppressed)).toBeNull()
  })

  test('a state without marks stays without them', async () => {
    await writeFile(
      syncStateFilePath(),
      stateText({ loginKnown: 'nope', loginSuppressed: { a: 1 } }),
    )
    const got = await readSyncState()
    expect(got).not.toHaveProperty('loginKnown')
    expect(got).not.toHaveProperty('loginSuppressed')
    expect(marks(undefined)).toBeUndefined()
    expect(marks(newMap())).toBeUndefined()
    expect(marks({ 'openai:a': true })).toEqual({ 'openai:a': true })
  })
})
