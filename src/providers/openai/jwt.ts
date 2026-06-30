import type { PoolAccount } from '../../types'

/**
 * Decode a JWT payload WITHOUT signature verification. We only read first-party
 * claims (account id) from a token the OAuth server just issued to us, so there
 * is nothing to verify against — we never trust it for authorization.
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(b64, 'base64').toString('utf8')
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

/** Stored ChatGPT account id, or one decoded from the access-token JWT. */
export function resolveAccountId(account: PoolAccount): string | undefined {
  return account.accountId ?? extractAccountId(account.access)
}
