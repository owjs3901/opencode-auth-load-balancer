/**
 * Machines on one in-memory GitHub, sharing OAuth logins: a login made, then
 * refreshed, then re-made on either machine reaches the other; a deleted row
 * stays deleted; and the switch that turns login sharing off carries what is
 * in the gist over untouched.
 */
import { rm } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { addAccount } from '../accounts'
import { bumpLoginRev } from '../login-rev'
import { findAccount, mutatePool } from '../pool/store'
import { decodeKey, fingerprint, open, seal } from '../sync/crypto'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'
import { responderFetch } from './fixtures/fetch-mock'
import { createPcs } from './fixtures/pcs'
import {
  CLAUDE_TOKEN,
  CLAUDE_TOKEN_2,
  fakeGithub,
  KIMI_KEY,
} from './fixtures/sync'

const FAR = 4_000_000_000_000
const realFetch = globalThis.fetch
const github = fakeGithub()
const pcs = createPcs('logins-multi')
const { world, on, seed, rows, state, linkOf, run } = pcs

const loginRow = (
  id: string,
  accountId = 'acct-1',
  over: Partial<PoolAccount> = {},
) =>
  testAccount({
    id,
    providerID: 'openai',
    label: id,
    access: `ACCESS-${id}`,
    refresh: `REFRESH-${id}`,
    expires: FAR,
    accountId,
    loginRev: 1,
    loginAt: 1_000,
    ...over,
  })

const tokenOnly = (id: string, token: string): PoolAccount =>
  testAccount({
    id,
    label: id,
    access: token,
    refresh: '',
    inferenceToken: token,
    orgId: 'org-1',
  })

const sync = (pc: string) => run(pc, (e) => e.sync())
const patches = () => github.calls.filter((c) => c.method === 'PATCH').length
const gistContent = () => [...github.gists.values()][0]?.content ?? ''
const inGist = async () => (await pcs.snapshot('pcA', gistContent())).logins
const refreshesInGist = async () =>
  (await inGist()).map((l) => `${l.key}=${l.refresh}`).sort()
const only = async (pc: string) => {
  const found = await rows(pc)
  expect(found).toHaveLength(1)
  return found[0]
}

/** What a refresh does to a row: a new pair, a new generation, a new revision. */
const refreshOn = (pc: string, id: string, access: string, refresh: string) =>
  on(pc, () =>
    mutatePool((pool) => {
      const row = findAccount(pool, id)
      if (!row) return
      row.access = access
      row.refresh = refresh
      row.tokenGen = (row.tokenGen ?? 0) + 1
      bumpLoginRev(row, world.clock)
    }),
  )

const loginAgain = (pc: string, refresh: string, accountId = 'acct-1') =>
  on(pc, () =>
    addAccount('openai', {
      access: `ACCESS-${refresh}`,
      refresh,
      expires: FAR,
      accountId,
    }),
  )

async function loginsOff<T>(fn: () => Promise<T>): Promise<T> {
  process.env.OPENCODE_AUTH_LB_SYNC_LOGINS = '0'
  try {
    return await fn()
  } finally {
    delete process.env.OPENCODE_AUTH_LB_SYNC_LOGINS
  }
}

/** pcA made the gist from its own login; pcB follows it with nothing of its own. */
async function aSharesOneLogin(): Promise<string> {
  await seed('pcA', loginRow('a1'))
  await run('pcA', (e) => e.upload(false))
  const link = await linkOf('pcA')
  await run('pcB', (e) => e.subscribe(link))
  return link
}

beforeEach(async () => {
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
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
  await rm(pcs.root, { recursive: true, force: true })
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('one login on two machines', () => {
  test('a login reaches the machine that follows the link, a refresh on either machine reaches the other, and a re-login wins', async () => {
    await seed('pcA', loginRow('a1'))
    expect((await run('pcA', (e) => e.upload(false))).message).toBe(
      'Uploaded 0 credentials and 1 login.',
    )
    expect(await refreshesInGist()).toEqual(['openai:acct-1=REFRESH-a1'])
    expect(gistContent()).not.toContain('REFRESH-a1')

    const link = await linkOf('pcA')
    const joined = await run('pcB', (e) => e.subscribe(link))
    expect(joined.message).toBe('Synced: 1 login adopted.')
    const first = await only('pcB')
    expect(first).toMatchObject({
      providerID: 'openai',
      label: 'a1',
      access: 'ACCESS-a1',
      refresh: 'REFRESH-a1',
      accountId: 'acct-1',
      loginRev: 1,
      loginAt: 1_000,
    })
    expect(first?.id).not.toBe('a1')

    world.clock += 1_000
    await refreshOn('pcA', 'a1', 'ACCESS-a2', 'REFRESH-a2')
    expect(await run('pcA', (e) => e.unpublishedDigest())).not.toBeNull()
    expect((await sync('pcA')).message).toBe(
      'Uploaded 0 credentials and 1 login.',
    )
    expect(await run('pcA', (e) => e.unpublishedDigest())).toBeNull()
    expect((await sync('pcB')).message).toBe('Synced: 1 login adopted.')
    expect(await only('pcB')).toMatchObject({
      access: 'ACCESS-a2',
      refresh: 'REFRESH-a2',
      loginRev: 2,
      tokenGen: 2,
    })

    world.clock += 1_000
    await refreshOn('pcB', first?.id ?? '', 'ACCESS-b3', 'REFRESH-b3')
    expect((await sync('pcB')).message).toBe(
      'Uploaded 0 credentials and 1 login.',
    )
    expect((await sync('pcA')).message).toBe('Synced: 1 login adopted.')
    expect(await only('pcA')).toMatchObject({
      refresh: 'REFRESH-b3',
      loginRev: 3,
    })

    world.clock += 1_000
    const relogged = await loginAgain('pcA', 'REFRESH-a4')
    expect(relogged.id).toBe('a1')
    expect(relogged.loginRev).toBe(4)
    expect((await sync('pcA')).message).toBe(
      'Uploaded 0 credentials and 1 login.',
    )
    expect((await sync('pcB')).message).toBe('Synced: 1 login adopted.')
    expect(await only('pcB')).toMatchObject({
      refresh: 'REFRESH-a4',
      loginRev: 4,
    })

    const writes = patches()
    for (let i = 0; i < 3; i++) for (const pc of ['pcA', 'pcB']) await sync(pc)
    expect(patches()).toBe(writes)
    expect(await refreshesInGist()).toEqual(['openai:acct-1=REFRESH-a4'])
  })

  test('the automatic upload of the loop publishes a refresh, but only when logins of the machine changed', async () => {
    await aSharesOneLogin()
    const idle = await run('pcA', (e) => e.unpublishedDigest())
    expect(idle).toBeNull()
    world.clock += 1_000
    await refreshOn('pcA', 'a1', 'ACCESS-a2', 'REFRESH-a2')
    const digest = await run('pcA', (e) => e.unpublishedDigest())
    expect(digest).not.toBeNull()
    const gistId = (await state('pcA'))?.gistId ?? ''
    const out = await run('pcA', (e) =>
      e.backgroundPublish(gistId, digest ?? ''),
    )
    expect(out?.message).toBe('Uploaded 0 credentials and 1 login.')
    expect(await refreshesInGist()).toEqual(['openai:acct-1=REFRESH-a2'])
  })

  test('two machines that refreshed at the same revision and time settle on the same login', async () => {
    await seed('pcA', loginRow('a1', 'acct-1', { loginRev: 3, loginAt: 5_000 }))
    await seed('pcB', loginRow('b1', 'acct-1', { loginRev: 3, loginAt: 5_000 }))
    await run('pcA', (e) => e.upload(false))
    const link = await linkOf('pcA')
    await run('pcB', (e) => e.subscribe(link))
    for (const pc of ['pcA', 'pcB', 'pcA', 'pcB']) await sync(pc)
    const winner =
      fingerprint('REFRESH-a1') > fingerprint('REFRESH-b1') ? 'a1' : 'b1'
    expect((await only('pcA'))?.refresh).toBe(`REFRESH-${winner}`)
    expect((await only('pcB'))?.refresh).toBe(`REFRESH-${winner}`)
    expect(await refreshesInGist()).toEqual([`openai:acct-1=REFRESH-${winner}`])
  })

  test('a machine with only the link adopts the login and never writes', async () => {
    const link = await aSharesOneLogin()
    await run('pcC', (e) => e.subscribe(link))
    const before = patches()
    expect((await only('pcC'))?.refresh).toBe('REFRESH-a1')
    await refreshOn(
      'pcC',
      (await only('pcC'))?.id ?? '',
      'ACCESS-c2',
      'REFRESH-c2',
    )
    expect(await run('pcC', (e) => e.unpublishedDigest())).toBeNull()
    expect((await sync('pcC')).ok).toBe(true)
    expect(patches()).toBe(before)
    expect((await state('pcC'))?.write).toBe('no-token')
  })
})

describe('following a link uploads the logins of this machine in the same call', () => {
  test('a pasted link adopts what the gist has and writes what this machine has, once', async () => {
    await seed('pcA', loginRow('a1'))
    await run('pcA', (e) => e.upload(false))
    const link = await linkOf('pcA')
    await seed('pcB', loginRow('b1', 'acct-2'))
    const before = patches()
    const out = await run('pcB', (e) => e.subscribe(link))
    expect(out.message).toBe(
      'Synced: 1 login adopted. Uploaded 0 credentials and 2 logins.',
    )
    expect(patches() - before).toBe(1)
    expect(await refreshesInGist()).toEqual([
      'openai:acct-1=REFRESH-a1',
      'openai:acct-2=REFRESH-b1',
    ])
    expect((await sync('pcA')).message).toBe('Synced: 1 login adopted.')
    expect(await rows('pcA')).toHaveLength(2)
  })

  test('static credentials and logins are counted together in the message', async () => {
    await seed('pcA', loginRow('a1'))
    await run('pcA', (e) => e.upload(false))
    const link = await linkOf('pcA')
    await seed('pcB', tokenOnly('b-token', CLAUDE_TOKEN))
    expect((await run('pcB', (e) => e.subscribe(link))).message).toBe(
      'Synced: 1 login adopted. Uploaded 1 credential and 1 login.',
    )
  })
})

describe('creating a gist', () => {
  test('counts credentials and logins, and records the logins it holds', async () => {
    await seed(
      'pcA',
      tokenOnly('t1', CLAUDE_TOKEN),
      testAccount({
        id: 'k1',
        providerID: 'kimi-code-plan-cn',
        label: 'k1',
        access: KIMI_KEY,
        refresh: '',
        expires: Number.MAX_SAFE_INTEGER,
        accountId: 'key:abc',
      }),
      loginRow('l1', 'acct-1'),
      loginRow('l2', 'acct-2'),
      loginRow('l3', 'acct-3'),
    )
    expect((await run('pcA', (e) => e.upload(false))).message).toBe(
      'Uploaded 2 credentials and 3 logins.',
    )
    expect(Object.keys((await state('pcA'))?.loginKnown ?? {}).sort()).toEqual([
      'openai:acct-1',
      'openai:acct-2',
      'openai:acct-3',
    ])
    expect(await run('pcA', (e) => e.unpublishedDigest())).toBeNull()
  })

  test('one login and no credential, and nothing at all', async () => {
    await seed('pcA', loginRow('l1'))
    expect((await run('pcA', (e) => e.upload(false))).message).toBe(
      'Uploaded 0 credentials and 1 login.',
    )
    await seed('pcB')
    expect((await run('pcB', (e) => e.upload(false))).message).toBe(
      'Uploaded 0 credentials. No static credential or shareable OAuth login on this machine.',
    )
    expect((await state('pcB'))?.loginKnown).toBeUndefined()
  })

  test('with login sharing off, a new gist holds none and says nothing about them', async () => {
    await seed('pcA', loginRow('l1'), tokenOnly('t1', CLAUDE_TOKEN))
    const out = await loginsOff(() => run('pcA', (e) => e.upload(false)))
    expect(out.message).toBe('Uploaded 1 credential.')
    expect(await inGist()).toEqual([])
    expect((await state('pcA'))?.loginKnown).toBeUndefined()
  })
})

describe('a row the user deleted', () => {
  test('stays deleted while the gist moves on, and a new login of that account wins again', async () => {
    await aSharesOneLogin()
    await on('pcB', () =>
      mutatePool((pool) => {
        pool.accounts = []
      }),
    )
    expect((await sync('pcB')).message).toBe('Up to date.')
    expect(Object.keys((await state('pcB'))?.loginSuppressed ?? {})).toEqual([
      'openai:acct-1',
    ])
    expect(await rows('pcB')).toEqual([])

    world.clock += 1_000
    await refreshOn('pcA', 'a1', 'ACCESS-a2', 'REFRESH-a2')
    await sync('pcA')
    expect((await sync('pcB')).message).toBe('Up to date.')
    expect(await rows('pcB')).toEqual([])

    world.clock += 1_000
    await loginAgain('pcB', 'REFRESH-b3')
    expect((await sync('pcB')).message).toBe(
      'Uploaded 0 credentials and 1 login.',
    )
    expect((await state('pcB'))?.loginSuppressed).toBeUndefined()
    expect(await refreshesInGist()).toEqual(['openai:acct-1=REFRESH-b3'])
    expect((await only('pcB'))?.loginRev).toBeGreaterThan(2)
    expect((await sync('pcA')).message).toBe('Synced: 1 login adopted.')
    expect((await only('pcA'))?.refresh).toBe('REFRESH-b3')
  })

  test('the gist keeps the login, since removal is not propagated', async () => {
    await aSharesOneLogin()
    await on('pcA', () =>
      mutatePool((pool) => {
        pool.accounts = []
      }),
    )
    await sync('pcA')
    expect(await refreshesInGist()).toEqual(['openai:acct-1=REFRESH-a1'])
    expect((await sync('pcB')).message).toBe('Up to date.')
    expect((await only('pcB'))?.refresh).toBe('REFRESH-a1')
  })

  test('following the same gist again keeps the suppression', async () => {
    const link = await aSharesOneLogin()
    await on('pcB', () =>
      mutatePool((pool) => {
        pool.accounts = []
      }),
    )
    await sync('pcB')
    await run('pcB', (e) => e.subscribe(link))
    expect(Object.keys((await state('pcB'))?.loginSuppressed ?? {})).toEqual([
      'openai:acct-1',
    ])
    expect(await rows('pcB')).toEqual([])
    expect(Object.keys((await state('pcB'))?.loginKnown ?? {})).toEqual([])
  })
})

describe('login sharing switched off', () => {
  test('a machine neither imports nor exports logins, and carries the logins of the gist over verbatim when it writes', async () => {
    const link = await aSharesOneLogin()
    world.tokens.add('pcC')
    await seed(
      'pcC',
      loginRow('b-own', 'acct-9'),
      tokenOnly('t1', CLAUDE_TOKEN),
    )
    const before = await inGist()
    const out = await loginsOff(() => run('pcC', (e) => e.subscribe(link)))
    expect(out.message).toBe('Uploaded 1 credential.')
    expect(await inGist()).toEqual(before)
    expect(JSON.parse(await decrypted()).v).toBe(3)
    expect((await rows('pcC')).map((r) => r.id).sort()).toEqual(['b-own', 't1'])

    world.clock += 1_000
    await refreshOn('pcC', 'b-own', 'ACCESS-b2', 'REFRESH-b2')
    expect(
      await loginsOff(() => run('pcC', (e) => e.unpublishedDigest())),
    ).toBeNull()

    expect((await sync('pcC')).message).toBe(
      'Synced: 1 login adopted. Uploaded 1 credential and 2 logins.',
    )
  })
})

describe('a gist this version cannot fully read', () => {
  async function forge(
    over: (snap: Record<string, unknown>) => Record<string, unknown>,
  ) {
    const snap = await pcs.snapshot('pcA', gistContent())
    const s = await state('pcA')
    const key = Buffer.from(s?.key ?? '', 'base64url')
    const forged = seal(
      JSON.stringify(over({ ...snap, at: snap.at + 10 })),
      key,
    )
    for (const gist of github.gists.values()) {
      gist.content = forged
      gist.etag += 1
    }
    return forged
  }

  test('an unreadable login blocks every write, and the readable ones are still adopted', async () => {
    const link = await aSharesOneLogin()
    const forged = await forge((snap) => ({
      ...snap,
      v: 3,
      logins: [
        ...(snap.logins as unknown[]),
        {
          key: 'future:x',
          providerID: 'future',
          label: 'x',
          access: 'a',
          refresh: 'r',
        },
      ],
    }))
    await run('pcC', (e) => e.subscribe(link))
    world.tokens.add('pcC')
    await seed('pcC', tokenOnly('t1', CLAUDE_TOKEN_2))
    const before = patches()
    const out = await sync('pcC')
    expect(out.message).toBe(
      'Up to date. The gist has entries this version cannot read; update this plugin to upload.',
    )
    expect(patches()).toBe(before)
    expect(gistContent()).toBe(forged)
    expect((await state('pcC'))?.write).toBe('unreadable')
  })

  test('a version 2 gist is read, and the first write upgrades it to version 3', async () => {
    await seed('pcA', tokenOnly('t1', CLAUDE_TOKEN))
    await run('pcA', (e) => e.upload(false))
    await forge((snap) => ({ v: 2, at: snap.at, entries: snap.entries }))
    await seed('pcA', tokenOnly('t1', CLAUDE_TOKEN), loginRow('a1'))
    expect((await sync('pcA')).message).toBe(
      'Uploaded 1 credential and 1 login.',
    )
    expect(JSON.parse(await decrypted()).v).toBe(3)
  })
})

async function decrypted(): Promise<string> {
  const key = decodeKey((await state('pcA'))?.key ?? '') ?? Buffer.alloc(0)
  return open(gistContent(), key)
}
