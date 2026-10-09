import { STATIC_CREDENTIAL_EXPIRES, type TokenSet } from '../../types'
import { ignore } from '../../util'
import type { TokenLogin } from '../types'
import { ORGANIZATION_ID_HEADER, SETUP_TOKEN_DOCS_URL } from './constants'
import { probeSnapshot, sendUsageProbe } from './usage'

/** What `claude setup-token` prints: an OAuth access token, `sk-ant-oat01-` + base64url. */
const SETUP_TOKEN_RE = /^sk-ant-oat\d+-[\w-]+$/

/**
 * The pasted token, checked before it can join the pool. All whitespace is
 * dropped first: a terminal wraps the long token, so a copied one routinely
 * carries line breaks. One probe then decides — only a 401/403 means the
 * token does not authenticate (a 429 is a valid but exhausted one). Its
 * response names the organization the token acts for and the account's
 * usage windows: with no profile scope, that is all that ties the token to
 * its account's OAuth login, and the usage seeds the row without a second
 * probe.
 */
export async function exchangeSetupToken(
  input: string,
): Promise<TokenSet | null> {
  const token = input.replace(/\s+/g, '')
  if (!SETUP_TOKEN_RE.test(token)) return null
  let res: Response
  try {
    res = await sendUsageProbe(token)
  } catch {
    return null
  }
  await res.body?.cancel().catch(ignore)
  if (res.status === 401 || res.status === 403) return null
  const tokens: TokenSet = {
    access: token,
    refresh: '',
    expires: STATIC_CREDENTIAL_EXPIRES,
    inferenceOnly: true,
  }
  const orgId = res.headers.get(ORGANIZATION_ID_HEADER)
  if (orgId) tokens.orgId = orgId
  const usage = probeSnapshot(res.headers, Date.now())
  if (usage) tokens.usage = usage
  return tokens
}

export const setupTokenLogin: TokenLogin = {
  label: 'setup-token',
  url: SETUP_TOKEN_DOCS_URL,
  instructions:
    'Run `claude setup-token`, approve it in the browser, then paste the token it prints (sk-ant-oat01-…) here:',
  exchange: exchangeSetupToken,
}
