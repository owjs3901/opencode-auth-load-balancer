import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { findAccount, mutatePool, readPool } from '../pool/store'
import {
  autoTokenEnabled,
  maintainTokens,
  mintAtLogin,
  mintToken,
  tokenDue,
} from '../token-mint'
import type { PoolAccount, TokenSet } from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-mint-'))
const POOL = join(DIR, 'auth-load-balancer.json')
const DAY = 24 * 60 * 60 * 1000
const YEAR = 365 * DAY
const MINTED = 'sk-ant-oat01-minted'

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  delete process.env.OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN
  await rm(POOL, { force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
  delete process.env.OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN
})

// The per-process retry spacing is keyed by row id and outlives a test, so
// every row gets an id of its own.
let seq = 0
function oauthRow(over: Partial<PoolAccount> = {}): PoolAccount {
  seq += 1
  return testAccount({
    id: `mint-${seq}`,
    refresh: 'ort-1',
    tokenGen: 3,
    ...over,
  })
}

async function seed(...rows: PoolAccount[]): Promise<void> {
  await mutatePool((pool) => {
    pool.accounts = rows
  })
}

async function stored(id: string): Promise<PoolAccount | undefined> {
  return findAccount(await readPool(), id)
}

/** A token endpoint minting a one-year token and rotating the refresh token; `onGrant` runs mid-grant. */
function minter(
  over: Partial<TokenSet> = {},
  onGrant: () => Promise<unknown> = async () => undefined,
) {
  const spent: string[] = []
  const adapter = fakeAdapter({
    mintInferenceToken: async (refresh) => {
      spent.push(refresh)
      await onGrant()
      return {
        access: MINTED,
        refresh: 'ort-2',
        expires: Date.now() + YEAR,
        ...over,
      }
    },
  })
  return { adapter, spent }
}

const failing = (onGrant: () => void = () => undefined) =>
  fakeAdapter({
    mintInferenceToken: async () => {
      onGrant()
      throw new Error('Token refresh failed: 400 — invalid_scope')
    },
  })

describe('which rows are due a minted token', () => {
  test('an OAuth row without a token, or with a minted one in its last 30 days', () => {
    const now = Date.now()
    const due = (over: Partial<PoolAccount>) =>
      tokenDue(testAccount({ refresh: 'r', ...over }), now)

    expect(due({})).toBe(true)
    expect(due({ inferenceToken: 't', inferenceExpires: now + 30 * DAY })).toBe(
      true,
    )
    expect(due({ inferenceToken: 't', inferenceExpires: now + 31 * DAY })).toBe(
      false,
    )
    // A pasted token's lifetime is unknown: it is never renewed ahead of time.
    expect(due({ inferenceToken: 'pasted' })).toBe(false)
    expect(due({ refresh: '' })).toBe(false)
    expect(due({ disabledReason: 'manually disabled' })).toBe(false)
  })

  test('on by default; OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN=0/false/no/off turns it off', () => {
    for (const off of ['0', 'false', ' OFF ', 'no'])
      expect(
        autoTokenEnabled({ OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN: off }),
      ).toBe(false)
    for (const on of [undefined, '', '1', 'true'])
      expect(
        autoTokenEnabled({ OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN: on }),
      ).toBe(true)
    expect(autoTokenEnabled()).toBe(true)
  })
})

describe('minting a row its token', () => {
  test('lands the token and when it lapses, keeping the rotated refresh token and the OAuth access token', async () => {
    const row = oauthRow({
      lostLogins: { token: { at: 1, reason: '401 expired' } },
    })
    await seed(row)
    const { adapter, spent } = minter({ refreshExpires: 99 })

    expect(await mintToken(adapter, row.id)).toBe(true)

    expect(spent).toEqual(['ort-1'])
    const after = await stored(row.id)
    expect(after).toMatchObject({
      inferenceToken: MINTED,
      refresh: 'ort-2',
      tokenGen: 4,
      refreshExpires: 99,
      access: row.access,
      expires: row.expires,
    })
    expect((after?.inferenceExpires ?? 0) - Date.now()).toBeGreaterThan(
      YEAR - DAY,
    )
    expect(after).not.toHaveProperty('lostLogins')
  })

  test('a grant that keeps the refresh token leaves its generation alone', async () => {
    const row = oauthRow()
    await seed(row)

    await mintToken(minter({ refresh: 'ort-1' }).adapter, row.id)

    expect(await stored(row.id)).toMatchObject({
      inferenceToken: MINTED,
      refresh: 'ort-1',
      tokenGen: 3,
    })
  })

  test('keeps the rotated refresh token, but pools no token granted less than it asked for', async () => {
    const row = oauthRow()
    await seed(row)
    const { adapter } = minter({ expires: Date.now() + 8 * 60 * 60 * 1000 })

    expect(await mintToken(adapter, row.id)).toBe(false)

    const after = await stored(row.id)
    expect(after).toMatchObject({ refresh: 'ort-2', tokenGen: 4 })
    expect(after).not.toHaveProperty('inferenceToken')
  })

  test('renews a minted token near its end, never a pasted one or a missing row', async () => {
    const near = oauthRow({
      inferenceToken: 'old',
      inferenceExpires: Date.now() + 10 * DAY,
    })
    const pasted = oauthRow({ inferenceToken: 'pasted' })
    await seed(near, pasted)
    const { adapter, spent } = minter()

    expect(await mintToken(adapter, near.id)).toBe(true)
    expect(await mintToken(adapter, pasted.id)).toBe(false)
    expect(await mintToken(adapter, 'missing')).toBe(false)

    expect(spent).toEqual(['ort-1'])
    expect((await stored(near.id))?.inferenceToken).toBe(MINTED)
    expect((await stored(pasted.id))?.inferenceToken).toBe('pasted')
  })

  test('drops a token whose row changed during the grant: re-logged in, deleted, or given a token', async () => {
    const relogged = oauthRow()
    const deleted = oauthRow()
    const pasted = oauthRow()
    await seed(relogged, deleted, pasted)
    let change: (rows: PoolAccount[]) => void = () => undefined
    const { adapter } = minter({}, () =>
      mutatePool((pool) => change(pool.accounts)),
    )

    change = (rows) => {
      const row = rows.find((a) => a.id === relogged.id)
      if (row) row.refresh = 'ort-relogin'
    }
    expect(await mintToken(adapter, relogged.id)).toBe(false)
    change = (rows) => {
      rows.splice(
        rows.findIndex((a) => a.id === deleted.id),
        1,
      )
    }
    expect(await mintToken(adapter, deleted.id)).toBe(false)
    change = (rows) => {
      const row = rows.find((a) => a.id === pasted.id)
      if (row) row.inferenceToken = 'pasted-meanwhile'
    }
    expect(await mintToken(adapter, pasted.id)).toBe(false)

    expect(await stored(relogged.id)).toMatchObject({ refresh: 'ort-relogin' })
    expect(await stored(relogged.id)).not.toHaveProperty('inferenceToken')
    expect(await stored(deleted.id)).toBeUndefined()
    // The grant still spent its refresh token: the rotated one is kept.
    expect(await stored(pasted.id)).toMatchObject({
      inferenceToken: 'pasted-meanwhile',
      refresh: 'ort-2',
    })
  })

  test('a provider that cannot mint, or a refused grant, leaves the row as it was', async () => {
    const row = oauthRow()
    await seed(row)
    const before = await stored(row.id)

    expect(await mintToken(fakeAdapter(), row.id)).toBe(false)
    await expect(mintToken(failing(), row.id)).rejects.toThrow('400')

    // Never read as a dead login: that is the regular refresh's call.
    expect(await stored(row.id)).toEqual(before)
  })
})

describe('minting in the background', () => {
  test("mints each due row of the adapter's provider, leaving rows with a token and other providers alone", async () => {
    const due = oauthRow()
    const codex = oauthRow({ providerID: 'openai' })
    const pasted = oauthRow({ inferenceToken: 'pasted' })
    await seed(due, codex, pasted)
    const { adapter, spent } = minter()

    await maintainTokens(adapter, Date.now(), await readPool())

    expect(spent).toEqual(['ort-1'])
    expect((await stored(due.id))?.inferenceToken).toBe(MINTED)
    expect(await stored(codex.id)).not.toHaveProperty('inferenceToken')
  })

  test('asks a refusing server about a row again only after six hours', async () => {
    const row = oauthRow()
    await seed(row)
    let grants = 0
    const adapter = failing(() => {
      grants += 1
    })
    const now = Date.now()

    await maintainTokens(adapter, now)
    await maintainTokens(adapter, now + 60_000)
    expect(grants).toBe(1)
    await maintainTokens(adapter, now + 6 * 60 * 60 * 1000)
    expect(grants).toBe(2)
    expect(await stored(row.id)).not.toHaveProperty('inferenceToken')
  })

  test('turned off, or for a provider that cannot mint, asks for nothing', async () => {
    const row = oauthRow()
    await seed(row)
    const { adapter, spent } = minter()

    process.env.OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN = 'off'
    await maintainTokens(adapter, Date.now())
    expect(await mintAtLogin(adapter, row)).toBe(false)
    delete process.env.OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN
    await maintainTokens(fakeAdapter(), Date.now())
    expect(await mintAtLogin(fakeAdapter(), row)).toBe(false)

    expect(spent).toEqual([])
  })

  test('a fresh login is minted its token at once, even right after a refused attempt', async () => {
    const row = oauthRow()
    await seed(row)

    expect(await mintAtLogin(failing(), row)).toBe(false)
    expect(await mintAtLogin(minter().adapter, row)).toBe(true)
    expect(await mintAtLogin(minter().adapter, oauthRow({ refresh: '' }))).toBe(
      false,
    )

    expect((await stored(row.id))?.inferenceToken).toBe(MINTED)
  })
})
