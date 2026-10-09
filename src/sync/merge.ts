import type { PoolAccount } from '../types'
import { fingerprint } from './crypto'
import type { SyncEntry } from './payload'
import type { ImportedRef } from './state'

/** An entry to land locally; `previous` is the row an earlier value of it was imported into. */
export interface ImportJob {
  entry: SyncEntry
  previous?: ImportedRef
}

export interface MergePlan {
  imports: ImportJob[]
  /** Imported entries the gist no longer lists: entry id and where it landed. */
  drops: [string, ImportedRef][]
}

/** Whether `row` carries the credential with this fingerprint as its static one. */
export function holdsFingerprint(row: PoolAccount, digest: string): boolean {
  return (
    (row.inferenceToken !== undefined &&
      fingerprint(row.inferenceToken) === digest) ||
    (!row.refresh && fingerprint(row.access) === digest)
  )
}

/**
 * What to do with the gist's entries, given what was imported before. Pure:
 * - a new entry is imported, unless a local row already holds its secret
 *   (that row is the user's own and sync never tracks, so never removes, it);
 * - an entry whose secret changed is imported again, onto the row it was in;
 * - an entry whose secret is unchanged is left alone, so a row the user
 *   deleted or re-pointed stays that way until the gist changes it;
 * - an imported entry missing from the gist is dropped.
 * Rows that were never imported are not reachable from a plan.
 */
export function planMerge(
  accounts: readonly PoolAccount[],
  entries: readonly SyncEntry[],
  imported: Readonly<Record<string, ImportedRef>>,
): MergePlan {
  const imports: ImportJob[] = []
  for (const entry of entries) {
    const previous = imported[entry.id]
    const digest = fingerprint(entry.secret)
    if (previous) {
      if (previous.fingerprint !== digest) imports.push({ entry, previous })
    } else if (
      !accounts.some(
        (a) => a.providerID === entry.providerID && holdsFingerprint(a, digest),
      )
    )
      imports.push({ entry })
  }
  const listed = new Set(entries.map((e) => e.id))
  const drops = Object.entries(imported).filter(([id]) => !listed.has(id))
  return { imports, drops }
}
