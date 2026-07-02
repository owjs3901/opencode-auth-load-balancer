import { randomUUID } from 'node:crypto'

import { mutatePool, readPool } from './pool/store'
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
      // No refresh write: it is the match key above, so it is already equal.
      existing.access = tokens.access
      existing.expires = tokens.expires
      existing.disabledReason = null
      // A re-login may decode a fresh accountId from the id_token (OpenAI);
      // propagate it so a row bootstrapped with `accountId: null` stops
      // falling back to the per-request JWT decode. Never clear an existing id.
      if (tokens.accountId) existing.accountId = tokens.accountId
      return existing
    }
    // Pool-WIDE label set (not per-provider): `auth_lb_rename` enforces
    // pool-wide label uniqueness (rename-by-label picks the first match), and
    // renames can move a `${providerID}-${n}` style label across providers —
    // e.g. an OpenAI account renamed to `anthropic-1`. A per-provider set then
    // let the next Anthropic login mint a duplicate `anthropic-1`, creating
    // exactly the ambiguity the rename tool refuses to create. The generated
    // names are provider-prefixed, so same-provider numbering is unchanged.
    const used = new Set(pool.accounts.map((a) => a.label))
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
  // Fast path: in the steady state (every startup after the first) the provider
  // already has an account, so skip the full lock + atomic rewrite mutatePool
  // pays even for a no-op. The inner guard below is RETAINED — it runs under
  // the lock and is what prevents two concurrent bootstraps from double-adding.
  if ((await readPool()).accounts.some((a) => a.providerID === providerID))
    return
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
