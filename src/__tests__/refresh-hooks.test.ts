import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { poolFilePath } from '../pool/paths'
import { findAccount, mutatePool, readPool } from '../pool/store'
import { ensureAccessToken } from '../refresh'
import {
  getRefreshHooks,
  type RefreshHooks,
  setRefreshHooks,
} from '../refresh-hooks'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-refresh-hooks-'))
const FAR = 4_000_000_000_000
const INVALID_GRANT = 'Token refresh failed: 400 — invalid_grant'

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(poolFilePath(), { force: true })
  setRefreshHooks(null)
})
afterEach(() => {
  setRefreshHooks(null)
  delete process.env.OPENCODE_AUTH_LB_DIR
})

const expired = (over: Partial<PoolAccount> = {}) =>
  testAccount({
    id: 'r1',
    access: 'OLD-ACCESS',
    refresh: 'OLD-REFRESH',
    expires: 0,
    tokenGen: 0,
    ...over,
  })
const seed = (row: PoolAccount) =>
  mutatePool((pool) => {
    pool.accounts = [row]
  })
const stored = async () => findAccount(await readPool(), 'r1')

/** An adapter that records the refresh tokens it is asked to spend. */
function adapterFor(fail = false) {
  const posts: string[] = []
  const adapter = fakeAdapter({
    refresh: async (refresh) => {
      posts.push(refresh)
      if (fail) throw new Error(INVALID_GRANT)
      return { access: 'NEW-ACCESS', refresh: 'NEW-REFRESH', expires: FAR }
    },
  })
  return { adapter, posts }
}

/** What another machine's refresh leaves on the row: a newer pair, a newer generation. */
const adoptPair = (access: string, refresh: string, expires: number) =>
  mutatePool((pool) => {
    const row = findAccount(pool, 'r1')
    if (!row) return
    Object.assign(row, { access, refresh, expires })
    row.tokenGen = (row.tokenGen ?? 0) + 1
    row.loginRev = 9
  })

describe('pulling a shared login before the provider is asked', () => {
  test('a usable newer token that was pulled is used and nothing is posted', async () => {
    await seed(expired())
    const { adapter, posts } = adapterFor()
    const asked: boolean[] = []
    setRefreshHooks({
      pull: async (_row, recovery) => {
        asked.push(recovery)
        await adoptPair('PULLED-ACCESS', 'PULLED-REFRESH', FAR)
        return true
      },
    })
    const row = expired()
    expect(await ensureAccessToken(adapter, row, Date.now())).toBe(
      'PULLED-ACCESS',
    )
    expect(posts).toEqual([])
    expect(asked).toEqual([false])
    expect(row).toMatchObject({
      access: 'PULLED-ACCESS',
      refresh: 'PULLED-REFRESH',
    })
  })

  test('a pulled token that still needs a refresh is the one that is spent, exactly once', async () => {
    await seed(expired())
    const { adapter, posts } = adapterFor()
    setRefreshHooks({
      pull: async () => {
        await adoptPair('PULLED-ACCESS', 'PULLED-REFRESH', 0)
        return true
      },
    })
    expect(await ensureAccessToken(adapter, expired(), Date.now())).toBe(
      'NEW-ACCESS',
    )
    expect(posts).toEqual(['PULLED-REFRESH'])
    expect(await stored()).toMatchObject({
      refresh: 'NEW-REFRESH',
      tokenGen: 2,
    })
  })

  test('a pull that adopts nothing, or throws, changes nothing', async () => {
    for (const pull of [
      async () => false,
      async () => {
        throw new Error('gist down')
      },
    ]) {
      await seed(expired())
      const { adapter, posts } = adapterFor()
      setRefreshHooks({ pull })
      await ensureAccessToken(adapter, expired(), Date.now())
      expect(posts).toEqual(['OLD-REFRESH'])
    }
  })

  test('without hooks a refresh is as before', async () => {
    expect(getRefreshHooks()).toBeNull()
    await seed(expired())
    const { adapter, posts } = adapterFor()
    await ensureAccessToken(adapter, expired(), Date.now())
    expect(posts).toEqual(['OLD-REFRESH'])
  })

  test('a token that is still fresh is not pulled for', async () => {
    let pulls = 0
    setRefreshHooks({
      pull: async () => {
        pulls += 1
        return false
      },
    })
    const fresh = expired({ expires: FAR })
    await ensureAccessToken(adapterFor().adapter, fresh, Date.now())
    expect(pulls).toBe(0)
  })
})

describe('recovering from a refused refresh token', () => {
  test('a successor found in the gist is adopted: no post for it, no lost login, no disable', async () => {
    await seed(expired())
    const { adapter, posts } = adapterFor(true)
    const asked: boolean[] = []
    setRefreshHooks({
      pull: async (_row, recovery) => {
        asked.push(recovery)
        if (!recovery) return false
        await adoptPair('SUCC-ACCESS', 'SUCC-REFRESH', FAR)
        return true
      },
    })
    const row = expired()
    expect(await ensureAccessToken(adapter, row, Date.now())).toBe(
      'SUCC-ACCESS',
    )
    expect(posts).toEqual(['OLD-REFRESH'])
    expect(asked).toEqual([false, true])
    const after = await stored()
    expect(after).toMatchObject({
      refresh: 'SUCC-REFRESH',
      disabledReason: null,
    })
    expect(after).not.toHaveProperty('lostLogins')
    expect(row.disabledReason).toBeNull()
  })

  test('without a successor the login is lost as before', async () => {
    await seed(expired())
    const { adapter, posts } = adapterFor(true)
    setRefreshHooks({ pull: async () => false })
    await expect(
      ensureAccessToken(adapter, expired(), Date.now()),
    ).rejects.toThrow('invalid_grant')
    expect(posts).toEqual(['OLD-REFRESH'])
    expect((await stored())?.disabledReason).toContain('invalid_grant')
  })
})

describe('announcing a refresh', () => {
  const slow = () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        await gate
        return { access: 'NEW-ACCESS', refresh: 'NEW-REFRESH', expires: FAR }
      },
    })
    return { adapter, release }
  }

  test('once for the call that refreshed, never for a joiner or a fresh token', async () => {
    await seed(expired())
    let announced = 0
    setRefreshHooks({ afterRefresh: () => (announced += 1) })
    const { adapter, release } = slow()
    const [first, joiner] = [expired(), expired()]
    const both = Promise.all([
      ensureAccessToken(adapter, first, Date.now()),
      ensureAccessToken(adapter, joiner, Date.now()),
    ])
    release()
    expect(await both).toEqual(['NEW-ACCESS', 'NEW-ACCESS'])
    expect(announced).toBe(1)
    await ensureAccessToken(adapter, first, Date.now())
    expect(announced).toBe(1)
  })

  test('a failing announcement never fails the request', async () => {
    await seed(expired())
    const hooks: RefreshHooks = {
      afterRefresh: () => {
        throw new Error('boom')
      },
    }
    setRefreshHooks(hooks)
    expect(
      await ensureAccessToken(adapterFor().adapter, expired(), Date.now()),
    ).toBe('NEW-ACCESS')
  })
})
