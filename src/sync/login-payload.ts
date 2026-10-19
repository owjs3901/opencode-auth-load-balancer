/**
 * The OAuth logins a sync gist carries: one access + refresh pair per
 * (provider, account), versioned so that every machine picks the same newest
 * copy. A login read back is untrusted, so it is parsed through a strict
 * allow-list: unknown fields are dropped and every bound is enforced.
 */
import { isFiniteNumber, isPlainObject } from '../util'
import { fingerprint } from './crypto'
import { boundedString, MAX_LABEL, printable } from './text'

export const MAX_LOGINS = 64
/** JWT access tokens are long; a refresh token can be too. Not the 512 of a static secret. */
const MAX_TOKEN = 8192
const MAX_ID = 128
const MAX_KEY = 300
const NO_SPACE_RE = /^\S+$/

/** A set, not an object: a provider id from a gist must never resolve to an inherited member such as `constructor`. */
export const LOGIN_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'kimi-code-plan-cn',
  'kimi-code-plan-global',
])

/** One shared login: the newest `(rev, at, refresh fingerprint)` of a key wins on every machine. */
export interface LoginRecord {
  /** `${providerID}:${accountId}`: the identity of the login across machines. */
  key: string
  providerID: string
  label: string
  access: string
  refresh: string
  /** epoch ms the access token lapses. */
  expires: number
  accountId: string
  orgId?: string
  /** epoch ms the login itself lapses, when known. */
  refreshExpires?: number
  rev: number
  at: number
}

export function loginKey(providerID: string, accountId: string): string {
  return `${providerID}:${accountId}`
}

function word(value: unknown, max: number): string | undefined {
  const text = boundedString(value, max)
  return text !== undefined && NO_SPACE_RE.test(text) ? text : undefined
}

function positive(value: unknown): number | undefined {
  return isFiniteNumber(value) && value > 0 ? value : undefined
}

export function parseLogin(raw: unknown): LoginRecord | null {
  if (!isPlainObject(raw)) return null
  const providerID = word(raw.providerID, MAX_ID)
  const accountId = word(raw.accountId, MAX_ID)
  const label = printable(boundedString(raw.label, MAX_LABEL) ?? '')
  const [access, refresh] = [
    word(raw.access, MAX_TOKEN),
    word(raw.refresh, MAX_TOKEN),
  ]
  const { rev, at } = raw
  if (!providerID || !LOGIN_PROVIDERS.has(providerID) || !accountId) return null
  if (raw.key !== loginKey(providerID, accountId)) return null
  const expires = positive(raw.expires)
  if (!label || !access || !refresh || !expires) return null
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1)
    return null
  if (!isFiniteNumber(at) || at < 0) return null
  const orgId = word(raw.orgId, MAX_ID)
  const refreshExpires = positive(raw.refreshExpires)
  return {
    key: loginKey(providerID, accountId),
    providerID,
    label,
    access,
    refresh,
    expires,
    accountId,
    ...(orgId ? { orgId } : {}),
    ...(refreshExpires ? { refreshExpires } : {}),
    rev,
    at,
  }
}

/** The logins in a stable order (by key), so equal lists produce equal payloads. */
export function sortLogins(logins: readonly LoginRecord[]): LoginRecord[] {
  return [...logins].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  )
}

/** A digest of the logins: when it changes, the gist is out of date. */
export function loginsDigest(logins: readonly LoginRecord[]): string {
  return fingerprint(JSON.stringify(sortLogins(logins)))
}

/**
 * The total order two machines share to pick the winner among copies of one
 * login: revision, then time, then the refresh token's fingerprint (so even a
 * tie of both is settled the same way everywhere). Positive when `a` is newer.
 */
export function compareLogins(
  a: Pick<LoginRecord, 'at' | 'refresh' | 'rev'>,
  b: Pick<LoginRecord, 'at' | 'refresh' | 'rev'>,
): number {
  if (a.rev !== b.rev) return a.rev < b.rev ? -1 : 1
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  const [x, y] = [fingerprint(a.refresh), fingerprint(b.refresh)]
  return x < y ? -1 : x > y ? 1 : 0
}

/** What a payload's login list yields: the valid logins, every key listed, and how many could not be read. */
export interface ParsedLogins {
  logins: LoginRecord[]
  loginsListed: Set<string>
  loginsUnreadable: number
}

/** Parse a raw login list. A duplicate key keeps the first valid login; an unreadable one is counted, never imported. */
export function parseLoginList(rawList: readonly unknown[]): ParsedLogins {
  const parsed: ParsedLogins = {
    logins: [],
    loginsListed: new Set(),
    loginsUnreadable: 0,
  }
  for (const raw of rawList) {
    const key = isPlainObject(raw) ? boundedString(raw.key, MAX_KEY) : undefined
    if (key) parsed.loginsListed.add(key)
    const login = parseLogin(raw)
    if (!login) parsed.loginsUnreadable += 1
    else if (!parsed.logins.some((l) => l.key === login.key))
      parsed.logins.push(login)
  }
  return parsed
}
