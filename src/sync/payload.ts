/**
 * What a sync gist carries: the static credentials of the pool, and nothing
 * else. OAuth access and refresh tokens never go in (a refresh token is
 * single-use, so two machines sharing one would kill it for both), and a
 * payload read back is untrusted: every field is allow-listed and bounded.
 */
import { type PoolFile, STATIC_CREDENTIAL_EXPIRES } from '../types'
import { isFiniteNumber, isPlainObject } from '../util'
import { fingerprint } from './crypto'
import { SyncError } from './errors'

export const PAYLOAD_VERSION = 1
const MAX_ENTRIES = 64
const MAX_LABEL = 80
const MAX_SECRET = 512
const MAX_FIELD = 128
const ID_RE = /^[\w-]{1,64}$/
const CLAUDE_TOKEN_RE = /^sk-ant-oat\d+-[\w-]+$/
const API_KEY_RE = /^\S{8,512}$/

/** The providers a credential may sync for, and the shape its secret must have. */
/** A Map, not an object: a provider id from a gist must never resolve to an inherited member such as `constructor`. */
const SECRET_SHAPES: ReadonlyMap<string, RegExp> = new Map([
  ['anthropic', CLAUDE_TOKEN_RE],
  ['kimi-code-plan-cn', API_KEY_RE],
  ['kimi-code-plan-global', API_KEY_RE],
])

/** One synced credential, keyed by the publisher's row id. */
export interface SyncEntry {
  id: string
  providerID: string
  label: string
  /** A Claude inference token, or a Kimi API key. */
  secret: string
  /** epoch ms a minted Claude token lapses. */
  expiresAt?: number
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

function parseEntry(raw: unknown): SyncEntry | null {
  if (!isPlainObject(raw)) return null
  const id = boundedString(raw.id, 64)
  const providerID = boundedString(raw.providerID, MAX_FIELD)
  const label = printable(boundedString(raw.label, MAX_LABEL) ?? '')
  const secret = boundedString(raw.secret, MAX_SECRET)
  const shape = providerID ? SECRET_SHAPES.get(providerID) : undefined
  if (!id || !ID_RE.test(id) || !providerID || !label || !secret) return null
  if (!shape?.test(secret)) return null
  const expiresAt =
    providerID === 'anthropic' &&
    isFiniteNumber(raw.expiresAt) &&
    raw.expiresAt > 0
      ? raw.expiresAt
      : undefined
  return { id, providerID, label, secret, ...(expiresAt ? { expiresAt } : {}) }
}

/**
 * The static credential of a row: a Claude `inferenceToken`, or a Kimi API
 * key. A Kimi row only counts when it carries the static-credential expiry as
 * well as no refresh token: an OAuth sign-in can also leave a refresh-less row,
 * with a short-lived access token that must never leave the machine.
 */
function staticSecret(row: PoolFile['accounts'][number]): string | undefined {
  if (row.providerID === 'anthropic') return row.inferenceToken
  return !row.refresh && row.expires === STATIC_CREDENTIAL_EXPIRES
    ? row.access
    : undefined
}

/**
 * The static credentials of `pool`, sorted by row id so equal pools produce
 * equal payloads. Every entry goes through the receiver's own validation (a
 * label too long is trimmed, a row whose id or secret a receiver would refuse
 * is left out, at most MAX_ENTRIES): the publisher never produces a snapshot
 * its subscribers would reject.
 */
export function collectEntries(pool: PoolFile): SyncEntry[] {
  const entries: SyncEntry[] = []
  for (const row of pool.accounts) {
    if (!SECRET_SHAPES.has(row.providerID)) continue
    if (row.disabledReason || row.lostLogins?.token) continue
    const entry = parseEntry({
      id: row.id,
      providerID: row.providerID,
      label: printable(row.label).slice(0, MAX_LABEL).trim() || row.providerID,
      secret: staticSecret(row),
      expiresAt: row.inferenceExpires,
    })
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return entries.slice(0, MAX_ENTRIES)
}

/** A digest of the entries: when it changes, the gist is out of date. */
export function entriesDigest(entries: readonly SyncEntry[]): string {
  return fingerprint(JSON.stringify(entries))
}

/** The plaintext to encrypt. */
export function buildPayload(
  entries: readonly SyncEntry[],
  at: number,
): string {
  return JSON.stringify({ v: PAYLOAD_VERSION, at, entries })
}

/** A snapshot read back: when it was written, its valid entries, and every id it still lists. */
export interface ParsedPayload {
  at: number
  entries: SyncEntry[]
  /**
   * Ids of every listed entry, valid or not. An entry that fails validation is
   * not imported, but it is still listed: it must never read as "removed".
   */
  listed: ReadonlySet<string>
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
  for (const raw of json.entries) {
    const id = isPlainObject(raw) ? raw.id : undefined
    const fresh = typeof id === 'string' && ID_RE.test(id) && !listed.has(id)
    if (typeof id === 'string' && ID_RE.test(id)) listed.add(id)
    const entry = fresh ? parseEntry(raw) : null
    if (entry) entries.push(entry)
  }
  return { at: json.at, entries, listed }
}
