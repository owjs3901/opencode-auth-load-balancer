/**
 * What a sync gist carries: the static credentials of the pool, and nothing
 * else. OAuth access and refresh tokens never go in (a refresh token is
 * single-use, so two machines sharing one would kill it for both), and a
 * payload read back is untrusted: every field is allow-listed and bounded.
 * Every entry names the machine (origin) that listed it, and only that machine
 * ever adds, changes or removes it.
 */
import { isFiniteNumber, isPlainObject } from '../util'
import { fingerprint } from './crypto'
import { SyncError } from './errors'

export const PAYLOAD_VERSION = 2
export const MAX_ENTRIES = 64
export const MAX_LABEL = 80
const MAX_SECRET = 512
const MAX_FIELD = 128
const ID_RE = /^[\w-]{1,64}$/
/** A machine's origin: 128 random bits as hex. Not a secret, and never derived from a host name. */
export const ORIGIN_RE = /^[\da-f]{32}$/
const CLAUDE_TOKEN_RE = /^sk-ant-oat\d+-[\w-]+$/
const API_KEY_RE = /^\S{8,512}$/

/** The providers a credential may sync for, and the shape its secret must have. */
/** A Map, not an object: a provider id from a gist must never resolve to an inherited member such as `constructor`. */
export const SECRET_SHAPES: ReadonlyMap<string, RegExp> = new Map([
  ['anthropic', CLAUDE_TOKEN_RE],
  ['kimi-code-plan-cn', API_KEY_RE],
  ['kimi-code-plan-global', API_KEY_RE],
])

/** One synced credential, identified by the listing machine and its row id there. */
export interface SyncEntry {
  /** The machine that listed it. */
  origin: string
  /** That machine's row id. */
  id: string
  providerID: string
  label: string
  /** A Claude inference token, or a Kimi API key. */
  secret: string
  /** epoch ms a minted Claude token lapses. */
  expiresAt?: number
}

/** The identity of an entry across machines. */
export function entryKey(entry: Pick<SyncEntry, 'origin' | 'id'>): string {
  return `${entry.origin}/${entry.id}`
}

/**
 * Whether a character is invisible or steers the display (a label lands in the
 * TUI): C0 and C1 controls, DEL, and the bidi, zero-width and line/paragraph
 * format characters that can reorder or hide text.
 */
function isControl(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x61c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  )
}

/** `text` with those characters turned into spaces, trimmed. */
export function printable(text: string): string {
  return Array.from(text, (ch) =>
    isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch,
  )
    .join('')
    .trim()
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined
}

/** The key of a raw entry, when its origin and id are well formed (even if the rest is not). */
function keyOf(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null
  const { origin, id } = raw
  return typeof origin === 'string' &&
    ORIGIN_RE.test(origin) &&
    typeof id === 'string' &&
    ID_RE.test(id)
    ? `${origin}/${id}`
    : null
}

export function parseEntry(raw: unknown): SyncEntry | null {
  if (!isPlainObject(raw)) return null
  const origin = boundedString(raw.origin, 32)
  const id = boundedString(raw.id, 64)
  const providerID = boundedString(raw.providerID, MAX_FIELD)
  const label = printable(boundedString(raw.label, MAX_LABEL) ?? '')
  const secret = boundedString(raw.secret, MAX_SECRET)
  const shape = providerID ? SECRET_SHAPES.get(providerID) : undefined
  if (!origin || !ORIGIN_RE.test(origin)) return null
  if (!id || !ID_RE.test(id) || !providerID || !label || !secret) return null
  if (!shape?.test(secret)) return null
  const expiresAt =
    providerID === 'anthropic' &&
    isFiniteNumber(raw.expiresAt) &&
    raw.expiresAt > 0
      ? raw.expiresAt
      : undefined
  return {
    origin,
    id,
    providerID,
    label,
    secret,
    ...(expiresAt ? { expiresAt } : {}),
  }
}

/** The entries in a stable order (by key), so equal lists produce equal payloads. */
export function sortEntries(entries: readonly SyncEntry[]): SyncEntry[] {
  return [...entries].sort((a, b) => {
    const [x, y] = [entryKey(a), entryKey(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })
}

/** A digest of the entries: when it changes, the gist is out of date. */
export function entriesDigest(entries: readonly SyncEntry[]): string {
  return fingerprint(JSON.stringify(sortEntries(entries)))
}

/** The plaintext to encrypt. */
export function buildPayload(
  entries: readonly SyncEntry[],
  at: number,
): string {
  return JSON.stringify({
    v: PAYLOAD_VERSION,
    at,
    entries: sortEntries(entries),
  })
}

/** A snapshot read back: when it was written, its valid entries, and every key it still lists. */
export interface ParsedPayload {
  at: number
  entries: SyncEntry[]
  /**
   * Keys of every listed entry, valid or not. An entry that fails validation is
   * not imported, but it is still listed: it must never read as "removed".
   */
  listed: ReadonlySet<string>
  /** How many entries could not be read at all: a writer must not rewrite what it cannot parse. */
  unreadable: number
}

/**
 * The snapshot in a decrypted payload. Unknown fields, unknown providers,
 * malformed entries and duplicates are dropped; an unknown version, a
 * malformed envelope, a missing timestamp, or too many entries is an error.
 */
export function parsePayload(text: string): ParsedPayload {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new SyncError('bad-blob')
  }
  if (!isPlainObject(json) || !Array.isArray(json.entries))
    throw new SyncError('bad-blob')
  if (json.v !== PAYLOAD_VERSION) throw new SyncError('bad-version')
  if (!isFiniteNumber(json.at)) throw new SyncError('bad-blob')
  if (json.entries.length > MAX_ENTRIES) throw new SyncError('too-large')
  const listed = new Set<string>()
  const entries: SyncEntry[] = []
  let unreadable = 0
  for (const raw of json.entries) {
    const key = keyOf(raw)
    const entry = parseEntry(raw)
    if (key) {
      const seen = listed.has(key)
      listed.add(key)
      if (seen && entry) continue
    }
    if (entry) entries.push(entry)
    else unreadable += 1
  }
  return { at: json.at, entries, listed, unreadable }
}
