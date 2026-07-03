import type { PoolAccount } from '../../types'
import { memoOne } from '../../util'

/**
 * Decode a JWT payload WITHOUT signature verification. We only read first-party
 * claims (account id) from a token the OAuth server just issued to us, so there
 * is nothing to verify against — we never trust it for authorization.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  // We read only the payload segment (`parts[1]`); the header and signature are
  // intentionally ignored (see doc above — no signature verification). The guard
  // is deliberately lenient (`!parts[1]` covers both "too few segments" and an
  // empty payload segment — NOT `=== 3`) so a token shape with extra segments
  // still decodes; the `try/catch` below rejects anything non-JSON.
  if (!parts[1]) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Extract the ChatGPT account id from an id_token, checking all known claim paths. */
export function extractAccountId(idToken: string): string | undefined {
  const claims = decodeJwtPayload(idToken)
  if (!claims) return undefined

  const ns = claims['https://api.openai.com/auth']
  if (ns && typeof ns === 'object') {
    const value = (ns as Record<string, unknown>).chatgpt_account_id
    if (typeof value === 'string') return value
  }

  if (typeof claims.chatgpt_account_id === 'string')
    return claims.chatgpt_account_id

  const orgs = claims.organizations
  if (
    Array.isArray(orgs) &&
    orgs[0] &&
    typeof (orgs[0] as { id?: unknown }).id === 'string'
  ) {
    return (orgs[0] as { id: string }).id
  }

  return undefined
}

/**
 * One-slot memo keyed by the raw access token (same pattern as
 * `computeMergedBetas` / `computeBaseUrl` in `anthropic/transform.ts`): for a
 * pool row bootstrapped with `accountId: null`, `resolveAccountId` runs per
 * attempt of every Codex request (via `applyAuth`) yet the decode is fully
 * determined by the `access` string, which is constant between token
 * refreshes. A rotated token misses the memo and re-decodes, so it
 * self-invalidates. Stored `accountId` never touches it.
 */
const computeDecodedAccountId = memoOne((access: string): string | undefined =>
  extractAccountId(access),
)

/** Stored ChatGPT account id, or one decoded from the access-token JWT. */
export function resolveAccountId(account: PoolAccount): string | undefined {
  // Truthiness (not `!= null`): an empty-string accountId can reach the pool
  // (extractAccountId accepts any string claim and the store keeps `''`), and
  // every consumer treats `''` as "no id" — so let it fall through to the JWT
  // decode below and self-heal exactly like a `null` row.
  if (account.accountId) return account.accountId
  return computeDecodedAccountId(account.access)
}
