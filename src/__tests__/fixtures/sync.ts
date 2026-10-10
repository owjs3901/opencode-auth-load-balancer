import type { Responder } from './fetch-mock'

export const CLAUDE_TOKEN = 'sk-ant-oat01-AAAA_bbbb-1111'
export const CLAUDE_TOKEN_2 = 'sk-ant-oat01-CCCC_dddd-2222'
export const REJECTED_TOKEN = 'sk-ant-oat01-REJECTED_zzzz-0000'
export const KIMI_KEY = 'sk-kimi-key-0123456789'

interface GistFile {
  content: string
  etag: number
}

/** An in-memory GitHub gist API: create, patch, get with ETags, and per-test failure injection. */
export function fakeGithub() {
  const gists = new Map<string, GistFile>()
  const calls: { method: string; url: string; authorization: string | null }[] =
    []
  const hooks: {
    before?: (
      method: string,
      url: string,
    ) => Response | undefined | Promise<Response | undefined>
  } = {}
  let counter = 0

  const respond: Responder = async (url, init) => {
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, url, authorization: headers.get('authorization') })
    const injected = await hooks.before?.(method, url)
    if (injected) return injected
    const id = url.split('/gists/')[1]
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const content = body?.files?.['auth-load-balancer-sync.json']?.content
    if (method === 'POST') {
      counter += 1
      const newId = `${counter}`.padStart(32, 'a')
      gists.set(newId, { content, etag: 1 })
      return Response.json(
        { id: newId, owner: { login: 'octo' } },
        { status: 201 },
      )
    }
    const gist = id ? gists.get(id) : undefined
    if (!gist) return new Response('{}', { status: 404 })
    if (method === 'PATCH') {
      gist.content = content
      gist.etag += 1
      return Response.json({ id })
    }
    const etag = `W/"${gist.etag}"`
    if (headers.get('if-none-match') === etag)
      return new Response(null, { status: 304 })
    return Response.json(
      {
        id,
        files: { 'auth-load-balancer-sync.json': { content: gist.content } },
      },
      { headers: { etag } },
    )
  }
  return { respond, gists, calls, hooks }
}
