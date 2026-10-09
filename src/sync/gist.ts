/** GitHub gist REST calls and the share link. The link's `#key` fragment never leaves this machine. */
import { ignore, isPlainObject } from '../util'
import { decodeKey, encodeKey, MAX_BLOB_BYTES } from './crypto'
import { SyncError } from './errors'

/** The one file a sync gist holds. */
export const GIST_FILE = 'auth-load-balancer-sync.json'
const API = 'https://api.github.com/gists'
const REQUEST_TIMEOUT_MS = 15_000
/** The most of a gist API response that is read (the sync file itself is capped at MAX_BLOB_BYTES). */
const MAX_RESPONSE_BYTES = 1024 * 1024
const MIN_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 3_600_000
const DEFAULT_BACKOFF_MS = 15 * 60_000
export const GIST_ID_RE = /^[\da-f]{20,40}$/i
const OWNER_RE = /^[\w-]{1,39}$/

export interface GistLink {
  id: string
  key: Buffer
}

/** The id and key of a `https://gist.github.com/<user>/<id>#<key>` link, or null for anything else. */
export function parseGistLink(link: string): GistLink | null {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== 'gist.github.com')
    return null
  const parts = url.pathname.split('/').filter(Boolean)
  const id = parts.at(-1)
  const owner = parts.length === 2 ? parts[0] : undefined
  const key = decodeKey(url.hash.slice(1))
  if (
    !id ||
    parts.length > 2 ||
    !GIST_ID_RE.test(id) ||
    (owner !== undefined && !OWNER_RE.test(owner)) ||
    !key
  )
    return null
  return { id, key }
}

/** The link to share: the gist's address plus the key as its fragment. */
export function formatGistLink(
  owner: string | undefined,
  id: string,
  key: Buffer,
): string {
  const path = owner ? `${owner}/${id}` : id
  return `https://gist.github.com/${path}#${encodeKey(key)}`
}

/** Seconds-since-epoch or delta header, as the wait before asking GitHub again. */
function backoffFrom(res: Response, now: number): number {
  const retryAfter = Number(res.headers.get('retry-after'))
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  const wait =
    retryAfter > 0
      ? retryAfter * 1000
      : reset > 0
        ? reset * 1000 - now
        : DEFAULT_BACKOFF_MS
  return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, wait))
}

function isRateLimited(res: Response): boolean {
  return (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' ||
        res.headers.has('retry-after')))
  )
}

async function request(
  url: string,
  init: RequestInit,
  now: number,
): Promise<Response> {
  let res: Response
  try {
    res = await globalThis.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new SyncError('network')
  }
  if (res.status === 404) throw new SyncError('not-found')
  if (isRateLimited(res))
    throw new SyncError('rate-limited', backoffFrom(res, now))
  return res
}

function headers(token?: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'opencode-auth-load-balancer',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

/**
 * The response body as text, read no further than MAX_RESPONSE_BYTES: the gist
 * is the owner's, and may hold large unrelated files that would otherwise be
 * buffered and parsed before any per-file limit applies.
 */
async function boundedText(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(ignore)
    throw new SyncError('too-large')
  }
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(ignore)
        throw new SyncError('too-large')
      }
      chunks.push(value)
    }
  } catch (error) {
    throw error instanceof SyncError ? error : new SyncError('network')
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) throw new SyncError('http')
  const text = await boundedText(res)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new SyncError('http')
  }
  if (!isPlainObject(json)) throw new SyncError('http')
  return json
}

export interface CreatedGist {
  id: string
  owner?: string
}

/** Create a secret gist holding `content`. */
export async function createGist(
  token: string,
  content: string,
  now: number = Date.now(),
): Promise<CreatedGist> {
  const res = await request(
    API,
    {
      method: 'POST',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'opencode-auth-load-balancer sync (encrypted)',
        public: false,
        files: { [GIST_FILE]: { content } },
      }),
    },
    now,
  )
  const json = await readJson(res)
  const owner = isPlainObject(json.owner) ? json.owner.login : undefined
  if (typeof json.id !== 'string' || !GIST_ID_RE.test(json.id))
    throw new SyncError('http')
  return {
    id: json.id,
    ...(typeof owner === 'string' && OWNER_RE.test(owner) ? { owner } : {}),
  }
}

/** Replace the sync file of gist `id` with `content`. */
export async function updateGist(
  token: string,
  id: string,
  content: string,
  now: number = Date.now(),
): Promise<void> {
  const res = await request(
    `${API}/${id}`,
    {
      method: 'PATCH',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ files: { [GIST_FILE]: { content } } }),
    },
    now,
  )
  await readJson(res)
}

export type GistRead =
  { changed: false } | { changed: true; content: string; etag?: string }

/** Read the sync file of gist `id` without credentials; a matching `etag` answers `changed: false` cheaply. */
export async function readGist(
  id: string,
  etag?: string,
  now: number = Date.now(),
): Promise<GistRead> {
  const res = await request(
    `${API}/${id}`,
    { headers: { ...headers(), ...(etag ? { 'if-none-match': etag } : {}) } },
    now,
  )
  if (res.status === 304) return { changed: false }
  const json = await readJson(res)
  const file = isPlainObject(json.files) ? json.files[GIST_FILE] : undefined
  if (!isPlainObject(file) || typeof file.content !== 'string')
    throw new SyncError('bad-blob')
  if (file.truncated === true || file.content.length > MAX_BLOB_BYTES)
    throw new SyncError('too-large')
  const next = res.headers.get('etag')
  return {
    changed: true,
    content: file.content,
    ...(next ? { etag: next } : {}),
  }
}
