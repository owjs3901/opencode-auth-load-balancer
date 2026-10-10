/**
 * What this machine lists in the gist. A row's static credential is the
 * machine's own unless sync put it there: a row that still holds a credential
 * recorded in the imported map is imported, never uploaded, so a token travels
 * from the machine that has it and never back.
 */
import {
  type PoolAccount,
  type PoolFile,
  STATIC_CREDENTIAL_EXPIRES,
} from '../types'
import { fingerprint } from './crypto'
import { holdsFingerprint } from './merge'
import {
  MAX_ENTRIES,
  MAX_LABEL,
  parseEntry,
  printable,
  SECRET_SHAPES,
  sortEntries,
  type SyncEntry,
} from './payload'
import type { ImportedRef } from './state'

/**
 * The static credential of a row: a Claude `inferenceToken`, or a Kimi API
 * key. A Kimi row only counts when it carries the static-credential expiry as
 * well as no refresh token: an OAuth sign-in can also leave a refresh-less row,
 * with a short-lived access token that must never leave the machine.
 */
export function staticSecret(row: PoolAccount): string | undefined {
  if (row.providerID === 'anthropic') return row.inferenceToken
  return !row.refresh && row.expires === STATIC_CREDENTIAL_EXPIRES
    ? row.access
    : undefined
}

/** Ids of the rows that currently hold a credential sync imported. */
function importedRows(
  accounts: readonly PoolAccount[],
  imported: Readonly<Record<string, ImportedRef>>,
): Set<string> {
  const ids = new Set<string>()
  for (const ref of Object.values(imported)) {
    const row = accounts.find((a) => a.id === ref.accountId)
    if (row && holdsFingerprint(row, ref.fingerprint)) ids.add(row.id)
  }
  return ids
}

/**
 * This machine's own static credentials, sorted by row id so equal pools
 * produce equal payloads. Every entry goes through the receiver's own
 * validation (a label too long is trimmed, a row whose id or secret a receiver
 * would refuse is left out): this machine never produces a snapshot others
 * would reject.
 */
export function ownEntries(
  pool: PoolFile,
  origin: string,
  imported: Readonly<Record<string, ImportedRef>>,
): SyncEntry[] {
  const fromSync = importedRows(pool.accounts, imported)
  const entries: SyncEntry[] = []
  for (const row of pool.accounts) {
    if (!SECRET_SHAPES.has(row.providerID) || fromSync.has(row.id)) continue
    if (row.disabledReason || row.lostLogins?.token) continue
    const entry = parseEntry({
      origin,
      id: row.id,
      providerID: row.providerID,
      label: printable(row.label).slice(0, MAX_LABEL).trim() || row.providerID,
      secret: staticSecret(row),
      expiresAt: row.inferenceExpires,
    })
    if (entry) entries.push(entry)
  }
  return sortEntries(entries).slice(0, MAX_ENTRIES)
}

/**
 * What of `own` to list next to `others` (the entries of every other machine,
 * carried over untouched): not a secret a machine with a smaller origin already
 * lists (one copy is enough, and two machines never both give theirs up
 * because the smaller origin keeps it), and no more than the gist can hold.
 */
export function listable(
  own: readonly SyncEntry[],
  others: readonly SyncEntry[],
  origin: string,
): SyncEntry[] {
  const taken = new Set(
    others.filter((e) => e.origin < origin).map((e) => fingerprint(e.secret)),
  )
  return own
    .filter((e) => !taken.has(fingerprint(e.secret)))
    .slice(0, Math.max(0, MAX_ENTRIES - others.length))
}
