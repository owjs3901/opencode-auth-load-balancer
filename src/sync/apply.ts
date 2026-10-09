import { placeTokens } from '../accounts'
import { holdsCredential, tokenSharer } from '../pairing'
import { findAccount, mutatePool, readPool } from '../pool/store'
import { adapterFor, ADAPTERS } from '../providers/registry'
import type { ProviderAdapter } from '../providers/types'
import type { PoolAccount, PoolFile, TokenSet } from '../types'
import { fingerprint } from './crypto'
import {
  holdsFingerprint,
  type ImportJob,
  type MergeMemory,
  type MergePlan,
  planMerge,
  staticFingerprint,
} from './merge'
import { entryKey, type ParsedPayload } from './payload'
import { type ImportedRef, newMap, newRefs, type SkippedRef } from './state'

export interface ApplyResult {
  /** The imported map after this plan. */
  imported: Record<string, ImportedRef>
  /** The skipped map after this plan. */
  skipped: Record<string, SkippedRef>
  added: number
  updated: number
  removed: number
  /** Entries that could not be landed yet (the provider could not be reached, or refused the secret). */
  deferred: number
}

/** What became of one import: the row it landed on, or left alone because the account already has a credential. */
export type Landing =
  | { kind: 'placed'; row: PoolAccount }
  | { kind: 'skipped'; blocker: string; holds: string }

/** The secret verified the way a pasted one is: Claude's setup-token probe, Kimi's key check. */
async function exchangeSecret(
  adapter: ProviderAdapter,
  secret: string,
): Promise<TokenSet | null> {
  try {
    if (adapter.tokenLogin) return await adapter.tokenLogin.exchange(secret)
    if (adapter.tokensFromApiKey)
      return await adapter.exchange(secret, '', '', '')
  } catch {
    return null
  }
  return null
}

function dropRow(pool: PoolFile, id: string): void {
  pool.accounts = pool.accounts.filter((a) => a.id !== id)
  for (const [provider, selected] of Object.entries(pool.lastSelected))
    if (selected === id) delete pool.lastSelected[provider]
  for (const [key, session] of Object.entries(pool.sessions))
    if (session.accountId === id) delete pool.sessions[key]
}

/** Take an imported credential out of `row`: a row with an OAuth login of its own keeps that and loses only the token; a credential-only row goes. */
function release(pool: PoolFile, row: PoolAccount): void {
  if (row.refresh) {
    delete row.inferenceToken
    delete row.inferenceExpires
  } else dropRow(pool, row.id)
}

/** `label`, or `label (n)` when another row already carries it (labels are unique pool-wide). */
function uniqueLabel(pool: PoolFile, label: string): string {
  const used = new Set(pool.accounts.map((a) => a.label))
  let candidate = label
  for (let n = 2; used.has(candidate); n++) candidate = `${label} (${n})`
  return candidate
}

/**
 * Take an imported credential back out of its row, if the row still holds it.
 * A row the user pointed at something else stays.
 */
async function strip(ref: ImportedRef): Promise<boolean> {
  return mutatePool((pool) => {
    const row = findAccount(pool, ref.accountId)
    if (!row || !holdsFingerprint(row, ref.fingerprint)) return false
    release(pool, row)
    return true
  })
}

/**
 * Land one verified credential, deciding everything from the pool as it is
 * under the lock (callers run this inside `mutatePool`):
 * - a row of this provider that already holds the secret (or, for a key, the
 *   same account) is the user's own, whatever the plan saw earlier;
 * - for a Claude token, a row that already serves the same account with a
 *   working token of its own, minted here, pasted, or imported from another
 *   entry, is never replaced: two machines that each hold a token for one
 *   account would otherwise trade them for ever. The entry is skipped;
 * - in both cases the old imported secret (if the entry is a rotation) is
 *   taken back, and the row in the way is reported, so the entry is not
 *   probed again until that row changes;
 * - an earlier import still held by its row is replaced in place, but only by
 *   a credential of the same provider; if the entry changed provider the old
 *   one is taken back and the new one placed on its own;
 * - anything else is placed by the shared pairing (`placeTokens`), with the
 *   provider-confirmed identity of the probe only.
 */
export function land(
  pool: PoolFile,
  { entry, previous }: ImportJob,
  tokens: TokenSet,
): Landing {
  const digest = fingerprint(entry.secret)
  const sameProvider = (a: PoolAccount): boolean =>
    a.providerID === entry.providerID
  const owned = previous
    ? pool.accounts.find(
        (a) =>
          a.id === previous.accountId &&
          holdsFingerprint(a, previous.fingerprint),
      )
    : undefined
  const prev = owned && sameProvider(owned) ? owned : undefined
  if (owned && !prev) release(pool, owned)
  const blocker =
    pool.accounts.find(
      (a) =>
        a !== prev &&
        sameProvider(a) &&
        (holdsFingerprint(a, digest) ||
          (!tokens.inferenceOnly && holdsCredential(a, tokens))),
    ) ??
    (tokens.inferenceOnly && !prev
      ? tokenSharer(pool.accounts.filter(sameProvider), tokens)
      : undefined)
  if (blocker) {
    if (prev) release(pool, prev)
    return {
      kind: 'skipped',
      blocker: blocker.id,
      holds: staticFingerprint(blocker),
    }
  }
  return {
    kind: 'placed',
    row: placeTokens(
      pool,
      entry.providerID,
      tokens,
      uniqueLabel(pool, entry.label),
      prev?.id,
    ),
  }
}

/**
 * Carry out a merge plan. Each entry is landed independently: one failing
 * (a probe that cannot be reached, a pool write that throws) is deferred and
 * never blocks the rest, and what was already landed stays recorded.
 */
export async function applyPlan(
  plan: MergePlan,
  memory: Pick<MergeMemory, 'imported' | 'skipped'>,
  adapters: readonly ProviderAdapter[] = ADAPTERS,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    imported: newRefs(memory.imported),
    skipped: newMap(memory.skipped),
    added: 0,
    updated: 0,
    removed: 0,
    deferred: 0,
  }
  for (const key of plan.forgets) delete result.skipped[key]
  for (const job of plan.imports) {
    const { entry, previous } = job
    const key = entryKey(entry)
    try {
      const adapter = adapterFor(adapters, entry.providerID)
      const tokens = adapter && (await exchangeSecret(adapter, entry.secret))
      if (!tokens) {
        result.deferred += 1
        continue
      }
      if (tokens.inferenceOnly && entry.expiresAt)
        tokens.inferenceExpires = entry.expiresAt
      const landing = await mutatePool((pool) => land(pool, job, tokens))
      if (landing.kind === 'skipped') {
        delete result.imported[key]
        result.skipped[key] = {
          fingerprint: fingerprint(entry.secret),
          blocker: landing.blocker,
          holds: landing.holds,
        }
      } else {
        delete result.skipped[key]
        result.imported[key] = {
          accountId: landing.row.id,
          fingerprint: fingerprint(entry.secret),
        }
        if (previous) result.updated += 1
        else result.added += 1
      }
    } catch {
      result.deferred += 1
    }
  }
  for (const [key, ref] of plan.drops) {
    try {
      if (await strip(ref)) result.removed += 1
      delete result.imported[key]
    } catch {
      result.deferred += 1
    }
  }
  return result
}

/** Passes of plan-and-apply per snapshot: a removal can free an account for an entry that was skipped behind it. */
const MAX_PASSES = 3

/**
 * Bring the pool in line with `snapshot`. After a pass that removed something
 * the plan is made again, so an entry that was kept out by the credential just
 * removed is imported in the same cycle instead of the next one.
 */
export async function applySnapshot(
  snapshot: Pick<ParsedPayload, 'entries' | 'listed'>,
  memory: MergeMemory,
  adapters: readonly ProviderAdapter[] = ADAPTERS,
): Promise<ApplyResult> {
  const total: ApplyResult = {
    imported: newRefs(memory.imported),
    skipped: newMap(memory.skipped),
    added: 0,
    updated: 0,
    removed: 0,
    deferred: 0,
  }
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const plan = planMerge((await readPool()).accounts, snapshot, {
      origin: memory.origin,
      imported: total.imported,
      skipped: total.skipped,
    })
    const done = await applyPlan(plan, total, adapters)
    total.imported = done.imported
    total.skipped = done.skipped
    total.added += done.added
    total.updated += done.updated
    total.removed += done.removed
    total.deferred = done.deferred
    if (done.removed === 0) break
  }
  return total
}
