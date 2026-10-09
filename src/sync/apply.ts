import { importStaticToken } from '../accounts'
import { findAccount, mutatePool, readPool } from '../pool/store'
import { adapterFor, ADAPTERS } from '../providers/registry'
import type { ProviderAdapter } from '../providers/types'
import type { PoolFile, TokenSet } from '../types'
import { fingerprint } from './crypto'
import { holdsFingerprint, type MergePlan } from './merge'
import type { ImportedRef } from './state'

export interface ApplyResult {
  /** The imported map after this plan. */
  imported: Record<string, ImportedRef>
  added: number
  updated: number
  removed: number
  /** Entries that could not be landed yet (the provider could not be reached, or refused the secret). */
  deferred: number
}

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

/**
 * Take an imported credential back out of its row, if the row still holds it:
 * a row with an OAuth login of its own keeps that and loses only the token;
 * a credential-only row goes. A row the user pointed at something else stays.
 */
async function strip(ref: ImportedRef): Promise<boolean> {
  return mutatePool((pool) => {
    const row = findAccount(pool, ref.accountId)
    if (!row || !holdsFingerprint(row, ref.fingerprint)) return false
    if (row.refresh) {
      delete row.inferenceToken
      delete row.inferenceExpires
    } else dropRow(pool, row.id)
    return true
  })
}

/** Carry out a merge plan. Each entry is landed independently: one failing never blocks the rest. */
export async function applyPlan(
  plan: MergePlan,
  imported: Readonly<Record<string, ImportedRef>>,
  adapters: readonly ProviderAdapter[] = ADAPTERS,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    imported: { ...imported },
    added: 0,
    updated: 0,
    removed: 0,
    deferred: 0,
  }
  for (const { entry, previous } of plan.imports) {
    const adapter = adapterFor(adapters, entry.providerID)
    const tokens = adapter && (await exchangeSecret(adapter, entry.secret))
    if (!tokens) {
      result.deferred += 1
      continue
    }
    if (tokens.inferenceOnly && entry.expiresAt)
      tokens.inferenceExpires = entry.expiresAt
    if (entry.orgId && !tokens.orgId) tokens.orgId = entry.orgId
    const before = previous && findAccount(await readPool(), previous.accountId)
    const targetId =
      previous && before && holdsFingerprint(before, previous.fingerprint)
        ? previous.accountId
        : undefined
    const row = await importStaticToken(entry.providerID, tokens, {
      label: entry.label,
      ...(targetId ? { targetId } : {}),
    })
    if (previous && previous.accountId !== row.id) await strip(previous)
    result.imported[entry.id] = {
      accountId: row.id,
      fingerprint: fingerprint(entry.secret),
    }
    if (previous) result.updated += 1
    else result.added += 1
  }
  for (const [id, ref] of plan.drops) {
    if (await strip(ref)) result.removed += 1
    delete result.imported[id]
  }
  return result
}
