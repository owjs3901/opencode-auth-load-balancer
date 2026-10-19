/**
 * OAuth logins in the gist: which of this machine's logins are shared, how a
 * newer copy from another machine lands on a row, and the guard that keeps a
 * row the user deleted from coming back. Any machine may refresh a shared
 * login; the copy with the newest `(rev, at, refresh fingerprint)` wins.
 */
import { clearLostLogin, placeTokens } from '../accounts'
import { loginVersion } from '../login-rev'
import { findAccount, mutatePool, readPool } from '../pool/store'
import { genOf, sameGeneration, withRefreshLock } from '../refresh'
import {
  MANUAL_DISABLED_REASON,
  type PoolAccount,
  type PoolFile,
  type TokenSet,
} from '../types'
import { uniqueLabel } from './apply'
import { fingerprint } from './crypto'
import {
  compareLogins,
  LOGIN_PROVIDERS,
  loginKey,
  type LoginRecord,
  loginsDigest,
  MAX_LOGINS,
  parseLogin,
  sortLogins,
} from './login-payload'
import { entriesDigest, type SyncEntry } from './payload'
import { newMap } from './state'
import { MAX_LABEL, printable } from './text'

/** The start of the reason `src/refresh.ts` writes when a refresh token is revoked: the one disabling an import may undo. */
const AUTO_DISABLED_PREFIX = 'invalid_grant: re-login required'

/** On unless `OPENCODE_AUTH_LB_SYNC_LOGINS` is `0` / `false` / `no` / `off`. */
export function loginsSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPENCODE_AUTH_LB_SYNC_LOGINS?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off'
}

/**
 * The login key of a row that holds an OAuth login: a row with a refresh
 * token, or one that fell back to its inference token after the login was
 * refused (it is still the user's row for that login).
 */
function rowKey(row: PoolAccount): string | null {
  const live =
    row.refresh !== '' ||
    (row.inferenceToken !== undefined && row.lostLogins?.oauth !== undefined)
  return LOGIN_PROVIDERS.has(row.providerID) && row.accountId && live
    ? loginKey(row.providerID, row.accountId)
    : null
}

/** The login keys the pool's rows hold. */
export function heldMarks(
  accounts: readonly PoolAccount[],
): Record<string, true> {
  const held = newMap<true>()
  for (const row of accounts) {
    const key = rowKey(row)
    if (key) held[key] = true
  }
  return held
}

/**
 * This machine's shareable logins, one per key: a real OAuth login (a refresh
 * token, not a Kimi API key or a setup-token), of a known account, that still
 * works. Usage, cooldowns, sessions, `tokenGen`, the inference token and local
 * ids never go in. Every login passes the receiver's own validation.
 */
export function ownLogins(pool: PoolFile): LoginRecord[] {
  const best = new Map<string, LoginRecord>()
  for (const row of pool.accounts) {
    if (!row.refresh || !row.accountId) continue
    if (row.disabledReason || row.lostLogins?.oauth) continue
    const login = parseLogin({
      key: loginKey(row.providerID, row.accountId),
      providerID: row.providerID,
      label: printable(row.label).slice(0, MAX_LABEL).trim() || row.providerID,
      access: row.access,
      refresh: row.refresh,
      expires: row.expires,
      accountId: row.accountId,
      orgId: row.orgId,
      refreshExpires: row.refreshExpires,
      ...loginVersion(row),
    })
    const prior = login ? best.get(login.key) : undefined
    if (login && (!prior || compareLogins(login, prior) > 0))
      best.set(login.key, login)
  }
  return sortLogins([...best.values()]).slice(0, MAX_LOGINS)
}

/**
 * The logins to write: per key the winner of the gist's and this machine's
 * copy. A gist login this machine has no copy of is carried over untouched; a
 * login of this machine the gist lacks is added while there is room.
 */
export function mergeLogins(
  gist: readonly LoginRecord[],
  own: readonly LoginRecord[],
): LoginRecord[] {
  const merged = new Map(gist.map((login) => [login.key, login]))
  for (const login of own) {
    const prior = merged.get(login.key)
    if (prior ? compareLogins(login, prior) > 0 : merged.size < MAX_LOGINS)
      merged.set(login.key, login)
  }
  return sortLogins([...merged.values()])
}

/** How many of this machine's logins are, as they are, what `next` lists. */
export function ownCopies(
  next: readonly LoginRecord[],
  own: readonly LoginRecord[],
): number {
  return own.filter((login) =>
    next.some((n) => n.key === login.key && n.refresh === login.refresh),
  ).length
}

/**
 * The digest of what this machine would publish: when it differs from the one
 * stored at the last upload, the gist may be out of date. Without logins it is
 * the entries' digest alone, so a machine that shares none keeps its old one.
 */
export function publishDigest(
  entries: readonly SyncEntry[],
  logins: readonly LoginRecord[],
): string {
  return logins.length === 0
    ? entriesDigest(entries)
    : fingerprint(`${entriesDigest(entries)}/${loginsDigest(logins)}`)
}

/** Whether `row` is this machine's copy of `login`: the same key, and the same organization when both know it. */
export function sameLogin(row: PoolAccount, login: LoginRecord): boolean {
  return (
    rowKey(row) === login.key &&
    (row.orgId === undefined ||
      login.orgId === undefined ||
      row.orgId === login.orgId)
  )
}

/** The version a row holds, comparable with a login's. */
export function versionOf(
  row: PoolAccount,
): Pick<LoginRecord, 'at' | 'refresh' | 'rev'> {
  return { ...loginVersion(row), refresh: row.refresh }
}

/**
 * Put the gist's login onto the row that holds the same login, in one pool
 * transaction that re-checks the row's (refresh, tokenGen) as 
ow was read:
 * a row that moved on in the meantime is left to the next cycle. The bumped
 * 	okenGen makes a refresh that is in flight lose its CAS. The row keeps its
 * inference token, usage, cooldowns, sessions and label. The caller holds the
 * row's refresh lock (the lock is not re-entrant).
 */
export function overwriteLocked(
  row: PoolAccount,
  login: LoginRecord,
): Promise<boolean> {
  const attempt = { refresh: row.refresh, gen: genOf(row) }
  return mutatePool((pool) => {
    const cur = findAccount(pool, row.id)
    if (!cur || !sameGeneration(cur, attempt)) return false
    cur.access = login.access
    cur.refresh = login.refresh
    cur.expires = login.expires
    if (login.refreshExpires) cur.refreshExpires = login.refreshExpires
    else delete cur.refreshExpires
    if (login.orgId) cur.orgId = login.orgId
    cur.loginRev = login.rev
    cur.loginAt = login.at
    cur.tokenGen = genOf(cur) + 1
    clearLostLogin(cur, 'oauth')
    if (cur.disabledReason?.startsWith(AUTO_DISABLED_PREFIX))
      cur.disabledReason = null
    return true
  })
}

/** overwriteLocked under the row's refresh lock, so it cannot interleave with a refresh POST. */
function overwrite(row: PoolAccount, login: LoginRecord): Promise<boolean> {
  return withRefreshLock(row.providerID, row.id, () =>
    overwriteLocked(row, login),
  )
}
/**
 * A login no row holds: land it the way a local login lands, so it pairs onto
 * a token-only row of the same organization, else becomes a row with a unique
 * label; then it takes the gist's version. A row the user disabled by hand
 * stays disabled.
 */
async function create(login: LoginRecord): Promise<boolean> {
  const tokens: TokenSet = {
    access: login.access,
    refresh: login.refresh,
    expires: login.expires,
    accountId: login.accountId,
    ...(login.orgId ? { orgId: login.orgId } : {}),
    ...(login.refreshExpires ? { refreshExpires: login.refreshExpires } : {}),
  }
  return mutatePool((pool) => {
    if (pool.accounts.some((row) => sameLogin(row, login))) return false
    const manual = new Set(
      pool.accounts
        .filter((row) => row.disabledReason === MANUAL_DISABLED_REASON)
        .map((row) => row.id),
    )
    const row = placeTokens(
      pool,
      login.providerID,
      tokens,
      uniqueLabel(pool, login.label),
      undefined,
    )
    row.loginRev = login.rev
    row.loginAt = login.at
    row.tokenGen = genOf(row) + 1
    if (manual.has(row.id)) row.disabledReason = MANUAL_DISABLED_REASON
    return true
  })
}

/** Take the gist's login if it beats this machine's copy (or this machine has none). */
async function adopt(login: LoginRecord): Promise<boolean> {
  const row = (await readPool()).accounts.find((a) => sameLogin(a, login))
  if (!row) return create(login)
  return compareLogins(login, versionOf(row)) > 0
    ? overwrite(row, login)
    : false
}

/**
 * A key the user deleted and then logged in to again: the fresh login must
 * outrank the gist's old copy, or the next import would put the old tokens
 * back over it.
 */
async function outrank(login: LoginRecord, now: number): Promise<void> {
  const row = (await readPool()).accounts.find((a) => sameLogin(a, login))
  if (!row || compareLogins(versionOf(row), login) > 0) return
  const attempt = { refresh: row.refresh, gen: genOf(row) }
  await mutatePool((pool) => {
    const cur = findAccount(pool, row.id)
    if (!cur || !sameGeneration(cur, attempt)) return
    cur.loginRev = login.rev + 1
    cur.loginAt = now
  })
}

/** What sync remembers about deleted rows, in and out of `applyLogins`. */
export interface LoginMarks {
  known: Readonly<Record<string, true>> | undefined
  suppressed: Readonly<Record<string, true>> | undefined
}

export interface LoginsApplied {
  /** Rows the gist's logins were put onto, or created. */
  adopted: number
  known: Record<string, true>
  suppressed: Record<string, true>
}

/**
 * Bring the pool's logins in line with the gist's. First the deletion guard: a
 * key that was held and has no row any more was deleted by the user, so it is
 * suppressed and never imported; a suppressed key with a row again was logged
 * in to again, so it is released (and outranks the gist's copy). Then every
 * gist login that wins over this machine's copy is put onto the pool. A login
 * that is not newer is ignored: this machine's copy is then the winner, and
 * is written back.
 */
export async function applyLogins(
  gist: readonly LoginRecord[],
  marks: LoginMarks,
  now: number,
): Promise<LoginsApplied> {
  const known = newMap(marks.known)
  const suppressed = newMap(marks.suppressed)
  const held = heldMarks((await readPool()).accounts)
  for (const key of Object.keys(known)) {
    if (held[key]) continue
    suppressed[key] = true
    delete known[key]
  }
  for (const key of Object.keys(suppressed)) {
    if (!held[key]) continue
    delete suppressed[key]
    const login = gist.find((l) => l.key === key)
    if (login) await outrank(login, now)
  }
  let adopted = 0
  for (const login of gist)
    if (!suppressed[login.key] && (await adopt(login))) adopted += 1
  return {
    adopted,
    known: heldMarks((await readPool()).accounts),
    suppressed,
  }
}
