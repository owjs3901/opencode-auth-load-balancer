import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { findAccount, mutatePool } from '../pool/store'
import { ensureAccessToken, withRefreshLock } from '../refresh'
import { getRefreshHooks, setRefreshHooks } from '../refresh-hooks'
import { encodeKey, generateKey, seal } from '../sync/crypto'
import { createPullLogin, pullLogin } from '../sync/login-hooks'
import { startSync } from '../sync/start'
import { updateSyncState } from '../sync/state'
import { MANUAL_DISABLED_REASON, type PoolAccount } from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'
import { responderFetch } from './fixtures/fetch-mock'
import { createPcs } from './fixtures/pcs'
import { fakeGithub } from './fixtures/sync'

const FAR = 4_000_000_000_000
const INVALID_GRANT = 'Token refresh failed: 400 — invalid_grant'
const realFetch = globalThis.fetch
let link = ''
const github = fakeGithub()
const pcs = createPcs('login-pull')
const { world, on, seed, rows, linkOf, run } = pcs

const withToken = createPullLogin(() => Promise.resolve('ghp_pull'))
const anonymous = createPullLogin(() => Promise.reject(new Error('no gh')))

const loginRow = (id: string, over: Partial<PoolAccount> = {}) =>
  testAccount({
    id,
    providerID: 'openai',
    label: id,
    access: `ACCESS-${id}`,
    refresh: `REFRESH-${id}`,
    expires: FAR,
    accountId: 'acct-1',
    loginRev: 1,
    loginAt: 1_000,
    ...over,
  })

const gistContent = () => [...github.gists.values()][0]?.content ?? ''
const patches = () => github.calls.filter((c) => c.method === 'PATCH').length

/** What a refresh does to a row: a new pair, a new generation, a new revision. */
const refreshed = (pc: string, id: string, access: string, refresh: string) =>
  on(pc, () =>
    mutatePool((pool) => {
      const row = findAccount(pool, id)
      if (!row) return
      Object.assign(row, { access, refresh, expires: FAR })
      row.tokenGen = (row.tokenGen ?? 0) + 1
      row.loginRev = (row.loginRev ?? 1) + 1
      row.loginAt = world.clock
    }),
  )

const expireOn = (pc: string, id: string) =>
  on(pc, () =>
    mutatePool((pool) => {
      const row = findAccount(pool, id)
      if (row) row.expires = 0
    }),
  )

/** pcA made a gist from its login a1; pcB follows it and holds its own copy of the login. */
async function shared(): Promise<PoolAccount> {
  await seed('pcA', loginRow('a1'))
  await run('pcA', (e) => e.upload(false))
  link = await linkOf('pcA')
  await run('pcB', (e) => e.subscribe(link))
  const [b] = await rows('pcB')
  if (!b) throw new Error('pcB did not adopt the login')
  return b
}

beforeEach(async () => {
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.OPENCODE_AUTH_LB_SYNC
  delete process.env.OPENCODE_AUTH_LB_SYNC_LOGINS
  github.gists.clear()
  github.calls.length = 0
  github.hooks.before = undefined
  globalThis.fetch = responderFetch(() => github.respond)
  world.clock = 1_000_000
  world.skew.clear()
  world.tokens.clear()
  world.tokens.add('pcA')
  world.tokens.add('pcB')
  setRefreshHooks(null)
  await rm(pcs.root, { recursive: true, force: true })
  link = ''
})
afterEach(() => {
  globalThis.fetch = realFetch
  setRefreshHooks(null)
  delete process.env.OPENCODE_AUTH_LB_SYNC
  delete process.env.OPENCODE_AUTH_LB_SYNC_LOGINS
})

/** pcA's login is in the gist; pcA then refreshes and publishes it; pcB holds the older copy. */
async function aPublishedARefresh(
  over: Partial<PoolAccount> = {},
): Promise<PoolAccount> {
  await seed('pcA', loginRow('a1', over))
  await run('pcA', (e) => e.upload(false))
  link = await linkOf('pcA')
  await run('pcB', (e) => e.subscribe(link))
  world.clock += 1_000
  await refreshed('pcA', 'a1', 'ACCESS-a2', 'REFRESH-a2')
  await run('pcA', (e) => e.sync())
  const [b] = await rows('pcB')
  if (!b) throw new Error('pcB did not adopt the login')
  return b
}

describe('pulling a login from the gist', () => {
  test('a newer login is put on the row, even while the caller holds the refresh lock', async () => {
    const b = await aPublishedARefresh()
    const pulled = await on('pcB', () =>
      withRefreshLock('openai', b.id, () => withToken(b, false)),
    )
    expect(pulled).toBe(true)
    expect((await rows('pcB'))[0]).toMatchObject({
      id: b.id,
      access: 'ACCESS-a2',
      refresh: 'REFRESH-a2',
      loginRev: 2,
      tokenGen: 2,
    })
    expect(github.calls.at(-1)?.authorization).toBe('Bearer ghp_pull')
  })

  test('it keeps what the cycle keeps: manual disable, label, inference token', async () => {
    const b = await aPublishedARefresh()
    await on('pcB', () =>
      mutatePool((pool) => {
        const row = findAccount(pool, b.id)
        if (row) {
          row.disabledReason = MANUAL_DISABLED_REASON
          row.inferenceToken = 'sk-ant-oat01-keep'
        }
      }),
    )
    const [current] = await rows('pcB')
    expect(await on('pcB', () => anonymous(current ?? b, true))).toBe(true)
    expect((await rows('pcB'))[0]).toMatchObject({
      disabledReason: MANUAL_DISABLED_REASON,
      inferenceToken: 'sk-ant-oat01-keep',
      label: 'a1',
      refresh: 'REFRESH-a2',
    })
    expect(github.calls.at(-1)?.authorization).toBeNull()
  })

  test('an older or equal login, and a key the gist lacks, adopt nothing', async () => {
    const b = await shared()
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    const newer = { ...b, loginRev: 5 }
    expect(await on('pcB', () => withToken(newer, false))).toBe(false)
    const other = { ...b, accountId: 'acct-other' }
    expect(await on('pcB', () => withToken(other, false))).toBe(false)
  })

  test('a copy of the login for another organization is not the same login', async () => {
    const b = await aPublishedARefresh({ orgId: 'org-1' })
    const elsewhere = { ...b, orgId: 'org-x' }
    expect(await on('pcB', () => withToken(elsewhere, false))).toBe(false)
    expect(await on('pcB', () => withToken(b, false))).toBe(true)
  })

  test('a row that moved on since it was read is left alone', async () => {
    const b = await aPublishedARefresh()
    await on('pcB', () =>
      mutatePool((pool) => {
        const row = findAccount(pool, b.id)
        if (row) row.tokenGen = 7
      }),
    )
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    expect((await rows('pcB'))[0]?.refresh).toBe('REFRESH-a1')
  })

  test.each([
    ['no refresh token', { refresh: '' }],
    ['no known account', { accountId: null }],
    ['a provider that is not shared', { providerID: 'future' }],
  ])('a row with %s is not looked up at all', async (_name, over) => {
    const b = await aPublishedARefresh()
    const before = github.calls.length
    expect(await on('pcB', () => withToken({ ...b, ...over }, false))).toBe(
      false,
    )
    expect(github.calls).toHaveLength(before)
  })

  test('sync off, login sharing off, or a machine that follows nothing: no look-up', async () => {
    const b = await aPublishedARefresh()
    const before = github.calls.length
    process.env.OPENCODE_AUTH_LB_SYNC = '0'
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    delete process.env.OPENCODE_AUTH_LB_SYNC
    process.env.OPENCODE_AUTH_LB_SYNC_LOGINS = 'off'
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    delete process.env.OPENCODE_AUTH_LB_SYNC_LOGINS
    expect(await on('pcC', () => withToken(b, false))).toBe(false)
    expect(github.calls).toHaveLength(before)
  })

  test('an unreachable, garbled or foreign-key gist adopts nothing and throws nothing', async () => {
    const b = await aPublishedARefresh()
    github.hooks.before = () => new Response('{}', { status: 500 })
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    github.hooks.before = undefined
    const good = gistContent()
    for (const gist of github.gists.values()) gist.content = 'garbage'
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    for (const gist of github.gists.values())
      gist.content = seal(
        JSON.stringify({ v: 3, at: 1, entries: [] }),
        generateKey(),
      )
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    for (const gist of github.gists.values()) gist.content = good
    await on('pcB', () =>
      updateSyncState(
        (cur) => cur && { ...cur, key: encodeKey(generateKey()) },
      ),
    )
    expect(await on('pcB', () => withToken(b, false))).toBe(false)
    expect((await rows('pcB'))[0]?.refresh).toBe('REFRESH-a1')
  })

  test('the default hook reads the same way', async () => {
    const b = await aPublishedARefresh()
    expect(await on('pcB', () => pullLogin(b, false))).toBe(true)
  })
})

describe('two machines and the refresh path', () => {
  const adapterFor = (posts: string[]) =>
    fakeAdapter({
      id: 'openai',
      refresh: async (refresh) => {
        posts.push(refresh)
        return { access: 'B-ACCESS', refresh: 'B-REFRESH', expires: FAR }
      },
    })

  test('a refresh on A is published at once, and B near expiry takes it without any provider post', async () => {
    const b = await shared()
    await expireOn('pcA', 'a1')
    const aPosts: string[] = []
    const aAdapter = fakeAdapter({
      id: 'openai',
      refresh: async (refresh) => {
        aPosts.push(refresh)
        return { access: 'A-ACCESS', refresh: 'A-REFRESH', expires: FAR }
      },
    })
    let published: Promise<unknown> = Promise.resolve()
    setRefreshHooks({
      afterRefresh: () => {
        published = pcs.engine().sync()
      },
    })
    const [aRow] = await rows('pcA')
    await on('pcA', async () => {
      await ensureAccessToken(aAdapter, aRow ?? loginRow('a1'), Date.now())
      await published
    })
    expect(aPosts).toEqual(['REFRESH-a1'])
    expect(patches()).toBe(1)

    await expireOn('pcB', b.id)
    const bPosts: string[] = []
    setRefreshHooks({ pull: withToken })
    const [bRow] = await rows('pcB')
    const access = await on('pcB', () =>
      ensureAccessToken(adapterFor(bPosts), bRow ?? b, Date.now()),
    )
    expect(access).toBe('A-ACCESS')
    expect(bPosts).toEqual([])
    expect((await rows('pcB'))[0]).toMatchObject({ refresh: 'A-REFRESH' })
  })

  test('B holding the spent token is refused, finds A’s successor in the gist and keeps the login', async () => {
    const b = await shared()
    world.clock += 1_000
    await refreshed('pcA', 'a1', 'ACCESS-a2', 'REFRESH-a2')
    await expireOn('pcB', b.id)
    const posts: string[] = []
    const refusing = fakeAdapter({
      id: 'openai',
      refresh: async (refresh) => {
        posts.push(refresh)
        await run('pcA', (e) => e.sync())
        throw new Error(INVALID_GRANT)
      },
    })
    setRefreshHooks({ pull: withToken })
    const [bRow] = await rows('pcB')
    const access = await on('pcB', () =>
      ensureAccessToken(refusing, bRow ?? b, Date.now()),
    )
    expect(access).toBe('ACCESS-a2')
    expect(posts).toEqual(['REFRESH-a1'])
    const after = (await rows('pcB'))[0]
    expect(after).toMatchObject({ refresh: 'REFRESH-a2', disabledReason: null })
    expect(after).not.toHaveProperty('lostLogins')
  })
})

describe('starting sync plugs into the refresh path', () => {
  const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-start-hooks-'))

  test('login sharing on registers both hooks and dispose removes them; off registers none', async () => {
    const was = process.env.OPENCODE_AUTH_LB_DIR
    process.env.OPENCODE_AUTH_LB_DIR = DIR
    try {
      const off = (() => {
        process.env.OPENCODE_AUTH_LB_SYNC_LOGINS = '0'
        const loop = startSync()
        delete process.env.OPENCODE_AUTH_LB_SYNC_LOGINS
        return loop
      })()
      expect(getRefreshHooks()).toBeNull()
      await off?.dispose()

      const loop = startSync()
      expect(getRefreshHooks()?.pull).toBe(pullLogin)
      getRefreshHooks()?.afterRefresh?.()
      await loop?.dispose()
      expect(getRefreshHooks()).toBeNull()
    } finally {
      if (was === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
      else process.env.OPENCODE_AUTH_LB_DIR = was
    }
  })
})
