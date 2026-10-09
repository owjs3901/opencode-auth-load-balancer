import { randomUUID } from 'node:crypto'

import { holdsCredential, orgPartner } from './pairing'
import { findAccount, mutatePool, readPool } from './pool/store'
import {
  emptyUsage,
  type LostLogins,
  type PoolAccount,
  type TokenSet,
  type UsageSnapshot,
} from './types'
import { preserveWeeklyAnchor } from './usage-merge'

/** A credential from opencode's auth store (`oauth` token pair or `api` key). */
interface OpencodeAuth {
  type: string
  access?: string
  refresh?: string
  expires?: number
  key?: string
}

/** The credential getter opencode passes to an auth loader. */
export type OpencodeAuthGetter = () => Promise<OpencodeAuth>

/** A pool row for `tokens` (also the throwaway row a login is measured through). */
export function makeAccount(
  providerID: string,
  label: string,
  tokens: TokenSet,
): PoolAccount {
  const account: PoolAccount = {
    id: randomUUID(),
    providerID,
    label,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    tokenGen: 0,
    accountId: tokens.accountId ?? null,
    usage: tokens.usage ?? emptyUsage(),
    cooldownUntil: 0,
    disabledReason: null,
  }
  if (tokens.inferenceOnly) account.inferenceToken = tokens.access
  if (tokens.orgId) account.orgId = tokens.orgId
  if (tokens.refreshExpires) account.refreshExpires = tokens.refreshExpires
  return account
}

export function recordLostLogin(
  row: PoolAccount,
  login: keyof LostLogins,
  reason: string,
): void {
  row.lostLogins = { ...row.lostLogins, [login]: { at: Date.now(), reason } }
}

export function clearLostLogin(
  row: PoolAccount,
  login: keyof LostLogins,
): void {
  if (!row.lostLogins?.[login]) return
  delete row.lostLogins[login]
  if (!row.lostLogins.oauth && !row.lostLogins.token) delete row.lostLogins
}

/** Fold the usage a login measured into the row it landed on (same account). */
function mergeLoginUsage(
  row: PoolAccount,
  usage: UsageSnapshot | undefined,
): void {
  if (!usage) return
  row.usage = {
    hourly: usage.hourly ?? row.usage.hourly,
    weekly: usage.weekly
      ? preserveWeeklyAnchor(usage.weekly, row.usage.weekly, usage.capturedAt)
      : row.usage.weekly,
    capturedAt: usage.weekly ? usage.capturedAt : row.usage.capturedAt,
  }
}

function applyTokens(row: PoolAccount, tokens: TokenSet): PoolAccount {
  // Persist the newer refresh token when matched via accountId (a no-op when
  // matched by refresh — they are already equal); never clear it.
  if (tokens.refresh) row.refresh = tokens.refresh
  row.access = tokens.access
  row.expires = tokens.expires
  row.disabledReason = null
  // A re-login may decode a fresh accountId from the id_token (OpenAI);
  // propagate it so a row bootstrapped with `accountId: null` stops falling
  // back to the per-request JWT decode. Never clear an existing id.
  if (tokens.accountId) row.accountId = tokens.accountId
  if (tokens.orgId) row.orgId = tokens.orgId
  if (tokens.refreshExpires) row.refreshExpires = tokens.refreshExpires
  clearLostLogin(row, 'oauth')
  mergeLoginUsage(row, tokens.usage)
  return row
}

/**
 * Land a setup-token on a row as its inference credential, leaving the row's
 * OAuth login in place to poll usage. A row without one stays a static row,
 * whose `access` mirrors the token. A pasted token's lifetime is unknown, so
 * it inherits no renewal date from a minted token it replaces.
 */
function attachToken(row: PoolAccount, tokens: TokenSet): PoolAccount {
  row.inferenceToken = tokens.access
  delete row.inferenceExpires
  if (!row.refresh) {
    row.access = tokens.access
    row.expires = tokens.expires
  }
  if (tokens.orgId) row.orgId = tokens.orgId
  row.disabledReason = null
  clearLostLogin(row, 'token')
  mergeLoginUsage(row, tokens.usage)
  return row
}

/**
 * Forget a setup-token the API rejected, leaving its row on the OAuth login —
 * but only while the row still holds that token, so one pasted mid-request
 * survives — and record why for the dashboards.
 */
export async function dropInferenceToken(
  accountId: string,
  token: string,
  reason: string,
): Promise<void> {
  await mutatePool((pool) => {
    const row = findAccount(pool, accountId)
    if (row?.inferenceToken !== token) return
    delete row.inferenceToken
    delete row.inferenceExpires
    recordLostLogin(row, 'token', reason)
  })
}

/**
 * Append a freshly-authorized account to the pool, deduped by refresh token
 * or provider account id. Re-authorizing the same account refreshes its
 * tokens instead of duplicating it. A setup-token and an OAuth login of one
 * account share a row in either order: the TUI hint or the organization
 * pairs them, each keeping its own role.
 */
export async function addAccount(
  providerID: string,
  tokens: TokenSet,
  label?: string,
): Promise<PoolAccount> {
  return mutatePool((pool) => {
    const intent =
      pool.relogin?.providerID === providerID ? pool.relogin : undefined
    // A completed provider login spends its matching hint regardless of which
    // branch below claims the tokens. Consuming it up front guarantees a stale
    // hint can never redirect a later, unrelated login onto this row.
    if (intent) delete pool.relogin

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
    // Second key: the provider's stable account id (OpenAI decodes the
    // ChatGPT account id from the id_token at exchange time). Refresh tokens
    // are single-use and ROTATE on every refresh, so a re-login of an account
    // that has been in use carries a DIFFERENT refresh token and the
    // refresh-key match misses — pre-fix that appended a duplicate row whose
    // one server-side quota the scheduler then double-counted. The
    // `tokens.accountId &&` guard keeps null/undefined ids from ever matching.
    // A setup-token re-pasted is recognized by the token itself.
    const rows = pool.accounts.filter((a) => a.providerID === providerID)
    // Explicit token/account identity always outranks the TUI hint. If the user
    // signs into a different account than the clicked row, a stable identity
    // match can never graft those credentials onto the hinted row. The hint in
    // turn outranks organization pairing, the one guess in this chain.
    const target =
      rows.find((a) => holdsCredential(a, tokens)) ??
      (intent && pool.accounts.find((a) => a.id === intent.accountId)) ??
      orgPartner(rows, tokens)
    if (target)
      return tokens.inferenceOnly
        ? attachToken(target, tokens)
        : applyTokens(target, tokens)
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
 * The pool tokens an opencode credential can seed, or null. An `oauth` pair
 * seeds any provider; an `api` key only one that takes keys (passing
 * `tokensFromApiKey`) — sent to an OAuth-only provider as its bearer, a key
 * would only ever 401.
 */
function importableTokens(
  auth: OpencodeAuth,
  tokensFromApiKey?: (key: string) => TokenSet,
): TokenSet | null {
  if (auth.type === 'api')
    return tokensFromApiKey && auth.key ? tokensFromApiKey(auth.key) : null
  if (auth.type !== 'oauth' || !auth.access || !auth.refresh) return null
  return {
    access: auth.access,
    refresh: auth.refresh,
    expires: auth.expires ?? 0,
  }
}

/**
 * Seed the pool from opencode's existing single-slot credential (e.g. an OAuth
 * login left by the single-account anthropic-auth plugin, or a Kimi Code API
 * key saved before this plugin was installed) so the user keeps working
 * without re-login. No-op once the pool already has an account for this
 * provider.
 */
export async function bootstrapFromOpencodeAuth(
  providerID: string,
  getAuth: OpencodeAuthGetter,
  tokensFromApiKey?: (key: string) => TokenSet,
): Promise<void> {
  const auth = await getAuth().catch(() => null)
  const tokens = auth && importableTokens(auth, tokensFromApiKey)
  if (!tokens) return
  // Fast path: in the steady state (every startup after the first) the provider
  // already has an account, so skip the full lock + atomic rewrite mutatePool
  // pays even for a no-op. The inner guard below is RETAINED — it runs under
  // the lock and is what prevents two concurrent bootstraps from double-adding.
  if ((await readPool()).accounts.some((a) => a.providerID === providerID))
    return
  await mutatePool((pool) => {
    if (pool.accounts.some((a) => a.providerID === providerID)) return
    pool.accounts.push(makeAccount(providerID, `${providerID}-1`, tokens))
  })
}
