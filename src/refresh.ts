import { findAccount, mutatePool } from './pool/store'
import type { ProviderAdapter } from './providers/types'
import type { PoolAccount, TokenSet } from './types'

/** Refresh this many ms before the access token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000

/**
 * Per-account in-flight refresh promises (singleflight).
 *
 * Anthropic and OpenAI rotate the refresh token on every refresh (single-use).
 * If two concurrent requests both refresh the same account, the second uses a
 * now-invalid refresh token and can permanently brick the account. Collapsing
 * concurrent refreshes to one in-flight promise per account prevents that.
 *
 * The promise resolves to the full TokenSet (not just the access string) so a
 * concurrent caller that reuses an in-flight promise can also mutate its OWN
 * local PoolAccount — production fan-out via readPool() gives each parallel
 * request a DIFFERENT PoolAccount object with the same id, so updating only
 * the creator's local object would leave reusers sending the OLD token.
 */
const inflight = new Map<string, Promise<TokenSet>>()

export function needsRefresh(account: PoolAccount, now: number): boolean {
  return !account.access || account.expires - REFRESH_SKEW_MS <= now
}

function isInvalidGrant(error: unknown): boolean {
  return (
    error instanceof Error &&
    /invalid_grant|\b400\b|\b401\b/.test(error.message)
  )
}

/** Copy a rotated TokenSet onto the caller's PoolAccount in place. */
function applyTokensTo(account: PoolAccount, tokens: TokenSet): void {
  account.access = tokens.access
  account.refresh = tokens.refresh
  account.expires = tokens.expires
  if (tokens.accountId) account.accountId = tokens.accountId
}

/**
 * Ensure the account has a fresh access token, refreshing if needed. The rotated
 * refresh token is persisted immediately. On invalid_grant the account is marked
 * disabled (needs manual re-login) and the error is rethrown.
 *
 * Mutates the passed `account` in place so the caller sees the new token.
 * Concurrent callers that reuse an in-flight refresh have their OWN local
 * account objects mutated too — see the comment on `inflight` above.
 */
export async function ensureAccessToken(
  adapter: ProviderAdapter,
  account: PoolAccount,
  now: number,
): Promise<string> {
  if (!needsRefresh(account, now)) return account.access

  const existing = inflight.get(account.id)
  if (existing) {
    const tokens = await existing
    applyTokensTo(account, tokens)
    return tokens.access
  }

  const job = (async (): Promise<TokenSet> => {
    try {
      const tokens = await adapter.refresh(account.refresh)
      await mutatePool((pool) => {
        const stored = findAccount(pool, account.id)
        if (!stored) return
        stored.access = tokens.access
        stored.refresh = tokens.refresh
        stored.expires = tokens.expires
        if (tokens.accountId) stored.accountId = tokens.accountId
        stored.disabledReason = null
      })
      applyTokensTo(account, tokens)
      return tokens
    } catch (error) {
      if (isInvalidGrant(error)) {
        const reason = `invalid_grant: re-login required (${adapter.id}:${account.label})`
        account.disabledReason = reason
        await mutatePool((pool) => {
          const stored = findAccount(pool, account.id)
          if (stored) stored.disabledReason = reason
        })
      }
      throw error
    } finally {
      inflight.delete(account.id)
    }
  })()

  inflight.set(account.id, job)
  const tokens = await job
  return tokens.access
}
