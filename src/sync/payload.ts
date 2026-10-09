/**
 * What a sync gist carries: the static credentials of the pool, and nothing
 * else. OAuth access and refresh tokens never go in (a refresh token is
 * single-use, so two machines sharing one would kill it for both), and a
 * payload read back is untrusted: every field is allow-listed and bounded.
 */
import type { PoolFile } from '../types'
import { isFiniteNumber, isPlainObject } from '../util'
import { fingerprint } from './crypto'
import { SyncError } from './errors'

export const PAYLOAD_VERSION = 1
const MAX_ENTRIES = 64
const MAX_LABEL = 80
const MAX_SECRET = 512
const MAX_FIELD = 128
const ID_RE = /^[\w-]{1,64}$/
const ORG_RE = /^[\w.:-]{1,128}$/
const CLAUDE_TOKEN_RE = /^sk-ant-oat\d+-[\w-]+$/
const API_KEY_RE = /^\S{8,512}$/

/** The providers a credential may sync for, and the shape its secret must have. */
const SECRET_SHAPES: Readonly<Record<string, RegExp>> = {
  anthropic: CLAUDE_TOKEN_RE,
  'kimi-code-plan-cn': API_KEY_RE,
  'kimi-code-plan-global': API_KEY_RE,
}

/** One synced credential, keyed by the publisher's row id. */
export interface SyncEntry {
  id: string
  providerID: string
  label: string
  /** A Claude inference token, or a Kimi API key. */
  secret: string
  orgId?: string
  /** epoch ms a minted Claude token lapses. */
  expiresAt?: number
}

/** The static credentials of `pool`, sorted by row id so equal pools produce equal payloads. */
export function collectEntries(pool: PoolFile): SyncEntry[] {
  const entries: SyncEntry[] = []
  for (const row of pool.accounts) {
    const shape = SECRET_SHAPES[row.providerID]
    if (!shape || row.disabledReason || row.lostLogins?.token) continue
    const secret =
      row.providerID === 'anthropic'
        ? row.inferenceToken
        : row.refresh
          ? undefined
          : row.access
    if (!secret || !shape.test(secret)) continue
    entries.push({
      id: row.id,
      providerID: row.providerID,
      label: row.label,
      secret,
      ...(row.orgId ? { orgId: row.orgId } : {}),
      ...(row.providerID === 'anthropic' && row.inferenceExpires
        ? { expiresAt: row.inferenceExpires }
        : {}),
    })
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A digest of the entries: when it changes, the gist is out of date. */
export function entriesDigest(entries: readonly SyncEntry[]): string {
  return fingerprint(JSON.stringify(entries))
}

/** The plaintext to encrypt. */
export function buildPayload(
  entries: readonly SyncEntry[],
  now: number,
): string {
  return JSON.stringify({ v: PAYLOAD_VERSION, at: now, entries })
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined
}

/** `text` with control characters (a label lands in the TUI) turned into spaces. */
function printable(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : ch
  })
    .join('')
    .trim()
}

function parseEntry(raw: unknown): SyncEntry | null {
  if (!isPlainObject(raw)) return null
  const id = boundedString(raw.id, 64)
  const providerID = boundedString(raw.providerID, MAX_FIELD)
  const label = printable(boundedString(raw.label, MAX_LABEL) ?? '')
  const secret = boundedString(raw.secret, MAX_SECRET)
  const shape = providerID ? SECRET_SHAPES[providerID] : undefined
  if (!id || !ID_RE.test(id) || !providerID || !label || !secret) return null
  if (!shape?.test(secret)) return null
  const orgId = boundedString(raw.orgId, MAX_FIELD)
  const expiresAt =
    providerID === 'anthropic' &&
    isFiniteNumber(raw.expiresAt) &&
    raw.expiresAt > 0
      ? raw.expiresAt
      : undefined
  return {
    id,
    providerID,
    label,
    secret,
    ...(orgId && ORG_RE.test(orgId) ? { orgId } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

/**
 * The entries of a decrypted payload. Unknown fields, unknown providers,
 * malformed entries and duplicates are dropped; an unknown version, a
 * malformed envelope, or too many entries is an error.
 */
export function parsePayload(text: string): SyncEntry[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new SyncError('bad-blob')
  }
  if (!isPlainObject(json) || !Array.isArray(json.entries))
    throw new SyncError('bad-blob')
  if (json.v !== PAYLOAD_VERSION) throw new SyncError('bad-version')
  if (json.entries.length > MAX_ENTRIES) throw new SyncError('too-large')
  const seen = new Set<string>()
  const entries: SyncEntry[] = []
  for (const raw of json.entries) {
    const entry = parseEntry(raw)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}
