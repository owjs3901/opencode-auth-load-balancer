import { rm } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import { buildAuthHook } from '../legacy'
import type { ToastClient } from '../notify'
import type { PendingCoordinator } from '../pending/coordinator'
import { withCycleLock } from '../sync/loop'
import { publishAfterLogin } from '../sync/start'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'
import { responderFetch } from './fixtures/fetch-mock'
import { createPcs } from './fixtures/pcs'
import { fakeGithub } from './fixtures/sync'

const realFetch = globalThis.fetch
const github = fakeGithub()
const pcs = createPcs('login-publish')
const { world, on, seed, linkOf, run } = pcs

const loginRow = () =>
  testAccount({
    id: 'a1',
    providerID: 'openai',
    label: 'a1',
    access: 'ACCESS-a1',
    refresh: 'REFRESH-a1',
    expires: 4_000_000_000_000,
    accountId: 'acct-1',
    loginRev: 1,
    loginAt: 1_000,
  })

/** A machine's engine whose sync is replaced by `sync`, counting its calls. */
function spyEngine(sync: () => Promise<{ ok: boolean; message: string }>) {
  const calls = { count: 0 }
  const engine = {
    ...pcs.engine(),
    sync: () => {
      calls.count += 1
      return sync()
    },
  }
  return { engine, calls }
}
const fine = async () => ({ ok: true, message: 'ok' })

const patches = () => github.calls.filter((c) => c.method === 'PATCH').length

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
  world.tokens.clear()
  world.tokens.add('pcA')
  await rm(pcs.root, { recursive: true, force: true })
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.OPENCODE_AUTH_LB_SYNC
  delete process.env.OPENCODE_AUTH_LB_SYNC_LOGINS
})

/** pcA follows a gist it made with nothing in it; a login lands afterwards. */
async function followingEmpty(): Promise<void> {
  await seed('pcA')
  await run('pcA', (e) => e.upload(false))
  await seed('pcA', loginRow())
}

describe('publishing a login right after it landed', () => {
  test('a machine that follows a gist uploads the new login before the login returns', async () => {
    await followingEmpty()
    const before = patches()
    await on('pcA', () => publishAfterLogin({ engine: pcs.engine() }))
    expect(patches() - before).toBe(1)
    const link = await linkOf('pcA')
    await run('pcB', (e) => e.subscribe(link))
    expect((await pcs.rows('pcB')).map((r) => r.refresh)).toEqual([
      'REFRESH-a1',
    ])
  })

  test('a machine that follows nothing does nothing at all', async () => {
    await seed('pcA', loginRow())
    const { engine, calls } = spyEngine(fine)
    await on('pcA', () => publishAfterLogin({ engine }))
    expect(calls.count).toBe(0)
    expect(github.calls).toHaveLength(0)
  })

  test('sync switched off, or login sharing switched off, does nothing', async () => {
    await followingEmpty()
    const { engine, calls } = spyEngine(fine)
    process.env.OPENCODE_AUTH_LB_SYNC = '0'
    await on('pcA', () => publishAfterLogin({ engine }))
    delete process.env.OPENCODE_AUTH_LB_SYNC
    process.env.OPENCODE_AUTH_LB_SYNC_LOGINS = 'off'
    await on('pcA', () => publishAfterLogin({ engine }))
    expect(calls.count).toBe(0)
  })

  test('a failing upload is swallowed', async () => {
    await followingEmpty()
    const { engine, calls } = spyEngine(() => Promise.reject(new Error('boom')))
    await on('pcA', () => publishAfterLogin({ engine }))
    expect(calls.count).toBe(1)
  })

  test('a slow upload does not hold the login back beyond the bound, and is left to finish', async () => {
    // The bound also limits the real wait for the cycle lock, so it must
    // leave a loaded machine time to take it; the test fires the deadline.
    const BOUND_MS = 4_000
    await followingEmpty()
    let finish: () => void = () => undefined
    const uploading = new Promise<void>((resolve) => {
      finish = resolve
    })
    let entered: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let finished = false
    const { engine, calls } = spyEngine(async () => {
      entered()
      await uploading
      finished = true
      return { ok: true, message: 'late' }
    })
    const setTimeout = globalThis.setTimeout
    let deadline: () => void = () => {
      throw new Error('No publication deadline registered')
    }
    function controlledTimeout(
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ): number
    function controlledTimeout<TArgs extends unknown[]>(
      callback: (...args: TArgs) => void,
      delay?: number,
      ...args: [void] extends TArgs ? Partial<TArgs> : TArgs
    ): ReturnType<typeof setTimeout>
    function controlledTimeout(...input: unknown[]): unknown {
      const [callback, delay, ...args] = input
      if (delay === BOUND_MS) {
        if (typeof callback !== 'function')
          throw new Error('Expected a deadline callback')
        deadline = () => Reflect.apply(callback, undefined, args)
        return setTimeout(() => undefined, 0)
      }
      return Reflect.apply(setTimeout, undefined, input)
    }
    const intercept = Object.assign(controlledTimeout, {
      __promisify__: setTimeout.__promisify__,
    })
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(intercept)
    let returned = false
    const publishing = on('pcA', () =>
      publishAfterLogin({ engine, timeoutMs: BOUND_MS }),
    ).then(() => {
      returned = true
    })
    try {
      await started
      expect(returned).toBe(false)
      deadline()
      await publishing
      expect(returned).toBe(true)
      expect(finished).toBe(false)
      expect(calls.count).toBe(1)
    } finally {
      try {
        finish()
        await publishing
        await on('pcA', () => withCycleLock(fine, 1_000))
      } finally {
        timer.mockRestore()
      }
    }
  })

  test('a busy machine-wide lock gives up within the bound without syncing', async () => {
    await followingEmpty()
    const { engine, calls } = spyEngine(fine)
    await on('pcA', () =>
      withCycleLock(() => publishAfterLogin({ engine, timeoutMs: 60 }), 1_000),
    )
    expect(calls.count).toBe(0)
  })
})

describe('the login flow of a provider', () => {
  const hookFor = (refresh: string) =>
    buildAuthHook(
      fakeAdapter({
        id: 'openai',
        exchange: async () => ({
          access: 'ACCESS-new',
          refresh,
          expires: 4_000_000_000_000,
          accountId: 'acct-7',
        }),
      }),
      { tui: { showToast: async () => undefined } } as unknown as ToastClient,
      {} as unknown as PendingCoordinator,
    )
  const login = async (refresh: string) => {
    const method = hookFor(refresh).methods[0]
    if (method?.type !== 'oauth') return undefined
    const flow = await method.authorize()
    return flow.method === 'code' ? flow.callback('CODE') : undefined
  }
  const loginsInGist = async () =>
    (await pcs.snapshot('pcA', gistContent())).logins.map((l) => l.key)
  const gistContent = () => [...github.gists.values()][0]?.content ?? ''

  test('an OAuth login that lands on a machine that follows a gist is uploaded before the login returns', async () => {
    await seed('pcA')
    await run('pcA', (e) => e.upload(false))
    process.env.GITHUB_TOKEN = 'ghp_fake'
    try {
      const done = await on('pcA', () => login('REFRESH-new'))
      expect(done).toMatchObject({ type: 'success' })
    } finally {
      delete process.env.GITHUB_TOKEN
    }
    expect(await loginsInGist()).toEqual(['openai:acct-7'])
  })

  test('a login that is not an OAuth pair publishes nothing and a machine that follows nothing is not touched', async () => {
    await on('pcA', () => login(''))
    expect(github.calls).toHaveLength(0)
    expect((await pcs.rows('pcA')).map((r) => r.accountId)).toEqual(['acct-7'])
  })
})
