import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

import { isPlainObject } from '../util'
import { SyncError } from './errors'

/** Blob format version; a reader refuses any other. */
export const BLOB_VERSION = 1
/** Largest blob (and gist file) a reader accepts. */
export const MAX_BLOB_BYTES = 256 * 1024
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const AAD = Buffer.from('opencode-auth-load-balancer/gist-sync/v1')
const KEY_RE = /^[\w-]{43}$/
const B64URL_RE = /^[\w-]+$/

/** A fresh random AES-256 key. */
export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** The key as it rides in the link's fragment. */
export function encodeKey(key: Buffer): string {
  return key.toString('base64url')
}

/** The key of a link fragment, or null when it is not a 32-byte base64url key. */
export function decodeKey(text: string): Buffer | null {
  return KEY_RE.test(text) ? Buffer.from(text, 'base64url') : null
}

/** A short stable digest, used to recognize a credential without keeping it. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 32)
}

/** Encrypt `plaintext` into the blob stored in the gist: a fresh nonce on every call. */
export function seal(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(AAD)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return JSON.stringify({
    v: BLOB_VERSION,
    n: nonce.toString('base64url'),
    c: data.toString('base64url'),
    t: cipher.getAuthTag().toString('base64url'),
  })
}

interface Blob {
  nonce: Buffer
  data: Buffer
  tag: Buffer
}

function parseBlob(text: string): Blob {
  if (Buffer.byteLength(text) > MAX_BLOB_BYTES) throw new SyncError('too-large')
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new SyncError('bad-blob')
  }
  if (!isPlainObject(json)) throw new SyncError('bad-blob')
  if (typeof json.v === 'number' && json.v !== BLOB_VERSION)
    throw new SyncError('bad-version')
  const { n, c, t } = json
  if (
    json.v !== BLOB_VERSION ||
    typeof n !== 'string' ||
    typeof c !== 'string' ||
    typeof t !== 'string' ||
    !B64URL_RE.test(n) ||
    !B64URL_RE.test(c) ||
    !B64URL_RE.test(t)
  )
    throw new SyncError('bad-blob')
  const nonce = Buffer.from(n, 'base64url')
  const tag = Buffer.from(t, 'base64url')
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES)
    throw new SyncError('bad-blob')
  return { nonce, data: Buffer.from(c, 'base64url'), tag }
}

/**
 * Decrypt a blob. Every failure is a typed `SyncError` that says nothing
 * about the content: a wrong key and a tampered blob look the same by design.
 */
export function open(text: string, key: Buffer): string {
  const { nonce, data, tag } = parseBlob(text)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    throw new SyncError('decrypt')
  }
}
