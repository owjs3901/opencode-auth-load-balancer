import { randomUUID } from 'node:crypto'

import { mutatePool } from './pool/store'
import { emptyUsage, type PoolAccount, type TokenSet } from './types'

/** The credential getter opencode passes to an auth loader. */
export type OpencodeAuthGetter = () => Promise<{
  type: string
  access?: string
  refresh?: string
  expires?: number
}>

function makeAccount(
  providerID: string,
  label: string,
  tokens: TokenSet,
): PoolAccount {
  const now = Date.now()
  return {
    id: randomUUID(),
    providerID,
    label,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    tokenGen: 0,
    accountId: tokens.accountId ?? null,
    usage: emptyUsage(),
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: now,
    lastUsedAt: 0,
  }
}

/**
 * Append a freshly-authorized account to the pool, deduped by refresh token.
 * Re-authorizing the same account refreshes its tokens instead of duplicating it.
 */
export async function addAccount(
  providerID: string,
  tokens: TokenSet,
  label?: string,
): Promise<PoolAccount> {
  return mutatePool((pool) => {
    // Dedup intent: "same account re-authorized" → fold the new tokens onto
    // the existing pool row instead of creating a duplicate. The signal is a
    // matching refresh token (the only stable, per-account identifier OAuth
    // gives us up front). RFC 6749 §5.1 lets the server OMIT `refresh_token`
    // at exchange time, and BOTH adapters commit to writing `''` in that case
    // (anthropic/oauth.ts: `refresh: json.refresh_token || ''`; openai/oauth.ts:
    // `toTokenSet(json, '')`). An empty refresh is therefore the OPPOSITE of a
    // stable identifier — it means "we don't have one" — so it must NOT match.
    // Without this guard, the second empty-refresh exchange (e.g. two ChatGPT
    // logins where the server skipped issuing a refresh_token) silently
    // overwrites the first pool row, and the user loses one of the two
    // accounts they thought they just registered.
    const existing = tokens.refresh
      ? pool.accounts.find(
          (a) => a.providerID === providerID && a.refresh === tokens.refresh,
        )
      : undefined
    if (existing) {
      existing.access = tokens.access
      existing.refresh = tokens.refresh
      existing.expires = tokens.expires
      existing.disabledReason = null
      return existing
    }
    const used = new Set(
      pool.accounts
        .filter((a) => a.providerID === providerID)
        .map((a) => a.label),
    )
    let n = 1
    while (used.has(`${providerID}-${n}`)) n++
    const account = makeAccount(
      providerID,
      label ?? `${providerID}-${n}`,
      tokens,
    )
    pool.accounts.push(account)
    return account
  })
}

/**
 * Seed the pool from opencode's existing single-slot OAuth credential (e.g. left by
 * the single-account anthropic-auth plugin) so the user keeps working without
 * re-login. No-op once the pool already has an account for this provider.
 */
export async function bootstrapFromOpencodeAuth(
  providerID: string,
  getAuth: OpencodeAuthGetter,
): Promise<void> {
  const auth = await getAuth().catch(() => null)
  if (!auth || auth.type !== 'oauth' || !auth.access || !auth.refresh) return
  const { access, refresh, expires } = auth
  await mutatePool((pool) => {
    if (pool.accounts.some((a) => a.providerID === providerID)) return
    pool.accounts.push(
      makeAccount(providerID, `${providerID}-1`, {
        access,
        refresh,
        expires: expires ?? 0,
      }),
    )
  })
}
