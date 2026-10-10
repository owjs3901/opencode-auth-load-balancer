import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { findAccount, mutatePool } from '../pool/store'
import { decodeKey, fingerprint, seal } from '../sync/crypto'
import { createEngine } from '../sync/engine'
import { updateSyncState } from '../sync/state'
import { POLL_MS, PUBLISH_RETRY_MS } from '../sync/timing'
import { type PoolAccount, STATIC_CREDENTIAL_EXPIRES } from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'
import { responderFetch } from './fixtures/fetch-mock'
import { createPcs } from './fixtures/pcs'
import {
  CLAUDE_TOKEN,
  CLAUDE_TOKEN_2,
  fakeGithub,
  KIMI_KEY,
  REJECTED_TOKEN,
} from './fixtures/sync'
import {
  claudeSyncAdapter,
  kimiSyncAdapter,
  orgOf,
} from './fixtures/sync-adapters'

const realFetch = globalThis.fetch
const github = fakeGithub()
const pcs = createPcs('sync-engine')
const { world, on, engine, seed, rows, state, linkOf, run } = pcs
const adapters = world.adapters

const publisherRow = (over: Partial<PoolAccount> = {}) =>
  testAccount({
    id: 'p1',
    label: 'work',
    access: 'OAUTH-ACCESS-SECRET',
    refresh: 'OAUTH-REFRESH-SECRET',
    inferenceToken: CLAUDE_TOKEN,
    inferenceExpires: 4_000_000_000_000,
    orgId: 'org-1',
    ...over,
  })

const ownOauthRow = (over: Partial<PoolAccount> = {}) =>
  testAccount({
    id: 'mine',
    label: 'mine',
    access: 'MY-ACCESS',
    refresh: 'MY-REFRESH',
    orgId: 'org-1',
    ...over,
  })

const tokenRow = (id: string, token: string, over: Partial<PoolAccount> = {}) =>
  publisherRow({
    id,
    label: id,
    refresh: '',
    access: token,
    inferenceToken: token,
    inferenceExpires: undefined,
    ...over,
  })

const kimiRow = (id: string, access = KIMI_KEY) =>
  testAccount({
    id,
    providerID: 'kimi-code-plan-cn',
    label: id,
    access,
    refresh: '',
    expires: STATIC_CREDENTIAL_EXPIRES,
  })

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
  world.tokens.add('pc1')
  await rm(pcs.root, { recursive: true, force: true })
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const byOrg = [claudeSyncAdapter(orgOf), kimiSyncAdapter()]
const gistContent = () => [...github.gists.values()][0]?.content ?? ''

describe('creating a gist', () => {
  test('uploads ciphertext only, to a secret gist, and reports without the link', async () => {
    await seed('pc1', publisherRow())
    const out = await run('pc1', (e) => e.upload(false, 77))
    expect(out).toEqual({ ok: true, message: 'Uploaded 1 credential.' })
    const stored = gistContent()
    for (const leak of [
      CLAUDE_TOKEN,
      'sk-ant',
      'OAUTH-REFRESH-SECRET',
      'OAUTH-ACCESS-SECRET',
      'work',
    ])
      expect(stored).not.toContain(leak)
    const s = await state('pc1')
    expect(s).toMatchObject({
      creator: true,
      owner: 'octo',
      write: 'ok',
      imported: {},
    })
    const status = await readFile(
      join(pcs.root, 'pc1', 'auth-load-balancer-sync-status.json'),
      'utf8',
    )
    expect(JSON.parse(status)).toMatchObject({
      ok: true,
      reqAt: 77,
      at: world.clock,
    })
    expect(status).not.toContain(s?.key ?? 'x')
    expect(status).not.toContain(s?.gistId ?? 'x')
    const pool = await readFile(
      join(pcs.root, 'pc1', 'auth-load-balancer.json'),
      'utf8',
    )
    expect(pool).not.toContain(s?.key ?? 'x')
  })

  test('the entries name the machine that listed them, and the origin is a random 128 bits that is not in the pool', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const snap = await pcs.snapshot('pc1', gistContent())
    const origin = snap.entries[0]?.origin ?? ''
    expect(origin).toMatch(/^[\da-f]{32}$/)
    const file = await readFile(
      join(pcs.root, 'pc1', 'auth-load-balancer-sync-origin.json'),
      'utf8',
    )
    expect(JSON.parse(file)).toEqual({ origin })
    expect(file).not.toMatch(/pc1|octo/)
  })

  test('without a GitHub token, creating says so and creates nothing', async () => {
    world.tokens.clear()
    const out = await run('pc1', (e) => e.upload(false))
    expect(out.ok).toBe(false)
    expect(out.message).toContain('GITHUB_TOKEN')
    expect(github.gists.size).toBe(0)
    expect(await state('pc1')).toBeNull()
  })

  test('the token can come from the environment or the gh CLI, and goes only to api.github.com', async () => {
    process.env.GITHUB_TOKEN = 'env-token'
    const viaEnv = createEngine({
      now: () => world.clock,
      adapters,
      runGh: () => Promise.reject(new Error('no gh')),
    })
    expect((await on('pc4', () => viaEnv.upload(false))).ok).toBe(true)
    expect(github.calls[0]?.authorization).toBe('Bearer env-token')
    delete process.env.GITHUB_TOKEN
    const viaGh = createEngine({
      now: () => world.clock,
      adapters,
      runGh: async () => 'gh-token\n',
    })
    expect((await on('pc5', () => viaGh.upload(false))).ok).toBe(true)
    expect(github.calls.at(-1)?.authorization).toBe('Bearer gh-token')
    expect(
      github.calls.every((c) => c.url.startsWith('https://api.github.com/')),
    ).toBe(true)
  })

  test('Upload now updates the same gist under the same link; a fresh upload makes a new one', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const link = await linkOf('pc1')
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    expect(await run('pc1', (e) => e.unpublishedDigest())).not.toBeNull()
    expect((await run('pc1', (e) => e.upload(false))).message).toBe(
      'Uploaded 1 credential.',
    )
    expect(github.gists.size).toBe(1)
    expect(await linkOf('pc1')).toBe(link)
    expect(await run('pc1', (e) => e.unpublishedDigest())).toBeNull()
    await run('pc1', (e) => e.upload(true))
    expect(github.gists.size).toBe(2)
    expect(await linkOf('pc1')).not.toBe(link)
  })

  test('each upload uses a fresh nonce under the stable key', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const first = gistContent()
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    await run('pc1', (e) => e.upload(false))
    expect(JSON.parse(first).n).not.toBe(JSON.parse(gistContent()).n)
  })

  test('a gist deleted under a member is reported, not recreated silently', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    github.gists.clear()
    const out = await run('pc1', (e) => e.sync())
    expect(out).toMatchObject({
      ok: false,
      message: 'The gist no longer exists.',
    })
    expect(github.gists.size).toBe(0)
  })

  test('with no state there is nothing to upload and nothing to sync', async () => {
    expect(await run('pc1', (e) => e.unpublishedDigest())).toBeNull()
    expect((await run('pc1', (e) => e.sync())).message).toBe(
      'Sync is not set up on this machine.',
    )
  })

  test('a fresh gist keeps the origin, lists only what the machine owns, and turns formerly imported rows into its own', async () => {
    await seed('pc1', tokenRow('p1', CLAUDE_TOKEN))
    await run('pc1', (e) => e.upload(false))
    const link = await linkOf('pc1')
    await seed('pc2', tokenRow('own', CLAUDE_TOKEN_2, { orgId: 'org-9' }))
    world.tokens.add('pc2')
    await run('pc2', (e) => e.subscribe(link))
    const originFile = join(
      pcs.root,
      'pc2',
      'auth-load-balancer-sync-origin.json',
    )
    const origin = JSON.parse(await readFile(originFile, 'utf8')).origin
    await run('pc2', (e) => e.upload(true))
    expect((await state('pc2'))?.imported).toEqual({})
    const fresh = [...github.gists.values()][1]?.content ?? ''
    const snap = await pcs.snapshot('pc2', fresh)
    expect(snap.entries.every((e) => e.origin === origin)).toBe(true)
    expect(snap.entries).toHaveLength(2)
  })
})

describe('joining by link', () => {
  async function publish(...pcRows: PoolAccount[]): Promise<string> {
    await seed('pc1', ...pcRows)
    await run('pc1', (e) => e.upload(false))
    return linkOf('pc1')
  }

  test("a bare link registers the token on the machine's own OAuth row; changes and removals follow, with no GitHub login", async () => {
    const link = await publish(publisherRow())
    await seed('pc2', ownOauthRow())

    const first = await run('pc2', (e) => e.subscribe(link, 5))
    expect(first).toEqual({
      ok: true,
      message: 'Synced: 1 added, 0 updated, 0 removed.',
    })
    const [row, ...rest] = await rows('pc2')
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      id: 'mine',
      access: 'MY-ACCESS',
      refresh: 'MY-REFRESH',
      inferenceToken: CLAUDE_TOKEN,
      inferenceExpires: 4_000_000_000_000,
    })
    expect(github.calls.at(-1)?.authorization).toBeNull()
    expect(github.calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect((await state('pc2'))?.write).toBe('no-token')

    expect(await run('pc2', (e) => e.sync())).toEqual({
      ok: true,
      message: 'Up to date.',
    })

    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    await run('pc1', (e) => e.upload(false))
    expect((await run('pc2', (e) => e.sync())).message).toBe(
      'Synced: 0 added, 1 updated, 0 removed.',
    )
    const [swapped, ...others] = await rows('pc2')
    expect(others).toEqual([])
    expect(swapped).toMatchObject({
      id: 'mine',
      inferenceToken: CLAUDE_TOKEN_2,
      refresh: 'MY-REFRESH',
    })

    await seed('pc1')
    await run('pc1', (e) => e.upload(false))
    expect((await run('pc2', (e) => e.sync())).message).toBe(
      'Synced: 0 added, 0 updated, 1 removed.',
    )
    const [stripped] = await rows('pc2')
    expect(stripped).toMatchObject({
      id: 'mine',
      refresh: 'MY-REFRESH',
      access: 'MY-ACCESS',
    })
    expect(stripped).not.toHaveProperty('inferenceToken')
    expect(stripped).not.toHaveProperty('inferenceExpires')
    expect((await state('pc2'))?.imported).toEqual({})
  })

  test('without an OAuth row the token becomes a row of its own, and leaves with its entry', async () => {
    const link = await publish(
      publisherRow({ id: 'p1', label: 'work' }),
      publisherRow({
        id: 'p2',
        label: 'work',
        inferenceToken: CLAUDE_TOKEN_2,
        refresh: '',
        access: CLAUDE_TOKEN_2,
        inferenceExpires: undefined,
        orgId: 'org-2',
      }),
    )
    await seed(
      'pc2',
      testAccount({
        id: 'own',
        label: 'work',
        refresh: '',
        access: 'sk-ant-oat01-OWN_own-3333',
        inferenceToken: 'sk-ant-oat01-OWN_own-3333',
        orgId: 'org-9',
      }),
    )
    const adapters2 = [claudeSyncAdapter(orgOf), kimiSyncAdapter()]
    expect(
      (await on('pc2', () => engine(adapters2).subscribe(link))).message,
    ).toBe('Synced: 2 added, 0 updated, 0 removed.')
    const imported = await rows('pc2')
    expect(imported.map((r) => r.label).sort()).toEqual([
      'work',
      'work (2)',
      'work (3)',
    ])
    expect(imported.filter((r) => r.refresh === '')).toHaveLength(3)

    await seed('pc1')
    await run('pc1', (e) => e.upload(false))
    expect((await on('pc2', () => engine(adapters2).sync())).message).toBe(
      'Synced: 0 added, 0 updated, 2 removed.',
    )
    expect((await rows('pc2')).map((r) => r.id)).toEqual(['own'])
  })

  test('a token the machine already holds stays its own and is never removed', async () => {
    const link = await publish(
      publisherRow({ refresh: '', access: CLAUDE_TOKEN }),
    )
    await seed(
      'pc2',
      testAccount({
        id: 'own',
        label: 'own',
        refresh: '',
        access: CLAUDE_TOKEN,
        inferenceToken: CLAUDE_TOKEN,
      }),
    )
    expect((await run('pc2', (e) => e.subscribe(link))).message).toBe(
      'Up to date.',
    )
    await seed('pc1')
    await run('pc1', (e) => e.upload(false))
    await run('pc2', (e) => e.sync())
    expect((await rows('pc2')).map((r) => r.id)).toEqual(['own'])
  })

  test('a changed token on a token-only row replaces it in place', async () => {
    const link = await publish(
      publisherRow({ refresh: '', access: CLAUDE_TOKEN }),
    )
    await run('pc2', (e) => e.subscribe(link))
    const [before] = await rows('pc2')
    await seed(
      'pc1',
      publisherRow({
        refresh: '',
        access: CLAUDE_TOKEN_2,
        inferenceToken: CLAUDE_TOKEN_2,
      }),
    )
    await run('pc1', (e) => e.upload(false))
    await run('pc2', (e) => e.sync())
    const after = await rows('pc2')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: before?.id,
      access: CLAUDE_TOKEN_2,
      inferenceToken: CLAUDE_TOKEN_2,
    })
  })

  test("a changed token whose old row was re-pointed lands beside it and clears nothing of the user's", async () => {
    const link = await publish(
      publisherRow({ refresh: '', access: CLAUDE_TOKEN }),
    )
    await run('pc2', (e) => e.subscribe(link))
    const [imported] = await rows('pc2')
    await on('pc2', () =>
      mutatePool((pool) => {
        const row = findAccount(pool, imported?.id ?? '')
        if (row) {
          row.inferenceToken = 'sk-ant-oat01-USER_pasted-9999'
          row.access = 'sk-ant-oat01-USER_pasted-9999'
          row.orgId = 'org-other'
        }
      }),
    )
    await seed(
      'pc1',
      publisherRow({
        refresh: '',
        access: CLAUDE_TOKEN_2,
        inferenceToken: CLAUDE_TOKEN_2,
      }),
    )
    await run('pc1', (e) => e.upload(false))
    await run('pc2', (e) => e.sync())
    const after = await rows('pc2')
    expect(after.map((r) => r.inferenceToken).sort()).toEqual(
      [CLAUDE_TOKEN_2, 'sk-ant-oat01-USER_pasted-9999'].sort(),
    )
  })

  test('what the user deleted or re-pointed locally is not undone while the gist is unchanged', async () => {
    const link = await publish(
      publisherRow({ refresh: '', access: CLAUDE_TOKEN }),
    )
    await run('pc2', (e) => e.subscribe(link))
    await seed('pc2')
    await run('pc1', (e) => e.sync())
    expect((await run('pc2', (e) => e.sync())).message).toBe('Up to date.')
    expect(await rows('pc2')).toEqual([])
  })

  test("a Kimi key never touches the machine's own OAuth login for that account", async () => {
    const link = await publish(kimiRow('k1'))
    await seed(
      'pc2',
      testAccount({
        ...kimiRow('kimi-oauth'),
        access: 'OAUTH-ACCESS',
        refresh: 'OAUTH-REFRESH',
        accountId: 'kimi-user-1',
        expires: 0,
      }),
    )
    expect((await run('pc2', (e) => e.subscribe(link))).message).toBe(
      'Up to date.',
    )
    expect((await rows('pc2'))[0]).toMatchObject({
      id: 'kimi-oauth',
      access: 'OAUTH-ACCESS',
      refresh: 'OAUTH-REFRESH',
    })
    await seed('pc1')
    await run('pc1', (e) => e.upload(false))
    await run('pc2', (e) => e.sync())
    expect((await rows('pc2'))[0]).toMatchObject({
      id: 'kimi-oauth',
      access: 'OAUTH-ACCESS',
      refresh: 'OAUTH-REFRESH',
    })
  })

  test('a Kimi key on a machine with no such account becomes a row, and updates in place', async () => {
    const link = await publish(kimiRow('k1'))
    await run('pc2', (e) => e.subscribe(link))
    const [row] = await rows('pc2')
    expect(row).toMatchObject({
      providerID: 'kimi-code-plan-cn',
      access: KIMI_KEY,
      refresh: '',
      accountId: 'kimi-user-1',
    })
    await seed('pc1', kimiRow('k1', 'sk-kimi-rotated-key-98765'))
    await run('pc1', (e) => e.upload(false))
    await run('pc2', (e) => e.sync())
    const after = await rows('pc2')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: row?.id,
      access: 'sk-kimi-rotated-key-98765',
    })
  })

  test('an entry that cannot be verified yet is retried: its etag is not kept', async () => {
    const link = await publish(
      tokenRow('bad', REJECTED_TOKEN),
      tokenRow('ok', CLAUDE_TOKEN_2),
    )
    const out = await run('pc2', (e) => e.subscribe(link))
    expect(out.message).toBe(
      'Synced: 1 added, 0 updated, 0 removed; 1 entry could not be verified yet.',
    )
    expect((await state('pc2'))?.etag).toBeUndefined()
    await run('pc2', (e) => e.sync())
    expect(github.calls.at(-1)?.url).toContain('/gists/')
    expect((await rows('pc2')).filter((r) => r.refresh === '')).toHaveLength(1)
  })

  test('a provider this build lacks, or an adapter that throws, defers the entry', async () => {
    const link = await publish(tokenRow('c', CLAUDE_TOKEN), kimiRow('k'))
    const throwing = fakeAdapter({
      id: 'anthropic',
      tokenLogin: {
        label: '',
        url: '',
        instructions: '',
        exchange: () => Promise.reject(new Error('probe down')),
      },
    })
    const noProbe = fakeAdapter({ id: 'kimi-code-plan-cn' })
    const out = await on('pc2', () =>
      engine([throwing, noProbe]).subscribe(link),
    )
    expect(out.message).toContain('2 entries could not be verified yet')
    expect(await rows('pc2')).toEqual([])
    const missing = await on('pc2', () => engine([]).sync())
    expect(missing.message).toContain('2 entries could not be verified yet')
  })

  test('following the same link again keeps what was imported and who created it; another link forgets it', async () => {
    const link = await publish(tokenRow('p1', CLAUDE_TOKEN))
    await run('pc2', (e) => e.subscribe(link))
    const kept = (await state('pc2'))?.imported
    expect(Object.keys(kept ?? {})).toHaveLength(1)
    await run('pc2', (e) => e.subscribe(link))
    expect((await state('pc2'))?.imported).toEqual(kept)
    expect((await state('pc2'))?.creator).toBe(false)
    await run('pc1', (e) => e.subscribe(link))
    expect((await state('pc1'))?.creator).toBe(true)

    await seed('pc3', tokenRow('x', CLAUDE_TOKEN_2, { orgId: 'org-9' }))
    world.tokens.add('pc3')
    await run('pc3', (e) => e.upload(true))
    const other = await linkOf('pc3')
    await on('pc2', () => engine(byOrg).subscribe(other))
    const keys = Object.keys((await state('pc2'))?.imported ?? {})
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/\/x$/)
  })

  test('a link that is not a gist link with a key changes nothing', async () => {
    const out = await run('pc2', (e) =>
      e.subscribe('https://example.com/x#y', 3),
    )
    expect(out).toMatchObject({ ok: false })
    expect(out.message).toContain('gist link')
    expect(await state('pc2')).toBeNull()
    const status = JSON.parse(
      await readFile(
        join(pcs.root, 'pc2', 'auth-load-balancer-sync-status.json'),
        'utf8',
      ),
    )
    expect(status.reqAt).toBe(3)
  })
})

describe('a gist that cannot be trusted leaves the pool untouched', () => {
  async function following() {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const link = await linkOf('pc1')
    await seed('pc2', ownOauthRow())
    await run('pc2', (e) => e.subscribe(link))
    return { link, before: await rows('pc2') }
  }
  const setContent = (content: string) => {
    for (const gist of github.gists.values()) {
      gist.content = content
      gist.etag += 1
    }
  }

  test.each([
    ['tampered', () => setContent(gistContent().replace('"c":"', '"c":"AAAA'))],
    ['not a sync file', () => setContent('hello')],
    [
      'rotated to a new key',
      () => setContent(seal('{"v":2,"entries":[]}', Buffer.alloc(32, 7))),
    ],
  ])('%s', async (_name, damage) => {
    const { before } = await following()
    damage()
    const out = await run('pc2', (e) => e.sync())
    expect(out.ok).toBe(false)
    expect(out.message).not.toMatch(/sk-ant|#[\w-]{20}/)
    expect(await rows('pc2')).toEqual(before)
  })

  test('a payload of another version is refused after decrypting, a version 1 gist included', async () => {
    const { before } = await following()
    const key = decodeKey((await state('pc2'))?.key ?? '') ?? Buffer.alloc(0)
    for (const v of [1, 3]) {
      setContent(seal(JSON.stringify({ v, at: 1, entries: [] }), key))
      const out = await run('pc2', (e) => e.sync())
      expect(out.message).toContain('newer version')
      expect(await rows('pc2')).toEqual(before)
    }
  })

  test('a deleted gist is reported and nothing is removed', async () => {
    const { before } = await following()
    github.gists.clear()
    const out = await run('pc2', (e) => e.sync())
    expect(out).toMatchObject({
      ok: false,
      message: 'The gist no longer exists.',
    })
    expect(await rows('pc2')).toEqual(before)
  })

  test('rate limiting asks the caller to back off', async () => {
    await following()
    github.hooks.before = () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '300' } })
    const out = await run('pc2', (e) => e.sync())
    expect(out).toMatchObject({ ok: false, backoffMs: 300_000 })
  })

  test('forgetting mid-download is not undone by the download finishing', async () => {
    await following()
    const key = decodeKey((await state('pc2'))?.key ?? '') ?? Buffer.alloc(0)
    setContent(
      seal(JSON.stringify({ v: 2, at: world.clock + 5, entries: [] }), key),
    )
    github.hooks.before = (_method, url) => {
      if (url.includes('/gists/'))
        void on('pc2', () => updateSyncState(() => null))
      return undefined
    }
    await run('pc2', (e) => e.sync())
    await Bun.sleep(50)
    expect(await state('pc2')).toBeNull()
  })
})

describe('stopping and dispatch', () => {
  test('forget removes the state and keeps what was imported and the origin', async () => {
    await seed('pc1', tokenRow('p1', CLAUDE_TOKEN))
    await run('pc1', (e) => e.upload(false))
    await run('pc2', async (e) => e.subscribe(await linkOf('pc1')))
    expect(await rows('pc2')).toHaveLength(1)
    const originFile = join(
      pcs.root,
      'pc2',
      'auth-load-balancer-sync-origin.json',
    )
    const origin = await readFile(originFile, 'utf8')
    const out = await run('pc2', (e) => e.forget(9))
    expect(out.message).toContain('Imported accounts stay')
    expect(await state('pc2')).toBeNull()
    expect(await rows('pc2')).toHaveLength(1)
    expect(await readFile(originFile, 'utf8')).toBe(origin)
  })

  test('sync downloads and, with a token, uploads; and says so when nothing is set up', async () => {
    await seed('pc1', publisherRow())
    expect((await run('pc1', (e) => e.upload(false))).ok).toBe(true)
    expect((await run('pc1', (e) => e.sync())).message).toBe('Up to date.')
    await run('pc2', async (e) => e.subscribe(await linkOf('pc1')))
    expect((await run('pc2', (e) => e.sync())).message).toBe('Up to date.')
  })

  test('the status file is written for every outcome', async () => {
    await run('pc2', (e) => e.sync(4))
    const status = JSON.parse(
      await readFile(
        join(pcs.root, 'pc2', 'auth-load-balancer-sync-status.json'),
        'utf8',
      ),
    )
    expect(status).toMatchObject({ ok: false, reqAt: 4 })
  })

  test('fingerprints in the state never equal the secret', async () => {
    await seed('pc1', tokenRow('p1', CLAUDE_TOKEN))
    await run('pc1', (e) => e.upload(false))
    await run('pc2', async (e) => e.subscribe(await linkOf('pc1')))
    const text = await readFile(
      join(pcs.root, 'pc2', 'auth-load-balancer-sync.json'),
      'utf8',
    )
    expect(text).not.toContain(CLAUDE_TOKEN)
    expect(text).toContain(fingerprint(CLAUDE_TOKEN))
  })
})

describe('ownership of imported rows', () => {
  const subscribe = async (pc: string) =>
    run(pc, async (e) => e.subscribe(await linkOf('pc1')))
  const republish = async (...pc1Rows: PoolAccount[]) => {
    await seed('pc1', ...pc1Rows)
    await run('pc1', (e) => e.upload(false))
  }

  test('a token the user pasted meanwhile stays theirs when the other machine rotates to it, and is not removed later', async () => {
    await republish(tokenRow('p1', CLAUDE_TOKEN))
    await subscribe('pc2')
    await on('pc2', () =>
      mutatePool((pool) => {
        pool.accounts.push(
          tokenRow('mine', CLAUDE_TOKEN_2, { orgId: 'org-other' }),
        )
      }),
    )
    await republish(tokenRow('p1', CLAUDE_TOKEN_2))
    expect((await run('pc2', (e) => e.sync())).message).toBe(
      'Synced: 0 added, 0 updated, 1 removed.',
    )
    expect((await rows('pc2')).map((r) => r.id)).toEqual(['mine'])
    expect((await state('pc2'))?.imported).toEqual({})

    await republish()
    await run('pc2', (e) => e.sync())
    expect((await rows('pc2')).map((r) => r.id)).toEqual(['mine'])
  })

  test('an entry that turns into another provider takes the old credential back and leaves the own OAuth login alone', async () => {
    await republish(publisherRow({ id: 'p1' }))
    await seed('pc2', ownOauthRow())
    await subscribe('pc2')
    expect((await rows('pc2'))[0]).toMatchObject({
      id: 'mine',
      inferenceToken: CLAUDE_TOKEN,
    })
    await republish(kimiRow('p1'))
    expect((await run('pc2', (e) => e.sync())).message).toBe(
      'Synced: 0 added, 1 updated, 0 removed.',
    )
    const after = await rows('pc2')
    const own = after.find((r) => r.id === 'mine')
    expect(own).toMatchObject({
      access: 'MY-ACCESS',
      refresh: 'MY-REFRESH',
      orgId: 'org-1',
    })
    expect(own).not.toHaveProperty('inferenceToken')
    const kimi = after.find((r) => r.providerID === 'kimi-code-plan-cn')
    expect(kimi).toMatchObject({ access: KIMI_KEY, refresh: '' })
    expect(after).toHaveLength(2)
  })

  test('only the organization the provider confirmed pairs a token; none confirmed means a row of its own', async () => {
    await republish(publisherRow({ id: 'p1' }))
    await seed('pc2', ownOauthRow())
    const headerless = [claudeSyncAdapter(null), kimiSyncAdapter()]
    const link = await linkOf('pc1')
    await on('pc2', () => engine(headerless).subscribe(link))
    const after = await rows('pc2')
    expect(after).toHaveLength(2)
    expect(after.find((r) => r.id === 'mine')).not.toHaveProperty(
      'inferenceToken',
    )
    expect(after.find((r) => r.id !== 'mine')).toMatchObject({
      refresh: '',
      inferenceToken: CLAUDE_TOKEN,
    })
  })

  test('reserved ids import, rotate and remove like any other', async () => {
    await republish(
      tokenRow('__proto__', CLAUDE_TOKEN),
      tokenRow('constructor', CLAUDE_TOKEN_2, { orgId: 'org-2' }),
    )
    const two = [claudeSyncAdapter(orgOf), kimiSyncAdapter()]
    const link = await linkOf('pc1')
    expect((await on('pc2', () => engine(two).subscribe(link))).message).toBe(
      'Synced: 2 added, 0 updated, 0 removed.',
    )
    const s = await state('pc2')
    expect(
      Object.keys(s?.imported ?? {})
        .map((k) => k.split('/')[1])
        .sort(),
    ).toEqual(['__proto__', 'constructor'])
    expect(Object.getPrototypeOf(s?.imported)).toBeNull()

    await republish(
      tokenRow('__proto__', `${CLAUDE_TOKEN}9`),
      tokenRow('constructor', CLAUDE_TOKEN_2, { orgId: 'org-2' }),
    )
    await on('pc2', () => engine(two).sync())
    expect((await rows('pc2')).map((r) => r.inferenceToken).sort()).toEqual(
      [`${CLAUDE_TOKEN}9`, CLAUDE_TOKEN_2].sort(),
    )
    await republish()
    await on('pc2', () => engine(two).sync())
    expect(await rows('pc2')).toEqual([])
    expect((await state('pc2'))?.imported).toEqual({})
  })

  test('a still-listed entry the receiver cannot read is never mistaken for a removal', async () => {
    await republish(
      tokenRow('p1', CLAUDE_TOKEN),
      tokenRow('p2', CLAUDE_TOKEN_2, { orgId: 'org-2' }),
    )
    const two = [claudeSyncAdapter(orgOf), kimiSyncAdapter()]
    const link = await linkOf('pc1')
    await on('pc2', () => engine(two).subscribe(link))
    const key = decodeKey((await state('pc2'))?.key ?? '') ?? Buffer.alloc(0)
    const origin = Object.keys((await state('pc2'))?.imported ?? {})[0]?.split(
      '/',
    )[0]
    const damaged = JSON.stringify({
      v: 2,
      at: world.clock + 1_000,
      entries: [
        {
          origin,
          id: 'p1',
          providerID: 'anthropic',
          label: 'x'.repeat(200),
          secret: CLAUDE_TOKEN,
        },
        {
          origin,
          id: 'p2',
          providerID: 'future-provider',
          label: 'p2',
          secret: 'whatever-secret',
        },
      ],
    })
    for (const gist of github.gists.values()) {
      gist.content = seal(damaged, key)
      gist.etag += 1
    }
    expect((await run('pc2', (e) => e.sync())).message).toBe('Up to date.')
    expect((await rows('pc2')).map((r) => r.inferenceToken).sort()).toEqual(
      [CLAUDE_TOKEN, CLAUDE_TOKEN_2].sort(),
    )
    expect(Object.keys((await state('pc2'))?.imported ?? {})).toHaveLength(2)
  })
})

describe('the watermark and clock steps', () => {
  const stampOf = async () => (await pcs.snapshot('pc1', gistContent())).at

  test('a member stamps every upload later than the snapshot it read and than its last, even when its clock steps back', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const first = await stampOf()
    world.clock -= 500_000
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    await run('pc1', (e) => e.upload(false))
    expect(await stampOf()).toBe(first + 1)
    world.clock += 2_000_000
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN }))
    await run('pc1', (e) => e.upload(false))
    expect(await stampOf()).toBe(world.clock)
  })

  test('an older ciphertext restored to the gist is refused; a newer one applies; a new gist resets the mark', async () => {
    await seed('pc1', tokenRow('p1', CLAUDE_TOKEN))
    await run('pc1', (e) => e.upload(false))
    const older = gistContent()
    await on('pc2', async () => engine(byOrg).subscribe(await linkOf('pc1')))

    world.clock += 1_000
    await seed('pc1', tokenRow('p1', CLAUDE_TOKEN_2))
    await run('pc1', (e) => e.upload(false))
    await on('pc2', () => engine(byOrg).sync())
    const applied = await rows('pc2')
    expect(applied[0]?.inferenceToken).toBe(CLAUDE_TOKEN_2)

    for (const gist of github.gists.values()) {
      gist.content = older
      gist.etag += 1
    }
    const out = await on('pc2', () => engine(byOrg).sync())
    expect(out).toMatchObject({ ok: false })
    expect(out.message).toContain('older snapshot')
    expect(await rows('pc2')).toEqual(applied)

    await seed('pc3', tokenRow('x1', CLAUDE_TOKEN, { orgId: 'org-9' }))
    world.tokens.add('pc3')
    await run('pc3', (e) => e.upload(true))
    await on('pc2', async () => engine(byOrg).subscribe(await linkOf('pc3')))
    expect((await state('pc2'))?.appliedAt).toBeLessThanOrEqual(world.clock)
    expect(
      (await rows('pc2')).some((r) => r.inferenceToken === CLAUDE_TOKEN),
    ).toBe(true)
  })
})

describe('scheduled work is decided again under the lock', () => {
  const FAR = 'f'.repeat(32)
  async function following(): Promise<string> {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    await run('pc2', async (e) => e.subscribe(await linkOf('pc1')))
    return (await state('pc2'))?.gistId ?? ''
  }
  const poll = (gistId: string, eng = engine()) =>
    on('pc2', () => eng.backgroundPoll(gistId))

  test('a cycle is due once the persisted poll interval has passed, not before', async () => {
    const gistId = await following()
    expect((await state('pc2'))?.pollAt).toBe(world.clock + POLL_MS)
    expect(await poll(gistId)).toBeNull()
    world.clock += POLL_MS
    expect(await poll(gistId)).toEqual({ ok: true, message: 'Up to date.' })
    expect((await state('pc2'))?.pollAt).toBe(world.clock + POLL_MS)
  })

  test('a cycle for another gist, or after forgetting, does nothing', async () => {
    const gistId = await following()
    world.clock += POLL_MS
    expect(await poll(FAR)).toBeNull()
    await run('pc2', (e) => e.forget())
    expect(await poll(gistId)).toBeNull()
  })

  test('a rate limit is remembered on disk, so another window stays away', async () => {
    const gistId = await following()
    world.clock += POLL_MS
    github.hooks.before = () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '300' } })
    const first = await poll(gistId)
    expect(first).toMatchObject({ ok: false, backoffMs: 300_000 })
    expect((await state('pc2'))?.retryAt).toBe(world.clock + 300_000)
    const calls = github.calls.length
    expect(await poll(gistId, engine())).toBeNull()
    expect(github.calls).toHaveLength(calls)
    world.clock += 300_000
    github.hooks.before = undefined
    expect((await poll(gistId))?.ok).toBe(true)
    expect((await state('pc2'))?.retryAt).toBeUndefined()
  })

  test('an upload is skipped for a forgotten, replaced or already uploaded state, and creates no gist', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const gistId = (await state('pc1'))?.gistId ?? ''
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    const digest = await run('pc1', (e) => e.unpublishedDigest())
    expect(digest).not.toBeNull()
    const publish = (id: string, d: string | null) =>
      run('pc1', (e) => e.backgroundPublish(id, d ?? ''))

    expect(await publish(FAR, digest)).toBeNull()
    expect(await publish(gistId, 'stale')).toBeNull()
    await run('pc1', (e) => e.forget())
    expect(await publish(gistId, digest)).toBeNull()
    expect(github.gists.size).toBe(1)
    expect(await state('pc1')).toBeNull()
    expect(await run('pc2', (e) => e.backgroundPublish(gistId, 'x'))).toBeNull()
  })

  test('an upload goes ahead when everything still matches', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const gistId = (await state('pc1'))?.gistId ?? ''
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    const digest = (await run('pc1', (e) => e.unpublishedDigest())) ?? ''
    const out = await run('pc1', (e) => e.backgroundPublish(gistId, digest))
    expect(out).toEqual({ ok: true, message: 'Uploaded 1 credential.' })
    expect(await run('pc1', (e) => e.unpublishedDigest())).toBeNull()
    expect((await state('pc1'))?.retryAt).toBeUndefined()
  })

  test('a failed automatic upload delays the next attempt on disk', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    const gistId = (await state('pc1'))?.gistId ?? ''
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    const digest = (await run('pc1', (e) => e.unpublishedDigest())) ?? ''
    github.hooks.before = (method) =>
      method === 'PATCH' ? new Response('{}', { status: 500 }) : undefined
    const failed = await run('pc1', (e) => e.backgroundPublish(gistId, digest))
    expect(failed).toMatchObject({ ok: false })
    expect((await state('pc1'))?.retryAt).toBe(world.clock + PUBLISH_RETRY_MS)
    github.hooks.before = undefined
    expect(
      await run('pc1', (e) => e.backgroundPublish(gistId, digest)),
    ).toBeNull()
    world.clock += PUBLISH_RETRY_MS
    expect(
      (await run('pc1', (e) => e.backgroundPublish(gistId, digest)))?.ok,
    ).toBe(true)
  })

  test('a member forgotten while its upload is in flight does not come back', async () => {
    await seed('pc1', publisherRow())
    await run('pc1', (e) => e.upload(false))
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    github.hooks.before = async (method) => {
      if (method === 'PATCH') await on('pc1', () => updateSyncState(() => null))
      return undefined
    }
    const out = await run('pc1', (e) => e.upload(false))
    expect(out.ok).toBe(true)
    expect(await state('pc1')).toBeNull()
  })
})
