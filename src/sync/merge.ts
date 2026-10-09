import type { PoolAccount } from '../types'
import { fingerprint } from './crypto'
import type { ParsedPayload, SyncEntry } from './payload'
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

/** The reference recorded for `id`, from its own entries only (an id such as `constructor` finds nothing inherited). */
function refOf(
  imported: Readonly<Record<string, ImportedRef>>,
  id: string,
): ImportedRef | undefined {
  return Object.hasOwn(imported, id) ? imported[id] : undefined
}

/**
 * What to do with the gist's entries, given what was imported before. Pure:
 * - a new entry is imported, unless a local row already holds its secret
 *   (that row is the user's own and sync never tracks, so never removes, it);
 * - an entry whose secret changed is imported again, onto the row it was in
 *   — unless a local row already holds the new secret, which stays the user's
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
  imported: Readonly<Record<string, ImportedRef>>,
): MergePlan {
  const imports: ImportJob[] = []
  const drops: [string, ImportedRef][] = []
  for (const entry of snapshot.entries) {
    const previous = refOf(imported, entry.id)
    const digest = fingerprint(entry.secret)
    if (previous?.fingerprint === digest) continue
    const heldLocally = accounts.some(
      (a) => a.providerID === entry.providerID && holdsFingerprint(a, digest),
    )
    if (previous && heldLocally) drops.push([entry.id, previous])
    else if (!heldLocally)
      imports.push({ entry, ...(previous ? { previous } : {}) })
  }
  for (const [id, ref] of Object.entries(imported))
    if (!snapshot.listed.has(id)) drops.push([id, ref])
  return { imports, drops }
}
