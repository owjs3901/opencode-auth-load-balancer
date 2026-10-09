import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { encodeKey, generateKey, MAX_BLOB_BYTES } from '../sync/crypto'
import { SyncError, type SyncErrorCode } from '../sync/errors'
import {
  createGist,
  formatGistLink,
  GIST_FILE,
  parseGistLink,
  readGist,
  updateGist,
} from '../sync/gist'
import {
  discoverGithubToken,
  type ExecFn,
  ghAuthToken,
} from '../sync/github-auth'
import { responderFetch } from './fixtures/fetch-mock'
import { fakeGithub } from './fixtures/sync'

const realFetch = globalThis.fetch
const github = fakeGithub()
beforeEach(() => {
  github.gists.clear()
  github.calls.length = 0
  github.hooks.before = undefined
  globalThis.fetch = responderFetch(() => github.respond)
})
afterEach(() => {
  globalThis.fetch = realFetch
})

async function codeOf(run: () => Promise<unknown>): Promise<SyncError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SyncError) return error
  }
  throw new Error('expected a SyncError')
}

const ID = 'a'.repeat(32)

describe('gist links', () => {
  const key = generateKey()
  const fragment = encodeKey(key)

  test('the id and key come out of the link, with or without the owner', () => {
    for (const link of [
      `https://gist.github.com/octo/${ID}#${fragment}`,
      `https://gist.github.com/${ID}#${fragment}`,
      `  https://gist.github.com/octo/${ID}/#${fragment}  `,
    ]) {
      const parsed = parseGistLink(link)
      expect(parsed?.id).toBe(ID)
      expect(parsed?.key.equals(key)).toBe(true)
    }
  })

  test('anything else is refused', () => {
    for (const link of [
      '',
      'not a url',
      `http://gist.github.com/octo/${ID}#${fragment}`,
      `https://evil.example/octo/${ID}#${fragment}`,
      `https://gist.github.com.evil.example/octo/${ID}#${fragment}`,
      `https://gist.github.com/octo/${ID}`,
      `https://gist.github.com/octo/${ID}#short`,
      `https://gist.github.com/octo/not-hex-id#${fragment}`,
      `https://gist.github.com/bad owner/${ID}#${fragment}`,
      `https://gist.github.com/a/b/${ID}#${fragment}`,
      `https://gist.github.com/#${fragment}`,
    ])
      expect(parseGistLink(link)).toBeNull()
  })

  test('the link to share is the gist address plus the key fragment', () => {
    expect(formatGistLink('octo', ID, key)).toBe(
      `https://gist.github.com/octo/${ID}#${fragment}`,
    )
    expect(formatGistLink(undefined, ID, key)).toBe(
      `https://gist.github.com/${ID}#${fragment}`,
    )
    expect(parseGistLink(formatGistLink('octo', ID, key))?.id).toBe(ID)
  })
})

describe('gist client', () => {
  test('create makes a secret gist with the one sync file and returns its id and owner', async () => {
    const made = await createGist('ghp_token', '{"blob":1}')
    expect(made.owner).toBe('octo')
    expect(github.gists.get(made.id)?.content).toBe('{"blob":1}')
    const call = github.calls[0]
    expect(call?.method).toBe('POST')
    expect(call?.authorization).toBe('Bearer ghp_token')
  })

  test('create sends public:false', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = responderFetch(() => (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ id: ID })
    })
    const made = await createGist('t', 'x')
    expect(body.public).toBe(false)
    expect(Object.keys(body.files as object)).toEqual([GIST_FILE])
    expect(made).toEqual({ id: ID })
  })

  test('update patches the same gist', async () => {
    const { id } = await createGist('t', 'one')
    await updateGist('t', id, 'two')
    expect(github.gists.get(id)?.content).toBe('two')
    expect(github.calls.at(-1)?.method).toBe('PATCH')
  })

  test('read is unauthenticated and 304s on a matching etag', async () => {
    const { id } = await createGist('t', 'one')
    const first = await readGist(id)
    expect(first).toEqual({ changed: true, content: 'one', etag: 'W/"1"' })
    expect(github.calls.at(-1)?.authorization).toBeNull()
    expect(await readGist(id, 'W/"1"')).toEqual({ changed: false })
    await updateGist('t', id, 'two')
    expect(await readGist(id, 'W/"1"')).toEqual({
      changed: true,
      content: 'two',
      etag: 'W/"2"',
    })
  })

  test('a response without an etag still reads', async () => {
    globalThis.fetch = responderFetch(
      () => () =>
        Response.json({
          files: { [GIST_FILE]: { content: 'c' } },
        }),
    )
    expect(await readGist(ID)).toEqual({ changed: true, content: 'c' })
  })

  test('a deleted gist is not-found for every verb', async () => {
    for (const run of [() => readGist(ID), () => updateGist('t', ID, 'x')])
      expect((await codeOf(run)).code).toBe('not-found')
  })

  test('rate limiting is recognized from a 403 with no quota left, or a 429', async () => {
    github.hooks.before = () =>
      new Response('{}', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor((1_000_000 + 600_000) / 1000)),
        },
      })
    const reset = await codeOf(() => readGist(ID, undefined, 1_000_000))
    expect(reset.code).toBe('rate-limited')
    expect(reset.retryAfterMs).toBe(600_000)

    github.hooks.before = () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '120' } })
    expect((await codeOf(() => readGist(ID))).retryAfterMs).toBe(120_000)

    github.hooks.before = () => new Response('{}', { status: 429 })
    expect((await codeOf(() => readGist(ID))).retryAfterMs).toBe(15 * 60_000)

    github.hooks.before = () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
    expect((await codeOf(() => readGist(ID))).retryAfterMs).toBe(60_000)

    github.hooks.before = () =>
      new Response('{}', { status: 403, headers: { 'retry-after': '99999' } })
    expect((await codeOf(() => readGist(ID))).retryAfterMs).toBe(3_600_000)
  })

  test('other refusals are http errors that say nothing about the body', async () => {
    for (const status of [403, 500, 422]) {
      github.hooks.before = () => new Response('secret detail', { status })
      const error = await codeOf(() => readGist(ID))
      expect(error.code).toBe('http')
      expect(error.message).not.toContain('secret detail')
    }
  })

  test('a network failure is a network error', async () => {
    globalThis.fetch = responderFetch(() => () => {
      throw new Error('ECONNRESET https://api.github.com/gists/x')
    })
    const error = await codeOf(() => readGist(ID))
    expect(error.code).toBe('network')
    expect(error.message).not.toContain('ECONNRESET')
  })

  test('replies that are not a gist are rejected', async () => {
    const cases: [string, SyncErrorCode][] = [
      ['not json', 'http'],
      ['[]', 'http'],
      [JSON.stringify({ files: {} }), 'bad-blob'],
      [JSON.stringify({ files: { [GIST_FILE]: { content: 5 } } }), 'bad-blob'],
      [
        JSON.stringify({
          files: { [GIST_FILE]: { content: 'x', truncated: true } },
        }),
        'too-large',
      ],
      [
        JSON.stringify({
          files: { [GIST_FILE]: { content: 'x'.repeat(MAX_BLOB_BYTES + 1) } },
        }),
        'too-large',
      ],
    ]
    for (const [body, code] of cases) {
      github.hooks.before = () => new Response(body, { status: 200 })
      expect((await codeOf(() => readGist(ID))).code).toBe(code)
    }
    github.hooks.before = () => Response.json({ id: 'not-an-id' })
    expect((await codeOf(() => createGist('t', 'x'))).code).toBe('http')
    github.hooks.before = () => new Response('{}', { status: 401 })
    expect((await codeOf(() => createGist('t', 'x'))).code).toBe('http')
    expect((await codeOf(() => updateGist('t', ID, 'x'))).code).toBe('http')
  })

  test('an owner that is not a login is not trusted', async () => {
    github.hooks.before = () =>
      Response.json({ id: ID, owner: { login: 'a/b' } })
    expect(await createGist('t', 'x')).toEqual({ id: ID })
    github.hooks.before = () => Response.json({ id: ID, owner: 'octo' })
    expect(await createGist('t', 'x')).toEqual({ id: ID })
  })
})

describe('GitHub token discovery', () => {
  const never = (): Promise<string> => Promise.reject(new Error('no gh'))

  test('GITHUB_TOKEN wins, then GH_TOKEN, then the gh CLI', async () => {
    expect(
      await discoverGithubToken(never, { GITHUB_TOKEN: ' a ', GH_TOKEN: 'b' }),
    ).toBe('a')
    expect(await discoverGithubToken(never, { GH_TOKEN: 'b' })).toBe('b')
    expect(
      await discoverGithubToken(async () => 'from-gh\n', { GITHUB_TOKEN: ' ' }),
    ).toBe('from-gh')
  })

  test('nothing found is null, not an error', async () => {
    expect(await discoverGithubToken(never, {})).toBeNull()
    expect(await discoverGithubToken(async () => '\n', {})).toBeNull()
  })

  test('gh is spawned with execFile semantics: fixed argv, short timeout, no shell', async () => {
    const seen: unknown[] = []
    const exec: ExecFn = (file, args, options, callback) => {
      seen.push(file, args, options)
      callback(null, 'tok\n')
    }
    expect(await ghAuthToken(exec)).toBe('tok\n')
    expect(seen[0]).toBe('gh')
    expect(seen[1]).toEqual(['auth', 'token'])
    expect(seen[2]).toMatchObject({ timeout: 5_000, windowsHide: true })
    const failing: ExecFn = (_f, _a, _o, callback) =>
      callback(new Error('ENOENT'), '')
    expect(ghAuthToken(failing)).rejects.toThrow('ENOENT')
  })
})
