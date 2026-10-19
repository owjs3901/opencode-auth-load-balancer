import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { poolFilePath } from '../pool/paths'
import { findAccount, mutatePool, readPool } from '../pool/store'
import { withRefreshLock } from '../refresh'
import { fingerprint } from '../sync/crypto'
import { type LoginRecord, parseLogin } from '../sync/login-payload'
import {
  applyLogins,
  heldMarks,
  type LoginsApplied,
  loginsSyncEnabled,
  mergeLogins,
  ownCopies,
  ownLogins,
  publishDigest,
} from '../sync/logins'
import {
  MANUAL_DISABLED_REASON,
  type PoolAccount,
  type PoolFile,
} from '../types'
import { sleep } from '../util'
import { testAccount } from './fixtures/account'
import { CLAUDE_TOKEN } from './fixtures/sync'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-logins-pool-'))
const FAR = 4_000_000_000_000
const NOW = 7_000_000

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(poolFilePath(), { force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
})

const loginRow = (id: string, over: Partial<PoolAccount> = {}) =>
  testAccount({
    id,
    providerID: 'openai',
    label: id,
    access: `ACCESS-${id}`,
    refresh: `REFRESH-${id}`,
    expires: FAR,
    accountId: 'acct-1',
    loginRev: 2,
    loginAt: 100,
    ...over,
  })

const gist = (over: Record<string, unknown> = {}): LoginRecord => {
  const login = parseLogin({
    key: 'openai:acct-1',
    providerID: 'openai',
    label: 'from-gist',
    access: 'GIST-ACCESS',
    refresh: 'GIST-REFRESH',
    expires: FAR + 1,
    accountId: 'acct-1',
    rev: 5,
    at: 900,
    ...over,
  })
  if (!login) throw new Error('fixture is not a valid login')
  return login
}

const poolOf = (...accounts: PoolAccount[]): PoolFile => ({
  version: 1,
  accounts,
  lastSelected: {},
  sessions: {},
})
const seed = (...rows: PoolAccount[]) =>
  mutatePool((pool) => {
    pool.accounts = rows
  })
const rows = async () => (await readPool()).accounts
const stored = async (id: string) => findAccount(await readPool(), id)
const NO_MARKS = { known: undefined, suppressed: undefined }

describe('the switch', () => {
  test('on by default; 0 / false / no / off turn it off', () => {
    expect(loginsSyncEnabled({})).toBe(true)
    expect(loginsSyncEnabled({ OPENCODE_AUTH_LB_SYNC_LOGINS: '1' })).toBe(true)
    for (const off of ['0', 'false', ' NO ', 'Off'])
      expect(loginsSyncEnabled({ OPENCODE_AUTH_LB_SYNC_LOGINS: off })).toBe(
        false,
      )
    delete process.env.OPENCODE_AUTH_LB_SYNC_LOGINS
    expect(loginsSyncEnabled()).toBe(true)
  })
})

describe('which logins of a machine are shared', () => {
  test('only a working OAuth login of a known account, with nothing but the login in it', () => {
    const shared = ownLogins(
      poolOf(
        loginRow('good', {
          orgId: 'org-1',
          refreshExpires: 5,
          inferenceToken: CLAUDE_TOKEN,
          cooldownUntil: 99,
          tokenGen: 8,
        }),
        loginRow('no-account', { accountId: null, providerID: 'anthropic' }),
        loginRow('static-key', {
          providerID: 'kimi-code-plan-cn',
          accountId: 'key:abc',
          refresh: '',
        }),
        loginRow('setup-token', {
          providerID: 'anthropic',
          accountId: null,
          refresh: '',
          inferenceToken: CLAUDE_TOKEN,
        }),
        loginRow('disabled', { accountId: 'a2', disabledReason: 'x' }),
        loginRow('lost', {
          accountId: 'a3',
          lostLogins: { oauth: { at: 1, reason: 'revoked' } },
        }),
        loginRow('other-provider', { providerID: 'future', accountId: 'a4' }),
        loginRow('never-expiring', { accountId: 'a5', expires: 0 }),
        loginRow('spaced', { accountId: 'a6', access: 'A B' }),
      ),
    )
    expect(shared).toEqual([
      {
        key: 'openai:acct-1',
        providerID: 'openai',
        label: 'good',
        access: 'ACCESS-good',
        refresh: 'REFRESH-good',
        expires: FAR,
        accountId: 'acct-1',
        orgId: 'org-1',
        refreshExpires: 5,
        rev: 2,
        at: 100,
      },
    ])
    expect(JSON.stringify(shared)).not.toContain(CLAUDE_TOKEN)
  })

  test('a row without a version is revision 1, time 0; a label is made printable and short', () => {
    const [login] = ownLogins(
      poolOf(
        loginRow('a', {
          label: `${'x'.repeat(100)}\u0000`,
          loginRev: undefined,
          loginAt: undefined,
        }),
      ),
    )
    expect([login?.rev, login?.at, login?.label.length]).toEqual([1, 0, 80])
    const [blank] = ownLogins(poolOf(loginRow('b', { label: ' \u0000 ' })))
    expect(blank?.label).toBe('openai')
  })

  test('two rows of one login share the newer; the list is in key order', () => {
    const shared = ownLogins(
      poolOf(
        loginRow('old', { loginRev: 2 }),
        loginRow('new', { loginRev: 3 }),
        loginRow('older', { loginRev: 1 }),
        loginRow('b', { accountId: 'a-b' }),
      ),
    )
    expect(shared.map((l) => [l.key, l.label])).toEqual([
      ['openai:a-b', 'b'],
      ['openai:acct-1', 'new'],
    ])
  })

  test('the keys a pool holds include a row that fell back to its inference token', () => {
    const held = heldMarks([
      loginRow('a'),
      loginRow('fell', {
        accountId: 'a2',
        refresh: '',
        inferenceToken: CLAUDE_TOKEN,
        lostLogins: { oauth: { at: 1, reason: 'revoked' } },
      }),
      loginRow('key', { accountId: 'a3', refresh: '' }),
      loginRow('nobody', { accountId: null }),
    ])
    expect(Object.keys(held).sort()).toEqual(['openai:a2', 'openai:acct-1'])
  })
})

describe('what is written and what it is compared with', () => {
  test('per key the newer copy wins, a gist login without a local copy is carried, and there is a limit', () => {
    const [a, b] = [gist({ rev: 5 }), gist({ key: 'openai:b', accountId: 'b' })]
    const [newer, older] = [gist({ rev: 6 }), gist({ rev: 4 })]
    expect(mergeLogins([a, b], [newer]).map((l) => [l.key, l.rev])).toEqual([
      ['openai:acct-1', 6],
      ['openai:b', 5],
    ])
    expect(mergeLogins([a, b], [older]).find((l) => l.key === a.key)).toBe(a)
    expect(mergeLogins([], [b])).toEqual([b])

    const full = Array.from({ length: 64 }, (_, i) =>
      gist({ key: `openai:g${i}`, accountId: `g${i}` }),
    )
    expect(mergeLogins(full, [b])).toHaveLength(64)
    const bumped = mergeLogins(full, [
      gist({ key: 'openai:g3', accountId: 'g3', rev: 9 }),
    ])
    expect(bumped.find((l) => l.key === 'openai:g3')?.rev).toBe(9)
  })

  test('the copies a write holds of the logins of this machine are counted by token', () => {
    const [a, b] = [gist(), gist({ key: 'openai:b', accountId: 'b' })]
    const theirB = { ...b, refresh: 'OTHER-REFRESH' }
    expect(ownCopies([a, theirB], [a, b])).toBe(1)
    expect(ownCopies([], [a])).toBe(0)
  })

  test('the digest is that of the entries alone while there are no logins, and moves with any login', () => {
    const entry = {
      origin: 'a'.repeat(32),
      id: 'x',
      providerID: 'anthropic',
      label: 'x',
      secret: CLAUDE_TOKEN,
    }
    const bare = publishDigest([entry], [])
    expect(publishDigest([entry], [gist()])).not.toBe(bare)
    expect(publishDigest([entry], [gist()])).toBe(
      publishDigest([entry], [gist()]),
    )
    expect(publishDigest([entry], [gist({ access: 'NEW' })])).not.toBe(
      publishDigest([entry], [gist()]),
    )
    expect(bare).toBe(fingerprint(JSON.stringify([entry])))
  })
})

describe('putting the login of the gist on the pool', () => {
  test('a login no row holds becomes a row with a unique label, the version of the gist, and a bumped generation', async () => {
    await seed(loginRow('keep', { label: 'from-gist', accountId: 'other' }))
    const got = await applyLogins([gist({ orgId: 'org-1' })], NO_MARKS, NOW)
    expect(got.adopted).toBe(1)
    const made = (await rows()).find((r) => r.accountId === 'acct-1')
    expect(made).toMatchObject({
      providerID: 'openai',
      label: 'from-gist (2)',
      access: 'GIST-ACCESS',
      refresh: 'GIST-REFRESH',
      expires: FAR + 1,
      orgId: 'org-1',
      loginRev: 5,
      loginAt: 900,
      tokenGen: 1,
    })
    expect(Object.keys(got.known).sort()).toEqual([
      'openai:acct-1',
      'openai:other',
    ])
  })

  test('a newer login overwrites the tokens of the row and nothing else; an automatic disable is lifted, a manual one is not', async () => {
    const usage = {
      hourly: null,
      weekly: { utilization: 0.4, resetAt: 5 },
      capturedAt: 3,
    }
    await seed(
      loginRow('mine', {
        label: 'my label',
        orgId: 'org-1',
        refreshExpires: 77,
        inferenceToken: CLAUDE_TOKEN,
        inferenceExpires: 1234,
        usage,
        cooldownUntil: 42,
        tokenGen: 4,
        disabledReason: 'invalid_grant: re-login required (openai:mine)',
        lostLogins: {
          oauth: { at: 1, reason: 'revoked' },
          token: { at: 2, reason: 'dead' },
        },
      }),
      loginRow('manual', {
        accountId: 'acct-2',
        disabledReason: MANUAL_DISABLED_REASON,
      }),
    )
    const got = await applyLogins(
      [
        gist({ orgId: 'org-1' }),
        gist({ key: 'openai:acct-2', accountId: 'acct-2' }),
      ],
      NO_MARKS,
      NOW,
    )
    expect(got.adopted).toBe(2)
    const mine = await stored('mine')
    expect(mine).toMatchObject({
      label: 'my label',
      access: 'GIST-ACCESS',
      refresh: 'GIST-REFRESH',
      expires: FAR + 1,
      orgId: 'org-1',
      loginRev: 5,
      loginAt: 900,
      tokenGen: 5,
      inferenceToken: CLAUDE_TOKEN,
      inferenceExpires: 1234,
      usage,
      cooldownUntil: 42,
      disabledReason: null,
      lostLogins: { token: { at: 2, reason: 'dead' } },
    })
    expect(mine).not.toHaveProperty('refreshExpires')
    expect(await stored('manual')).toMatchObject({
      disabledReason: MANUAL_DISABLED_REASON,
      refresh: 'GIST-REFRESH',
      tokenGen: 1,
    })
  })

  test('a row that fell back to its inference token is an OAuth row again, keeping that token', async () => {
    await seed(
      loginRow('fell', {
        providerID: 'anthropic',
        access: CLAUDE_TOKEN,
        refresh: '',
        expires: Number.MAX_SAFE_INTEGER,
        inferenceToken: CLAUDE_TOKEN,
        lostLogins: { oauth: { at: 1, reason: 'revoked' } },
        loginRev: 1,
        loginAt: 0,
      }),
    )
    const login = gist({ key: 'anthropic:acct-1', providerID: 'anthropic' })
    expect((await applyLogins([login], NO_MARKS, NOW)).adopted).toBe(1)
    const row = await stored('fell')
    expect(row).toMatchObject({
      access: 'GIST-ACCESS',
      refresh: 'GIST-REFRESH',
      inferenceToken: CLAUDE_TOKEN,
      loginRev: 5,
    })
    expect(row).not.toHaveProperty('lostLogins')
  })

  test('a login that is not newer is ignored, whatever the reason it is not', async () => {
    const mine = loginRow('mine', {
      loginRev: 5,
      loginAt: 900,
      refresh: 'GIST-REFRESH',
    })
    await seed(mine)
    const same = await applyLogins([gist()], NO_MARKS, NOW)
    const older = await applyLogins([gist({ rev: 4, at: 5000 })], NO_MARKS, NOW)
    const earlier = await applyLogins([gist({ at: 899 })], NO_MARKS, NOW)
    expect([same.adopted, older.adopted, earlier.adopted]).toEqual([0, 0, 0])
    expect(await rows()).toEqual([mine])
  })

  test('a tie of revision and time goes to the larger refresh fingerprint, here and on every machine', async () => {
    const [a, b] = ['TOKEN-A', 'TOKEN-B']
    const theirs = fingerprint(a) > fingerprint(b) ? a : b
    const ours = theirs === a ? b : a
    await seed(loginRow('mine', { loginRev: 5, loginAt: 900, refresh: ours }))
    const got = await applyLogins([gist({ refresh: theirs })], NO_MARKS, NOW)
    expect(got.adopted).toBe(1)
    expect((await stored('mine'))?.refresh).toBe(theirs)
    await seed(loginRow('mine', { loginRev: 5, loginAt: 900, refresh: theirs }))
    expect(
      (await applyLogins([gist({ refresh: ours })], NO_MARKS, NOW)).adopted,
    ).toBe(0)
  })

  test('a token-only row of the same organization takes the login like a local login would, and stays disabled if the user disabled it', async () => {
    await seed(
      testAccount({
        id: 'tok',
        refresh: '',
        access: CLAUDE_TOKEN,
        inferenceToken: CLAUDE_TOKEN,
        orgId: 'org-1',
        disabledReason: MANUAL_DISABLED_REASON,
      }),
    )
    const login = gist({
      key: 'anthropic:acct-9',
      providerID: 'anthropic',
      accountId: 'acct-9',
      orgId: 'org-1',
      refreshExpires: 9_000,
    })
    expect((await applyLogins([login], NO_MARKS, NOW)).adopted).toBe(1)
    expect(await rows()).toHaveLength(1)
    expect(await stored('tok')).toMatchObject({
      accountId: 'acct-9',
      refresh: 'GIST-REFRESH',
      inferenceToken: CLAUDE_TOKEN,
      refreshExpires: 9_000,
      loginRev: 5,
      tokenGen: 1,
      disabledReason: MANUAL_DISABLED_REASON,
    })
  })

  test('a row that moved on since it was read is left alone: the refresh lock is waited for and the generation checked again', async () => {
    await seed(loginRow('mine', { tokenGen: 2 }))
    const running: Promise<LoginsApplied>[] = []
    await withRefreshLock('openai', 'mine', async () => {
      running.push(applyLogins([gist()], NO_MARKS, NOW))
      await sleep(250)
      await mutatePool((pool) => {
        const row = findAccount(pool, 'mine')
        if (row) {
          row.refresh = 'ROTATED-MEANWHILE'
          row.tokenGen = 3
        }
      })
    })
    expect((await Promise.all(running)).map((r) => r.adopted)).toEqual([0])
    expect(await stored('mine')).toMatchObject({
      refresh: 'ROTATED-MEANWHILE',
      tokenGen: 3,
    })
  })

  test('a login of the same account in another organization lands on that accounts row, as a local login would', async () => {
    await seed(loginRow('mine', { orgId: 'org-old' }))
    const got = await applyLogins([gist({ orgId: 'org-new' })], NO_MARKS, NOW)
    expect(got.adopted).toBe(1)
    expect(await rows()).toHaveLength(1)
    expect(await stored('mine')).toMatchObject({
      refresh: 'GIST-REFRESH',
      orgId: 'org-new',
      loginRev: 5,
    })
  })

  test('two passes at once create the row once', async () => {
    const both = await Promise.all([
      applyLogins([gist()], NO_MARKS, NOW),
      applyLogins([gist()], NO_MARKS, NOW),
    ])
    expect(both.map((r) => r.adopted).sort()).toEqual([0, 1])
    expect(await rows()).toHaveLength(1)
  })
})

describe('a row the user deleted does not come back', () => {
  test('a known key with no row is suppressed and never imported', async () => {
    await seed(loginRow('other', { accountId: 'a2' }))
    const got = await applyLogins(
      [gist()],
      {
        known: { 'openai:acct-1': true, 'openai:a2': true },
        suppressed: undefined,
      },
      NOW,
    )
    expect(got.adopted).toBe(0)
    expect(Object.keys(got.suppressed)).toEqual(['openai:acct-1'])
    expect(Object.keys(got.known)).toEqual(['openai:a2'])
    expect(await rows()).toHaveLength(1)
  })

  test('a suppressed key stays suppressed while there is no row, whatever the gist holds', async () => {
    const got = await applyLogins(
      [gist({ rev: 99 })],
      { known: undefined, suppressed: { 'openai:acct-1': true } },
      NOW,
    )
    expect(got.adopted).toBe(0)
    expect(Object.keys(got.suppressed)).toEqual(['openai:acct-1'])
    expect(await rows()).toHaveLength(0)
  })

  test('a suppressed key with a row again was logged in to again: it is released and outranks the old copy in the gist', async () => {
    await seed(loginRow('fresh', { loginRev: 1, loginAt: 1 }))
    const got = await applyLogins(
      [gist({ rev: 5 })],
      { known: undefined, suppressed: { 'openai:acct-1': true } },
      NOW,
    )
    expect(got.adopted).toBe(0)
    expect(got.suppressed).toEqual({})
    expect(await stored('fresh')).toMatchObject({
      refresh: 'REFRESH-fresh',
      loginRev: 6,
      loginAt: NOW,
    })
  })

  test('a released key whose row already outranks the gist, or that the gist lacks, is left as it is', async () => {
    await seed(loginRow('fresh', { loginRev: 9 }))
    const marks = {
      known: undefined,
      suppressed: { 'openai:acct-1': true },
    } as const
    await applyLogins([gist({ rev: 5 })], marks, NOW)
    expect((await stored('fresh'))?.loginRev).toBe(9)
    const none = await applyLogins([], marks, NOW)
    expect(none.suppressed).toEqual({})
    expect((await stored('fresh'))?.loginRev).toBe(9)
  })
})
