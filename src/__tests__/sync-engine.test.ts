import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { syncStatusFilePath } from '../pool/paths'
import { findAccount, mutatePool, readPool } from '../pool/store'
import { decodeKey, fingerprint, open, seal } from '../sync/crypto'
import { createEngine, type SyncEngine } from '../sync/engine'
import { formatGistLink } from '../sync/gist'
import { readSyncState, updateSyncState } from '../sync/state'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'
import { responderFetch } from './fixtures/fetch-mock'
import {
  CLAUDE_TOKEN,
  CLAUDE_TOKEN_2,
  fakeGithub,
  KIMI_KEY,
  REJECTED_TOKEN,
} from './fixtures/sync'
import { claudeSyncAdapter, kimiSyncAdapter } from './fixtures/sync-adapters'

const ROOT = mkdtempSync(join(tmpdir(), 'auth-lb-sync-engine-'))
const realFetch = globalThis.fetch
const github = fakeGithub()
let clock = 1_000_000
const adapters = [claudeSyncAdapter(), kimiSyncAdapter()]
const engine = (list = adapters): SyncEngine =>
  createEngine({
    now: () => clock,
    adapters: list,
    runGh: () => Promise.reject(new Error('no gh')),
  })

/** Run `fn` as the machine whose data dir is `name`. */
async function on<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCODE_AUTH_LB_DIR
  process.env.OPENCODE_AUTH_LB_DIR = join(ROOT, name)
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
    else process.env.OPENCODE_AUTH_LB_DIR = previous
  }
}

const seed = (name: string, ...rows: PoolAccount[]) =>
  on(name, () =>
    mutatePool((pool) => {
      pool.accounts = rows
    }),
  )
const rows = (name: string) => on(name, async () => (await readPool()).accounts)

/** The share link of the publisher on `name`. */
async function linkOf(name: string): Promise<string> {
  const state = await on(name, readSyncState)
  const key = decodeKey(state?.key ?? '')
  if (!state || !key) throw new Error('no publisher state')
  return formatGistLink(state.owner, state.gistId, key)
}

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

beforeEach(async () => {
  process.env.GITHUB_TOKEN = 'ghp_test'
  github.gists.clear()
  github.calls.length = 0
  github.hooks.before = undefined
  globalThis.fetch = responderFetch(() => github.respond)
  clock = 1_000_000
  await rm(ROOT, { recursive: true, force: true })
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.GITHUB_TOKEN
})

describe('publishing', () => {
  test('uploads ciphertext only, to a secret gist, and reports without the link', async () => {
    await seed('pc1', publisherRow())
    const out = await on('pc1', () => engine().upload(false, 77))
    expect(out).toEqual({ ok: true, message: 'Uploaded 1 credential.' })
    const stored = [...github.gists.values()][0]?.content ?? ''
    for (const leak of [
      CLAUDE_TOKEN,
      'sk-ant',
      'OAUTH-REFRESH-SECRET',
      'OAUTH-ACCESS-SECRET',
      'work',
    ])
      expect(stored).not.toContain(leak)
    const state = await on('pc1', readSyncState)
    expect(state).toMatchObject({
      role: 'publisher',
      owner: 'octo',
      imported: {},
    })
    const status = await readFile(
      join(ROOT, 'pc1', 'auth-load-balancer-sync-status.json'),
      'utf8',
    )
    expect(JSON.parse(status)).toMatchObject({ ok: true, reqAt: 77, at: clock })
    expect(status).not.toContain(state?.key ?? 'x')
    expect(status).not.toContain(state?.gistId ?? 'x')
    const pool = await readFile(
      join(ROOT, 'pc1', 'auth-load-balancer.json'),
      'utf8',
    )
    expect(pool).not.toContain(state?.key ?? 'x')
  })

  test('without a GitHub token, uploading says so and creates nothing', async () => {
    delete process.env.GITHUB_TOKEN
    const out = await on('pc1', () => engine().upload(false))
    expect(out.ok).toBe(false)
    expect(out.message).toContain('GITHUB_TOKEN')
    expect(github.gists.size).toBe(0)
    expect(await on('pc1', readSyncState)).toBeNull()
  })

  test('the token can come from the gh CLI', async () => {
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    const viaGh = createEngine({
      now: () => clock,
      adapters,
      runGh: async () => 'gh-token\n',
    })
    expect((await on('pc1', () => viaGh.upload(false))).ok).toBe(true)
    expect(github.calls[0]?.authorization).toBe('Bearer gh-token')
  })

  test('later uploads update the same gist under the same link; fresh makes a new one', async () => {
    await seed('pc1', publisherRow())
    await on('pc1', () => engine().upload(false))
    const link = await linkOf('pc1')
    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    expect(await on('pc1', () => engine().unpublishedDigest())).not.toBeNull()
    await on('pc1', () => engine().upload(false))
    expect(github.gists.size).toBe(1)
    expect(await linkOf('pc1')).toBe(link)
    expect(await on('pc1', () => engine().unpublishedDigest())).toBeNull()
    await on('pc1', () => engine().upload(true))
    expect(github.gists.size).toBe(2)
    expect(await linkOf('pc1')).not.toBe(link)
  })

  test('each upload uses a fresh nonce under the stable key', async () => {
    await seed('pc1', publisherRow())
    await on('pc1', () => engine().upload(false))
    const first = [...github.gists.values()][0]?.content ?? ''
    await on('pc1', () => engine().upload(false))
    const second = [...github.gists.values()][0]?.content ?? ''
    expect(JSON.parse(first).n).not.toBe(JSON.parse(second).n)
  })

  test('a gist deleted under the publisher is reported, not recreated silently', async () => {
    await seed('pc1', publisherRow())
    await on('pc1', () => engine().upload(false))
    github.gists.clear()
    const out = await on('pc1', () => engine().upload(false))
    expect(out).toMatchObject({
      ok: false,
      message: 'The gist no longer exists.',
    })
    expect(github.gists.size).toBe(0)
  })

  test('a subscriber has nothing to publish; no state means nothing either', async () => {
    expect(await on('pc1', () => engine().unpublishedDigest())).toBeNull()
  })
})

describe('subscribing', () => {
  async function publish(...pcRows: PoolAccount[]): Promise<string> {
    await seed('pc1', ...pcRows)
    await on('pc1', () => engine().upload(false))
    return linkOf('pc1')
  }

  test("a bare link registers the token on the machine's own OAuth row; changes and removals follow", async () => {
    const link = await publish(publisherRow())
    await seed('pc2', ownOauthRow())

    const first = await on('pc2', () => engine().subscribe(link, 5))
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

    expect(await on('pc2', () => engine().poll())).toEqual({
      ok: true,
      message: 'Up to date.',
    })

    await seed('pc1', publisherRow({ inferenceToken: CLAUDE_TOKEN_2 }))
    await on('pc1', () => engine().upload(false))
    expect((await on('pc2', () => engine().poll())).message).toBe(
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
    await on('pc1', () => engine().upload(false))
    expect((await on('pc2', () => engine().poll())).message).toBe(
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
    expect((await on('pc2', readSyncState))?.imported).toEqual({})
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
      }),
    )
    expect((await on('pc2', () => engine().subscribe(link))).message).toBe(
      'Synced: 2 added, 0 updated, 0 removed.',
    )
    const imported = await rows('pc2')
    expect(imported.map((r) => r.label).sort()).toEqual([
      'work',
      'work (2)',
      'work (3)',
    ])
    expect(imported.filter((r) => r.refresh === '')).toHaveLength(3)

    await seed('pc1')
    await on('pc1', () => engine().upload(false))
    expect((await on('pc2', () => engine().poll())).message).toBe(
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
    expect((await on('pc2', () => engine().subscribe(link))).message).toBe(
      'Synced: 0 added, 0 updated, 0 removed.',
    )
    await seed('pc1')
    await on('pc1', () => engine().upload(false))
    await on('pc2', () => engine().poll())
    expect((await rows('pc2')).map((r) => r.id)).toEqual(['own'])
  })

  test('a changed token on a token-only row replaces it in place', async () => {
    const link = await publish(
      publisherRow({ refresh: '', access: CLAUDE_TOKEN }),
    )
    await on('pc2', () => engine().subscribe(link))
    const [before] = await rows('pc2')
    await seed(
      'pc1',
      publisherRow({
        refresh: '',
        access: CLAUDE_TOKEN_2,
        inferenceToken: CLAUDE_TOKEN_2,
      }),
    )
    await on('pc1', () => engine().upload(false))
    await on('pc2', () => engine().poll())
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
    await on('pc2', () => engine().subscribe(link))
    const [imported] = await rows('pc2')
    await on('pc2', () =>
      mutatePool((pool) => {
        const row = findAccount(pool, imported?.id ?? '')
        if (row) {
          row.inferenceToken = 'sk-ant-oat01-USER_pasted-9999'
          row.access = 'sk-ant-oat01-USER_pasted-9999'
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
    await on('pc1', () => engine().upload(false))
    await on('pc2', () => engine().poll())
    const after = await rows('pc2')
    expect(after.map((r) => r.inferenceToken).sort()).toEqual(
      [CLAUDE_TOKEN_2, 'sk-ant-oat01-USER_pasted-9999'].sort(),
    )
  })

  test('what the user deleted or re-pointed locally is not undone while the gist is unchanged', async () => {
    const link = await publish(
      publisherRow({ refresh: '', access: CLAUDE_TOKEN }),
    )
    await on('pc2', () => engine().subscribe(link))
    await seed('pc2')
    await on('pc1', () => engine().upload(false))
    expect((await on('pc2', () => engine().poll())).message).toBe(
      'Synced: 0 added, 0 updated, 0 removed.',
    )
    expect(await rows('pc2')).toEqual([])
  })

  test("a Kimi key never touches the machine's own OAuth login for that account", async () => {
    const kimi = (over: Partial<PoolAccount> = {}) =>
      testAccount({
        id: 'k1',
        providerID: 'kimi-code-plan-cn',
        label: 'kimi',
        access: KIMI_KEY,
        refresh: '',
        ...over,
      })
    const link = await publish(kimi())
    await seed(
      'pc2',
      kimi({
        id: 'kimi-oauth',
        access: 'OAUTH-ACCESS',
        refresh: 'OAUTH-REFRESH',
        accountId: 'kimi-user-1',
      }),
    )
    expect((await on('pc2', () => engine().subscribe(link))).message).toBe(
      'Synced: 1 added, 0 updated, 0 removed.',
    )
    expect((await rows('pc2'))[0]).toMatchObject({
      id: 'kimi-oauth',
      access: 'OAUTH-ACCESS',
      refresh: 'OAUTH-REFRESH',
    })
    await seed('pc1')
    await on('pc1', () => engine().upload(false))
    await on('pc2', () => engine().poll())
    expect((await rows('pc2'))[0]).toMatchObject({
      id: 'kimi-oauth',
      access: 'OAUTH-ACCESS',
      refresh: 'OAUTH-REFRESH',
    })
  })

  test('a Kimi key on a machine with no such account becomes a row, and updates in place', async () => {
    const kimi = (access: string) =>
      testAccount({
        id: 'k1',
        providerID: 'kimi-code-plan-cn',
        label: 'kimi',
        access,
        refresh: '',
      })
    const link = await publish(kimi(KIMI_KEY))
    await on('pc2', () => engine().subscribe(link))
    const [row] = await rows('pc2')
    expect(row).toMatchObject({
      providerID: 'kimi-code-plan-cn',
      access: KIMI_KEY,
      refresh: '',
      accountId: 'kimi-user-1',
    })
    await seed('pc1', kimi('sk-kimi-rotated-key-98765'))
    await on('pc1', () => engine().upload(false))
    await on('pc2', () => engine().poll())
    const after = await rows('pc2')
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({
      id: row?.id,
      access: 'sk-kimi-rotated-key-98765',
    })
  })

  test('an entry that cannot be verified yet is retried: its etag is not kept', async () => {
    const link = await publish(
      publisherRow({
        id: 'bad',
        inferenceToken: REJECTED_TOKEN,
        refresh: '',
        access: REJECTED_TOKEN,
      }),
      publisherRow({
        id: 'ok',
        inferenceToken: CLAUDE_TOKEN_2,
        refresh: '',
        access: CLAUDE_TOKEN_2,
      }),
    )
    const out = await on('pc2', () => engine().subscribe(link))
    expect(out.message).toBe(
      'Synced: 1 added, 0 updated, 0 removed; 1 entry could not be verified yet.',
    )
    expect((await on('pc2', readSyncState))?.etag).toBeUndefined()
    await on('pc2', () => engine().poll())
    expect(github.calls.at(-1)?.url).toContain('/gists/')
    expect((await rows('pc2')).filter((r) => r.refresh === '')).toHaveLength(1)
  })

  test('a provider this build lacks, or an adapter that throws, defers the entry', async () => {
    const link = await publish(
      publisherRow({
        id: 'c',
        refresh: '',
        access: CLAUDE_TOKEN,
        inferenceToken: CLAUDE_TOKEN,
      }),
      testAccount({
        id: 'k',
        providerID: 'kimi-code-plan-cn',
        access: KIMI_KEY,
        refresh: '',
      }),
    )
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
    const missing = await on('pc2', () => engine([]).poll())
    expect(missing.message).toContain('2 entries could not be verified yet')
  })

  test('subscribing again keeps what was imported for the same gist and forgets it for another', async () => {
    const link = await publish(
      publisherRow({ refresh: '', access: CLAUDE_TOKEN }),
    )
    await on('pc2', () => engine().subscribe(link))
    const kept = (await on('pc2', readSyncState))?.imported
    expect(Object.keys(kept ?? {})).toHaveLength(1)
    await on('pc2', () => engine().subscribe(link))
    expect((await on('pc2', readSyncState))?.imported).toEqual(kept)

    await seed(
      'pc3',
      publisherRow({
        id: 'x',
        refresh: '',
        access: CLAUDE_TOKEN_2,
        inferenceToken: CLAUDE_TOKEN_2,
      }),
    )
    await on('pc3', () => engine().upload(true))
    const other = await linkOf('pc3')
    await on('pc2', () => engine().subscribe(other))
    expect(
      Object.keys((await on('pc2', readSyncState))?.imported ?? {}),
    ).toEqual(['x'])
  })

  test('a link that is not a gist link with a key changes nothing', async () => {
    const out = await on('pc2', () =>
      engine().subscribe('https://example.com/x#y', 3),
    )
    expect(out).toMatchObject({ ok: false })
    expect(out.message).toContain('gist link')
    expect(await on('pc2', readSyncState)).toBeNull()
    const status = JSON.parse(
      await readFile(
        join(ROOT, 'pc2', 'auth-load-balancer-sync-status.json'),
        'utf8',
      ),
    )
    expect(status.reqAt).toBe(3)
  })
})

describe('a gist that cannot be trusted leaves the pool untouched', () => {
  async function following(): Promise<{ link: string; before: PoolAccount[] }> {
    await seed('pc1', publisherRow())
    await on('pc1', () => engine().upload(false))
    const link = await linkOf('pc1')
    await seed('pc2', ownOauthRow())
    await on('pc2', () => engine().subscribe(link))
    return { link, before: await rows('pc2') }
  }
  const setContent = (content: string) => {
    for (const gist of github.gists.values()) {
      gist.content = content
      gist.etag += 1
    }
  }
  const current = () => [...github.gists.values()][0]?.content ?? ''

  test.each([
    ['tampered', () => setContent(current().replace('"c":"', '"c":"AAAA'))],
    ['not a sync file', () => setContent('hello')],
    [
      'another version',
      () => setContent(JSON.stringify({ ...JSON.parse(current()), v: 2 })),
    ],
    [
      'rotated to a new key',
      () => setContent(seal('{"v":1,"entries":[]}', Buffer.alloc(32, 7))),
    ],
  ])('%s', async (_name, damage) => {
    const { before } = await following()
    damage()
    const out = await on('pc2', () => engine().poll())
    expect(out.ok).toBe(false)
    expect(out.message).not.toMatch(/sk-ant|#[\w-]{20}/)
    expect(await rows('pc2')).toEqual(before)
  })

  test('a payload of a newer version is refused after decrypting', async () => {
    const { before } = await following()
    const key = decodeKey((await on('pc2', readSyncState))?.key ?? '')
    setContent(
      seal(JSON.stringify({ v: 2, entries: [] }), key ?? Buffer.alloc(0)),
    )
    const out = await on('pc2', () => engine().poll())
    expect(out.message).toContain('newer version')
    expect(await rows('pc2')).toEqual(before)
  })

  test('a deleted gist is reported and nothing is removed', async () => {
    const { before } = await following()
    github.gists.clear()
    const out = await on('pc2', () => engine().poll())
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
    const out = await on('pc2', () => engine().poll())
    expect(out).toMatchObject({ ok: false, backoffMs: 300_000 })
  })

  test('a gist the key cannot open is a decrypt error, and a payload of garbage is a bad sync file', async () => {
    const { link } = await following()
    const key =
      decodeKey((await on('pc2', readSyncState))?.key ?? '') ?? Buffer.alloc(0)
    setContent(seal('not json', key))
    expect((await on('pc2', () => engine().poll())).message).toContain(
      'does not hold a sync file',
    )
    expect(open(current(), key)).toBe('not json')
    expect(link).toContain('gist.github.com')
  })

  test('forgetting mid-download is not undone by the download finishing', async () => {
    await following()
    setContent(
      seal(
        '{"v":1,"entries":[]}',
        decodeKey((await on('pc2', readSyncState))?.key ?? '') ??
          Buffer.alloc(0),
      ),
    )
    github.hooks.before = (_method, url) => {
      if (url.includes('/gists/'))
        void on('pc2', () => updateSyncState(() => null))
      return undefined
    }
    await on('pc2', () => engine().poll())
    await Bun.sleep(50)
    expect(await on('pc2', readSyncState)).toBeNull()
  })
})

describe('stopping and dispatch', () => {
  test('forget removes the state and keeps what was imported', async () => {
    await seed('pc1', publisherRow({ refresh: '', access: CLAUDE_TOKEN }))
    await on('pc1', () => engine().upload(false))
    await on('pc2', async () => engine().subscribe(await linkOf('pc1')))
    expect(await rows('pc2')).toHaveLength(1)
    const out = await on('pc2', () => engine().forget(9))
    expect(out.message).toContain('Imported accounts stay')
    expect(await on('pc2', readSyncState)).toBeNull()
    expect(await rows('pc2')).toHaveLength(1)
  })

  test('sync uploads for a publisher, downloads for a subscriber, and says so when neither', async () => {
    expect((await on('pc2', () => engine().sync())).message).toBe(
      'Sync is not set up on this machine.',
    )
    await seed('pc1', publisherRow())
    expect((await on('pc1', () => engine().upload(false))).ok).toBe(true)
    expect((await on('pc1', () => engine().sync())).message).toBe(
      'Uploaded 1 credential.',
    )
    await on('pc2', async () => engine().subscribe(await linkOf('pc1')))
    expect((await on('pc2', () => engine().sync())).message).toBe('Up to date.')
  })

  test('the status file is written for every outcome', async () => {
    await on('pc2', () => engine().poll(4))
    const status = JSON.parse(
      await readFile(
        join(ROOT, 'pc2', 'auth-load-balancer-sync-status.json'),
        'utf8',
      ),
    )
    expect(status).toMatchObject({ ok: false, reqAt: 4 })
    expect(syncStatusFilePath()).not.toContain(ROOT)
  })

  test('fingerprints in the state never equal the secret', async () => {
    await seed('pc1', publisherRow({ refresh: '', access: CLAUDE_TOKEN }))
    await on('pc1', () => engine().upload(false))
    await on('pc2', async () => engine().subscribe(await linkOf('pc1')))
    const state = await readFile(
      join(ROOT, 'pc2', 'auth-load-balancer-sync.json'),
      'utf8',
    )
    expect(state).not.toContain(CLAUDE_TOKEN)
    expect(state).toContain(fingerprint(CLAUDE_TOKEN))
  })
})
