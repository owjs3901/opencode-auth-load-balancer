/**
 * Three machines on one in-memory GitHub. pcA and pcB have a GitHub token and
 * their own OAuth login for the SAME Claude account (each minted its own
 * token for it); pcC only has the link, and no rows of its own.
 */
import { rm } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { findAccount, mutatePool } from '../pool/store'
import { seal } from '../sync/crypto'
import { WRITE_BACKOFF_MS } from '../sync/cycle'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'
import { responderFetch } from './fixtures/fetch-mock'
import { createPcs } from './fixtures/pcs'
import { CLAUDE_TOKEN, CLAUDE_TOKEN_2, fakeGithub } from './fixtures/sync'
import {
  claudeSyncAdapter,
  kimiSyncAdapter,
  orgOf,
} from './fixtures/sync-adapters'

const T1 = CLAUDE_TOKEN
const T2 = 'sk-ant-oat01-BBBB_minted-2222'
const T3 = CLAUDE_TOKEN_2
const T4 = 'sk-ant-oat01-DDDD_extra-4444'
const T5 = 'sk-ant-oat01-EEEE_org3_-5555'
const FAR = 4_000_000_000_000

const realFetch = globalThis.fetch
const github = fakeGithub()
const pcs = createPcs('sync-multi')
const { world, on, seed, rows, state, linkOf, run } = pcs
const probes = { count: 0 }

const oauthRow = (id: string, token: string): PoolAccount =>
  testAccount({
    id,
    label: id,
    access: `ACCESS-${id}`,
    refresh: `REFRESH-${id}`,
    orgId: 'org-1',
    inferenceToken: token,
    inferenceExpires: FAR,
  })

const tokenOnly = (id: string, token: string): PoolAccount =>
  testAccount({
    id,
    label: id,
    access: token,
    refresh: '',
    inferenceToken: token,
    orgId: orgOf(token),
  })

const addRow = (pc: string, row: PoolAccount) =>
  on(pc, () =>
    mutatePool((pool) => {
      pool.accounts.push(row)
    }),
  )

const dropToken = (pc: string, id: string) =>
  on(pc, () =>
    mutatePool((pool) => {
      const row = findAccount(pool, id)
      if (row) {
        delete row.inferenceToken
        delete row.inferenceExpires
      }
    }),
  )

const sync = (pc: string) => run(pc, (e) => e.sync())
const round = async () => {
  for (const pc of ['pcA', 'pcB', 'pcC']) await sync(pc)
}
const patches = () => github.calls.filter((c) => c.method === 'PATCH').length
const tokensOf = async (pc: string) =>
  (await rows(pc)).flatMap((r) => (r.inferenceToken ? [r.inferenceToken] : []))
const gistContent = () => [...github.gists.values()][0]?.content ?? ''
const inGist = async () => (await pcs.snapshot('pcA', gistContent())).entries
const secretsInGist = async () =>
  (await inGist()).map((e) => e.secret ?? '').sort()

/** pcA creates the gist from its own OAuth row; pcB follows it with its own row for the same account. */
async function twoWriters(): Promise<string> {
  await seed('pcA', oauthRow('a-oauth', T1))
  await seed('pcB', oauthRow('b-oauth', T2))
  await run('pcA', (e) => e.upload(false))
  const link = await linkOf('pcA')
  await run('pcB', (e) => e.subscribe(link))
  return link
}

/** Fire `during` once, when the next PATCH is about to be sent. */
function onNextPatch(during: () => Promise<unknown>): void {
  github.hooks.before = async (method) => {
    if (method !== 'PATCH') return undefined
    github.hooks.before = undefined
    await during()
    return undefined
  }
}

beforeEach(async () => {
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  github.gists.clear()
  github.calls.length = 0
  github.hooks.before = undefined
  globalThis.fetch = responderFetch(() => github.respond)
  world.clock = 1_000_000
  world.skew.clear()
  world.tokens.clear()
  world.tokens.add('pcA')
  world.tokens.add('pcB')
  probes.count = 0
  const claude = claudeSyncAdapter(orgOf)
  world.adapters = [
    fakeAdapter({
      id: 'anthropic',
      tokenLogin: {
        label: 'setup-token',
        url: '',
        instructions: '',
        exchange: (token) => {
          probes.count += 1
          return claude.tokenLogin?.exchange(token) ?? Promise.resolve(null)
        },
      },
    }),
    kimiSyncAdapter(),
  ]
  await rm(pcs.root, { recursive: true, force: true })
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('two machines that each minted a token for one account', () => {
  test('both tokens stay where they are, nothing ping-pongs, and the third machine ends with one row for the account', async () => {
    const link = await twoWriters()
    await run('pcC', (e) => e.subscribe(link))
    await round()
    expect(await secretsInGist()).toEqual([T1, T2].sort())
    const settled = {
      a: await rows('pcA'),
      b: await rows('pcB'),
      c: await rows('pcC'),
    }
    expect(settled.a.map((r) => [r.id, r.refresh, r.inferenceToken])).toEqual([
      ['a-oauth', 'REFRESH-a-oauth', T1],
    ])
    expect(settled.b.map((r) => [r.id, r.refresh, r.inferenceToken])).toEqual([
      ['b-oauth', 'REFRESH-b-oauth', T2],
    ])
    expect(settled.c).toHaveLength(1)
    expect([T1, T2]).toContain(settled.c[0]?.inferenceToken ?? '')

    const [writes, checked] = [patches(), probes.count]
    for (let i = 0; i < 4; i++) await round()
    expect(patches()).toBe(writes)
    expect(probes.count).toBe(checked)
    expect(await rows('pcA')).toEqual(settled.a)
    expect(await rows('pcB')).toEqual(settled.b)
    expect(await rows('pcC')).toEqual(settled.c)
    expect(Object.keys((await state('pcA'))?.imported ?? {})).toEqual([])
    expect(Object.keys((await state('pcB'))?.imported ?? {})).toEqual([])
  })

  test('an entry kept out by an existing token is not probed again when the gist changes for other reasons', async () => {
    const link = await twoWriters()
    await run('pcC', (e) => e.subscribe(link))
    await round()
    await addRow('pcA', tokenOnly('a-extra', T3))
    const before = probes.count
    await sync('pcA')
    await sync('pcB')
    await sync('pcC')
    expect(probes.count - before).toBe(2)
    expect(await tokensOf('pcB')).toContain(T3)
    expect(await tokensOf('pcC')).toContain(T3)
    expect((await rows('pcC')).filter((r) => r.orgId === 'org-1')).toHaveLength(
      1,
    )
  })

  test('when the machine whose token a third machine imported removes it, the other token is imported in the same cycle', async () => {
    await seed('pcA', oauthRow('a-oauth', T1))
    await seed('pcB', oauthRow('b-oauth', T2))
    await run('pcA', (e) => e.upload(false))
    const link = await linkOf('pcA')
    await run('pcC', (e) => e.subscribe(link))
    expect(await tokensOf('pcC')).toEqual([T1])
    await run('pcB', (e) => e.subscribe(link))
    await sync('pcC')
    expect(await tokensOf('pcC')).toEqual([T1])
    expect(Object.keys((await state('pcC'))?.skipped ?? {})).toHaveLength(1)

    await dropToken('pcA', 'a-oauth')
    expect((await sync('pcA')).message).toBe(
      'Synced: 1 added, 0 updated, 0 removed. Uploaded 0 credentials.',
    )
    expect(await secretsInGist()).toEqual([T2])
    expect((await sync('pcC')).message).toBe(
      'Synced: 1 added, 0 updated, 1 removed.',
    )
    expect(await tokensOf('pcC')).toEqual([T2])
    expect(await rows('pcC')).toHaveLength(1)
    expect(Object.keys((await state('pcC'))?.skipped ?? {})).toEqual([])

    expect((await sync('pcA')).message).toBe('Up to date.')
    expect(await tokensOf('pcA')).toEqual([T2])
    const writes = patches()
    for (let i = 0; i < 3; i++) await round()
    expect(patches()).toBe(writes)
    expect(await secretsInGist()).toEqual([T2])
    expect(await tokensOf('pcA')).toEqual([T2])
    expect(await tokensOf('pcB')).toEqual([T2])
    expect(await tokensOf('pcC')).toEqual([T2])
  })

  test('a removed blocker frees an entry even when the gist itself did not change', async () => {
    await seed('pcA', oauthRow('a-oauth', T1))
    await seed('pcB', oauthRow('b-oauth', T2))
    await run('pcA', (e) => e.upload(false))
    const link = await linkOf('pcA')
    await run('pcC', (e) => e.subscribe(link))
    await run('pcB', (e) => e.subscribe(link))
    await sync('pcC')
    expect(await tokensOf('pcC')).toEqual([T1])
    await on('pcC', () =>
      mutatePool((pool) => {
        pool.accounts = []
      }),
    )
    expect((await sync('pcC')).message).toBe(
      'Synced: 1 added, 0 updated, 0 removed.',
    )
    expect(await rows('pcC')).toHaveLength(1)
  })
})

describe('writers that overlap', () => {
  test('a write that overwrites another with a stale list is healed by the next cycle of the machine that lost', async () => {
    await twoWriters()
    await sync('pcA')
    await addRow('pcA', tokenOnly('a-new', T3))
    await addRow('pcB', tokenOnly('b-new', T4))
    onNextPatch(() => sync('pcA'))
    await sync('pcB')
    expect(await secretsInGist()).toEqual([T1, T2, T4].sort())

    await sync('pcA')
    expect(await secretsInGist()).toEqual([T1, T2, T3, T4].sort())
    expect((await sync('pcB')).message).toBe(
      'Synced: 1 added, 0 updated, 0 removed.',
    )
    expect(await tokensOf('pcB')).toContain(T3)
    const writes = patches()
    for (let i = 0; i < 3; i++) await round()
    expect(patches()).toBe(writes)
    expect(await secretsInGist()).toEqual([T1, T2, T3, T4].sort())
  })

  test('a removal is not resurrected by a stale write: the machine that removed it removes it again', async () => {
    const link = await twoWriters()
    await run('pcC', (e) => e.subscribe(link))
    await addRow('pcB', tokenOnly('b-new', T4))
    await dropToken('pcA', 'a-oauth')
    onNextPatch(() => sync('pcA'))
    await sync('pcB')
    expect(await secretsInGist()).toEqual([T1, T2, T4].sort())

    await sync('pcA')
    expect(await secretsInGist()).toEqual([T2, T4].sort())
    for (let i = 0; i < 3; i++) await round()
    expect(await secretsInGist()).toEqual([T2, T4].sort())
    for (const pc of ['pcA', 'pcB', 'pcC'])
      expect(await tokensOf(pc)).not.toContain(T1)
    const writes = patches()
    await round()
    expect(patches()).toBe(writes)
  })

  test('a machine whose clock is ten minutes behind writes snapshots the others accept', async () => {
    const link = await twoWriters()
    await run('pcC', (e) => e.subscribe(link))
    world.skew.set('pcB', -600_000)
    world.clock += 5_000
    await addRow('pcB', tokenOnly('b-new', T4))
    const before = (await pcs.snapshot('pcA', gistContent())).at
    const out = await sync('pcB')
    expect(out.ok).toBe(true)
    const stamped = (await pcs.snapshot('pcA', gistContent())).at
    expect(stamped).toBe(before + 1)
    for (const pc of ['pcA', 'pcC']) {
      const got = await sync(pc)
      expect(got.ok).toBe(true)
      expect(got.message).not.toContain('older')
    }
    expect(await secretsInGist()).toEqual([T1, T2, T4].sort())
    await addRow('pcB', tokenOnly('b-newer', T3))
    expect((await sync('pcB')).ok).toBe(true)
    expect((await sync('pcA')).ok).toBe(true)
    expect(await tokensOf('pcA')).toContain(T3)
  })

  test('a snapshot older than one already applied is written over by a machine that can write, and a link-only machine waits for that', async () => {
    const link = await twoWriters()
    await run('pcC', (e) => e.subscribe(link))
    world.skew.set('pcB', -600_000)
    await addRow('pcB', tokenOnly('b-new', T4))
    await addRow('pcA', tokenOnly('a-new', T3))
    world.clock += 60_000
    onNextPatch(async () => {
      await sync('pcA')
      await sync('pcA')
    })
    await sync('pcB')
    const stale = (await pcs.snapshot('pcA', gistContent())).at
    expect((await state('pcA'))?.appliedAt).toBeGreaterThan(stale)

    const waiting = await sync('pcC')
    expect(waiting.ok).toBe(true)
    const out = await sync('pcA')
    expect(out.ok).toBe(true)
    const healed = (await pcs.snapshot('pcA', gistContent())).at
    expect(healed).toBeGreaterThan(stale)
    expect(await secretsInGist()).toEqual([T1, T2, T3, T4].sort())
    expect((await sync('pcC')).ok).toBe(true)
    expect((await sync('pcB')).ok).toBe(true)
    expect(await tokensOf('pcC')).toContain(T3)
  })
})

describe('a cycle that fails after it applied the gist', () => {
  test.each([
    ['a server error', () => new Response('{}', { status: 500 })],
    [
      'a rate limit',
      () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '120' } }),
    ],
    [
      'a network error',
      (): Response => {
        throw new TypeError('network down')
      },
    ],
  ])(
    'keeps what it imported on record when the upload fails with %s, so a removal still reaches it',
    async (_name, fail) => {
      await seed('pcA', oauthRow('a-oauth', T1))
      await seed('pcB', tokenOnly('b-local', T3))
      await run('pcA', (e) => e.upload(false))
      const link = await linkOf('pcA')
      let failed = false
      github.hooks.before = (method) => {
        if (method !== 'PATCH' || failed) return undefined
        failed = true
        return fail()
      }
      const out = await run('pcB', (e) => e.subscribe(link))
      expect(out.ok).toBe(false)
      expect(await tokensOf('pcB')).toEqual([T3, T1])
      const kept = await state('pcB')
      expect(Object.keys(kept?.imported ?? {})).toHaveLength(1)
      expect(kept?.etag).toBeUndefined()
      expect(kept?.appliedAt).toBeDefined()

      expect((await sync('pcB')).ok).toBe(true)
      const listed = await inGist()
      const aOrigin = listed.find((e) => e.id === 'a-oauth')?.origin
      expect(
        listed.filter((e) => e.secret === T1).map((e) => e.origin),
      ).toEqual([aOrigin])
      expect(listed.some((e) => e.secret === T3)).toBe(true)

      await dropToken('pcA', 'a-oauth')
      for (const pc of ['pcA', 'pcB', 'pcB']) await sync(pc)
      expect(await tokensOf('pcB')).not.toContain(T1)
      expect(await secretsInGist()).not.toContain(T1)
    },
  )
})
describe('what a machine may do depends on its GitHub account', () => {
  test('a link-only machine downloads, never writes, never sends a credential, and does not nag', async () => {
    const link = await twoWriters()
    await run('pcC', (e) => e.subscribe(link))
    const before = github.calls.length
    const messages: string[] = []
    for (let i = 0; i < 3; i++) messages.push((await sync('pcC')).message)
    expect(messages).toEqual(['Up to date.', 'Up to date.', 'Up to date.'])
    const mine = github.calls.slice(before)
    expect(mine.every((c) => c.method === 'GET')).toBe(true)
    expect(mine.every((c) => c.authorization === null)).toBe(true)
    expect(await run('pcC', (e) => e.unpublishedDigest())).toBeNull()
    expect((await state('pcC'))?.write).toBe('no-token')
    const forced = await run('pcC', (e) => e.upload(false))
    expect(forced).toMatchObject({ ok: false })
    expect(forced.message).toContain('GITHUB_TOKEN')
  })

  test('a machine with a token reads with it, and a token that appears later turns uploading on', async () => {
    const link = await twoWriters()
    await run('pcC', (e) => e.subscribe(link))
    await addRow('pcC', tokenOnly('c-own', T3))
    expect(await run('pcC', (e) => e.unpublishedDigest())).toBeNull()
    expect(await secretsInGist()).toEqual([T1, T2].sort())
    world.tokens.add('pcC')
    const before = github.calls.length
    const out = await sync('pcC')
    expect(out.message).toBe('Uploaded 1 credential.')
    const mine = github.calls.slice(before)
    expect(mine.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH'])
    expect(mine.every((c) => c.authorization === 'Bearer ghp_pcC')).toBe(true)
    expect(await secretsInGist()).toEqual([T1, T2, T3].sort())
    expect((await state('pcC'))?.write).toBe('ok')
  })

  test.each([403, 404])(
    'a PATCH answered %i turns uploading off for an hour, once, and downloads go on',
    async (status) => {
      const link = await twoWriters()
      await run('pcC', (e) => e.subscribe(link))
      await addRow('pcB', tokenOnly('b-new', T4))
      github.hooks.before = (method) =>
        method === 'PATCH' ? new Response('{}', { status }) : undefined
      const first = await sync('pcB')
      expect(first).toEqual({
        ok: true,
        message:
          'Up to date. This GitHub account cannot update the gist; downloading only.',
      })
      const refused = patches()
      expect(await run('pcB', (e) => e.unpublishedDigest())).toBeNull()
      const s = await state('pcB')
      expect(s).toMatchObject({ write: 'denied' })
      expect(s?.writeCheckAt).toBe(world.clock + WRITE_BACKOFF_MS)

      github.hooks.before = undefined
      await addRow('pcA', tokenOnly('a-new', T3))
      await sync('pcA')
      const again = await sync('pcB')
      expect(again.message).toBe('Synced: 1 added, 0 updated, 0 removed.')
      expect(patches() - refused).toBe(1)
      expect(await tokensOf('pcB')).toContain(T3)
      expect((await state('pcB'))?.write).toBe('denied')

      world.clock += WRITE_BACKOFF_MS
      expect(await run('pcB', (e) => e.unpublishedDigest())).not.toBeNull()
      expect((await sync('pcB')).message).toBe('Uploaded 2 credentials.')
      expect((await state('pcB'))?.write).toBe('ok')
      expect(await secretsInGist()).toContain(T4)
    },
  )

  test('Upload now tries again inside the back-off', async () => {
    await twoWriters()
    await addRow('pcB', tokenOnly('b-new', T4))
    github.hooks.before = (method) =>
      method === 'PATCH' ? new Response('{}', { status: 403 }) : undefined
    await sync('pcB')
    const refused = patches()
    github.hooks.before = undefined
    const out = await run('pcB', (e) => e.upload(false))
    expect(out.message).toBe('Uploaded 2 credentials.')
    expect(patches()).toBe(refused + 1)
    expect((await state('pcB'))?.write).toBe('ok')
  })

  test('a snapshot with an entry this version cannot read is never rewritten: download only, with one short note', async () => {
    const link = await twoWriters()
    const s = await state('pcA')
    const snap = await pcs.snapshot('pcA', gistContent())
    const future = {
      origin: 'e'.repeat(32),
      id: 'x1',
      providerID: 'future-provider',
      label: 'x',
      secret: 'some-future-secret',
    }
    const key = Buffer.from(s?.key ?? '', 'base64url')
    const forged = seal(
      JSON.stringify({
        v: 2,
        at: snap.at + 10,
        entries: [...snap.entries, future],
      }),
      key,
    )
    for (const gist of github.gists.values()) {
      gist.content = forged
      gist.etag += 1
    }
    await run('pcC', (e) => e.subscribe(link))
    await addRow('pcB', tokenOnly('b-new', T4))
    const writes = patches()
    const first = await sync('pcB')
    expect(first.message).toBe(
      'Up to date. The gist has entries this version cannot read; update this plugin to upload.',
    )
    expect(patches()).toBe(writes)
    expect(gistContent()).toBe(forged)
    expect((await state('pcB'))?.write).toBe('unreadable')
    expect(await run('pcB', (e) => e.unpublishedDigest())).toBeNull()

    await addRow('pcA', tokenOnly('a-new', T3))
    await sync('pcA')
    expect(gistContent()).toBe(forged)
    const second = await sync('pcB')
    expect(second.message).toBe('Up to date.')
    expect(patches()).toBe(writes)
  })
})

describe('leaving and coming back, and awkward ids', () => {
  test('stopping and following the same link again keeps the origin and lists nothing twice', async () => {
    await seed('pcA', oauthRow('a-oauth', T1))
    await seed('pcB', tokenOnly('b-own', T3))
    await run('pcA', (e) => e.upload(false))
    const link = await linkOf('pcA')
    await run('pcB', (e) => e.subscribe(link))
    const once = await inGist()
    const origin = once.find((e) => e.id === 'b-own')?.origin
    expect(origin).toMatch(/^[\da-f]{32}$/)
    expect(await tokensOf('pcB')).toEqual([T3, T1])

    await run('pcB', (e) => e.forget())
    await run('pcB', (e) => e.subscribe(link))
    await sync('pcA')
    await sync('pcB')
    await sync('pcA')
    const after = await inGist()
    expect(after.filter((e) => e.secret === T3)).toHaveLength(1)
    expect(after.filter((e) => e.secret === T1)).toHaveLength(1)
    expect(after.find((e) => e.id === 'b-own')?.origin).toBe(origin)
    expect(await tokensOf('pcB')).toEqual([T3, T1])
    const writes = patches()
    await round()
    expect(patches()).toBe(writes)
  })

  test('ids such as __proto__ and constructor are told apart by origin and stay ordinary', async () => {
    await seed('pcA', tokenOnly('constructor', T1), tokenOnly('__proto__', T5))
    await seed('pcB', tokenOnly('constructor', T3))
    await run('pcA', (e) => e.upload(false))
    const link = await linkOf('pcA')
    await run('pcB', (e) => e.subscribe(link))
    await run('pcC', (e) => e.subscribe(link))
    await round()
    const listed = await inGist()
    expect(listed.map((e) => e.id).sort()).toEqual([
      '__proto__',
      'constructor',
      'constructor',
    ])
    expect(new Set(listed.map((e) => e.origin)).size).toBe(2)
    expect(await tokensOf('pcC')).toHaveLength(3)
    for (const pc of ['pcB', 'pcC']) {
      const imported = (await state(pc))?.imported ?? {}
      expect(Object.getPrototypeOf(imported)).toBeNull()
      expect(
        Object.keys(imported)
          .map((k) => k.split('/')[1])
          .includes('__proto__'),
      ).toBe(true)
    }
    const writes = patches()
    await round()
    expect(patches()).toBe(writes)
    expect(Object.hasOwn({}, 'constructor')).toBe(false)
  })
})
