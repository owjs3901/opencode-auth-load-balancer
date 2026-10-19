import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { addAccount, makeAccount } from '../accounts'
import { bumpLoginRev, loginVersion } from '../login-rev'
import { poolFilePath } from '../pool/paths'
import { findAccount, mutatePool, readPool } from '../pool/store'
import { ensureAccessToken } from '../refresh'
import { mintToken } from '../token-mint'
import type { PoolAccount, TokenSet } from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-login-rev-'))
const FAR = 4_000_000_000_000

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(poolFilePath(), { force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
})

const tokens = (over: Partial<TokenSet> = {}): TokenSet => ({
  access: 'FAKE-ACCESS',
  refresh: 'FAKE-REFRESH',
  expires: FAR,
  accountId: 'acct-1',
  ...over,
})

const seed = (...rows: PoolAccount[]) =>
  mutatePool((pool) => {
    pool.accounts = rows
  })
const stored = async (id: string) => findAccount(await readPool(), id)

describe('the shared login version of a row', () => {
  test('a bump is one more than the revision (a row without one is revision 1) and stamps the time', () => {
    const row = testAccount()
    expect(loginVersion(row)).toEqual({ rev: 1, at: 0 })
    bumpLoginRev(row, 50)
    expect(loginVersion(row)).toEqual({ rev: 2, at: 50 })
    bumpLoginRev(row)
    expect(row.loginRev).toBe(3)
    expect(row.loginAt).toBeGreaterThan(50)
  })

  test('the pool file keeps a well-formed version and drops a malformed one', async () => {
    const raw = (id: string, over: Record<string, unknown>) => ({
      ...testAccount({ id }),
      ...over,
    })
    await writeFile(
      poolFilePath(),
      JSON.stringify({
        version: 1,
        accounts: [
          raw('ok', { loginRev: 7, loginAt: 9 }),
          raw('zero', { loginRev: 0, loginAt: 0 }),
          raw('frac', { loginRev: 1.5, loginAt: -1 }),
          raw('text', { loginRev: '3', loginAt: 'now' }),
          raw('huge', { loginRev: 2 ** 53, loginAt: Number.POSITIVE_INFINITY }),
        ],
        lastSelected: {},
        sessions: {},
      }),
    )
    const rows = (await readPool()).accounts
    const pick = (id: string) => {
      const row = rows.find((r) => r.id === id)
      return [row?.loginRev, row?.loginAt]
    }
    expect(pick('ok')).toEqual([7, 9])
    expect(pick('zero')).toEqual([undefined, 0])
    expect(pick('frac')).toEqual([undefined, undefined])
    expect(pick('text')).toEqual([undefined, undefined])
    expect(pick('huge')).toEqual([undefined, undefined])
  })
})

describe('where a login version starts and moves', () => {
  test('a row made from OAuth tokens starts at revision 1; a static credential never gets one', () => {
    const login = makeAccount('anthropic', 'a', tokens())
    expect(login.loginRev).toBe(1)
    expect(login.loginAt).toBeGreaterThan(0)
    const setup = makeAccount('anthropic', 'b', {
      ...tokens({ refresh: '' }),
      inferenceOnly: true,
    })
    const key = makeAccount('kimi-code-plan-cn', 'c', tokens({ refresh: '' }))
    const claimed = makeAccount('anthropic', 'd', {
      ...tokens(),
      inferenceOnly: true,
    })
    for (const row of [setup, key, claimed]) {
      expect(row).not.toHaveProperty('loginRev')
      expect(row).not.toHaveProperty('loginAt')
    }
  })

  test('a re-login bumps the row it lands on; a static credential landing on it does not', async () => {
    const first = await addAccount('openai', tokens())
    expect(first.loginRev).toBe(1)
    const again = await addAccount(
      'openai',
      tokens({ refresh: 'FAKE-REFRESH-2' }),
    )
    expect(again.id).toBe(first.id)
    expect(again.loginRev).toBe(2)
    expect((await stored(first.id))?.loginRev).toBe(2)
    await addAccount('openai', tokens({ refresh: '' }))
    expect((await stored(first.id))?.loginRev).toBe(2)
  })

  test('an OAuth login paired onto a token-only row gives it a version', async () => {
    await seed(
      testAccount({
        id: 'tok',
        refresh: '',
        access: 'sk-ant-oat01-x',
        inferenceToken: 'sk-ant-oat01-x',
        orgId: 'org-1',
      }),
    )
    const landed = await addAccount(
      'anthropic',
      tokens({ accountId: 'acct-9', orgId: 'org-1' }),
    )
    expect(landed.id).toBe('tok')
    expect(landed.loginRev).toBe(2)
  })
})

describe('a refresh bumps the version only when it commits', () => {
  const adapterRotating = (onRefresh: () => Promise<unknown> = async () => 0) =>
    fakeAdapter({
      refresh: async () => {
        await onRefresh()
        return { access: 'NEW-ACCESS', refresh: 'NEW-REFRESH', expires: FAR }
      },
    })
  const expired = () =>
    testAccount({
      id: 'r1',
      access: 'OLD-ACCESS',
      refresh: 'OLD-REFRESH',
      expires: 0,
      tokenGen: 0,
      loginRev: 4,
      loginAt: 10,
    })

  test('a committed rotation', async () => {
    const row = expired()
    await seed(row)
    await ensureAccessToken(adapterRotating(), row, Date.now())
    const after = await stored('r1')
    expect(after).toMatchObject({
      access: 'NEW-ACCESS',
      refresh: 'NEW-REFRESH',
      tokenGen: 1,
      loginRev: 5,
    })
    expect(after?.loginAt).toBeGreaterThan(10)
  })

  test('a result that lost to a concurrent rotation is adopted and does not bump', async () => {
    const row = expired()
    await seed(row)
    const rival = adapterRotating(() =>
      mutatePool((pool) => {
        const other = findAccount(pool, 'r1')
        if (other) {
          other.refresh = 'RIVAL-REFRESH'
          other.access = 'RIVAL-ACCESS'
          other.expires = FAR
          other.tokenGen = 1
        }
      }),
    )
    await ensureAccessToken(rival, row, Date.now())
    expect(await stored('r1')).toMatchObject({
      refresh: 'RIVAL-REFRESH',
      loginRev: 4,
      loginAt: 10,
    })
  })
})

describe('minting bumps the version only when it rotated the refresh token', () => {
  const minter = (refresh: string) =>
    fakeAdapter({
      mintInferenceToken: async () => ({
        access: 'sk-ant-oat01-minted',
        refresh,
        expires: Date.now() + 365 * 24 * 3_600_000,
      }),
    })
  const due = () =>
    testAccount({ id: 'm1', refresh: 'ort-1', tokenGen: 2, loginRev: 6 })

  test('a rotated refresh token', async () => {
    await seed(due())
    expect(await mintToken(minter('ort-2'), 'm1')).toBe(true)
    expect(await stored('m1')).toMatchObject({
      refresh: 'ort-2',
      tokenGen: 3,
      loginRev: 7,
    })
  })

  test('the same refresh token', async () => {
    await seed(due())
    expect(await mintToken(minter('ort-1'), 'm1')).toBe(true)
    expect(await stored('m1')).toMatchObject({ tokenGen: 2, loginRev: 6 })
  })
})
