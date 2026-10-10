import type { PoolAccount } from '../types'
import { fingerprint } from './crypto'
import { entryKey, type ParsedPayload, type SyncEntry } from './payload'
import type { ImportedRef, SkippedRef } from './state'

/** An entry to land locally; `previous` is the row an earlier value of it was imported into. */
export interface ImportJob {
  entry: SyncEntry
  previous?: ImportedRef
}

/** What sync remembers about earlier cycles, and which machine this is. */
export interface MergeMemory {
  origin: string
  imported: Readonly<Record<string, ImportedRef>>
  skipped: Readonly<Record<string, SkippedRef>>
}

export interface MergePlan {
  imports: ImportJob[]
  /** Imported entries the gist no longer lists: entry key and where it landed. */
  drops: [string, ImportedRef][]
  /** Skip records of entries the gist no longer lists. */
  forgets: string[]
}

/** Whether `row` carries the credential with this fingerprint as its static one. */
export function holdsFingerprint(row: PoolAccount, digest: string): boolean {
  return (
    (row.inferenceToken !== undefined &&
      fingerprint(row.inferenceToken) === digest) ||
    (!row.refresh && fingerprint(row.access) === digest)
  )
}

/** The digest of the static credential a row carries, or '' when it has none. */
export function staticFingerprint(row: PoolAccount): string {
  if (row.inferenceToken !== undefined) return fingerprint(row.inferenceToken)
  return row.refresh ? '' : fingerprint(row.access)
}

/** The value recorded for `key`, from the map's own entries only (a key such as `constructor` finds nothing inherited). */
function recorded<T>(
  map: Readonly<Record<string, T>>,
  key: string,
): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/** Whether the row that kept an entry out is still in the way. */
export function blockerStands(
  accounts: readonly PoolAccount[],
  skip: SkippedRef,
): boolean {
  const row = accounts.find((a) => a.id === skip.blocker)
  return !!row && (skip.holds === '' || holdsFingerprint(row, skip.holds))
}

/**
 * Whether a skipped entry should be looked at again because the row that kept
 * it out is gone, or no longer holds what it held.
 */
export function hasFreedSkips(
  accounts: readonly PoolAccount[],
  skipped: Readonly<Record<string, SkippedRef>>,
): boolean {
  return Object.values(skipped).some((skip) => !blockerStands(accounts, skip))
}

/**
 * What to do with the gist's entries, given what was imported before. Pure:
 * - this machine's own entries (its origin) are never imported back;
 * - a new entry is imported, unless a local row already holds its secret
 *   (that row is the user's own and sync never tracks, so never removes, it);
 * - an entry that was skipped because the account already had a credential is
 *   not probed again while that credential is still in the way;
 * - an entry whose secret changed is imported again, onto the row it was in,
 *   unless a local row already holds the new secret, which stays the user's
 *   own: the old imported secret is taken back and the entry is forgotten;
 * - an entry whose secret is unchanged is left alone, so a row the user
 *   deleted or re-pointed stays that way until the gist changes it;
 * - an imported entry the gist no longer lists is dropped. An entry that is
 *   listed but failed validation is NOT "no longer listed": it is left as is.
 * Rows that were never imported are not reachable from a plan.
 */
export function planMerge(
  accounts: readonly PoolAccount[],
  snapshot: Pick<ParsedPayload, 'entries' | 'listed'>,
  memory: MergeMemory,
): MergePlan {
  const { origin, imported, skipped } = memory
  const imports: ImportJob[] = []
  const drops: [string, ImportedRef][] = []
  for (const entry of snapshot.entries) {
    if (entry.origin === origin) continue
    const key = entryKey(entry)
    const previous = recorded(imported, key)
    const skip = recorded(skipped, key)
    const digest = fingerprint(entry.secret)
    if (previous?.fingerprint === digest) continue
    if (skip?.fingerprint === digest && blockerStands(accounts, skip)) continue
    const heldLocally = accounts.some(
      (a) => a.providerID === entry.providerID && holdsFingerprint(a, digest),
    )
    if (previous && heldLocally) drops.push([key, previous])
    else if (!heldLocally)
      imports.push({ entry, ...(previous ? { previous } : {}) })
  }
  for (const [key, ref] of Object.entries(imported))
    if (!snapshot.listed.has(key)) drops.push([key, ref])
  const forgets = Object.keys(skipped).filter(
    (key) => !snapshot.listed.has(key),
  )
  return { imports, drops, forgets }
}
