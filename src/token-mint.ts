/**
 * Long-lived Claude tokens minted from OAuth logins. A row whose OAuth login
 * is refused keeps serving on its setup-token (`resolveInvalidGrant`), so
 * every OAuth row is given one: the token `claude setup-token` prints,
 * minted by a refresh grant with no Claude Code and no second approval, and
 * renewed before it lapses.
 */
import { clearLostLogin } from './accounts'
import {
  findAccount,
  mutatePool,
  readPool,
  readPoolAccount,
} from './pool/store'
import type { ProviderAdapter } from './providers/types'
import {
  genOf,
  type RefreshAttempt,
  sameGeneration,
  withRefreshLock,
} from './refresh'
import type { PoolAccount, PoolFile } from './types'
import { ignore, setBounded } from './util'

const DAY_MS = 24 * 60 * 60 * 1000
/** A minted token is renewed once this little of its life is left. */
const RENEW_WITHIN_MS = 30 * DAY_MS
/**
 * A minted token living shorter than this was not granted the year it asked
 * for: pooled, it would soon die in place of the login it stands in for,
 * and inside the renewal window it would be minted again on every attempt.
 */
const MIN_LIFETIME_MS = 2 * RENEW_WITHIN_MS
/** A process asks for a row's token at most this often, so a refusing server is not asked per request. */
const RETRY_MS = 6 * 60 * 60 * 1000
const LAST_ATTEMPT_MAX = 256
const lastAttempt = new Map<string, number>()

/** On unless `OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN` is `0` / `false` / `no` / `off`. */
export function autoTokenEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off'
}

/** A row whose OAuth login should mint it a token: it has none, or its minted one nears its end. */
export function tokenDue(account: PoolAccount, now: number): boolean {
  if (!account.refresh || account.disabledReason) return false
  if (account.inferenceToken === undefined) return true
  return (
    account.inferenceExpires !== undefined &&
    account.inferenceExpires - now <= RENEW_WITHIN_MS
  )
}

/**
 * Mint `accountId` a token under its refresh lock, since the grant spends the
 * single-use refresh token: the row is re-read once the lock is held (another
 * process may have minted already), and the result lands only while the row
 * still holds the refresh token spent — whose rotated successor it keeps
 * even when the token itself is not pooled. Resolves whether a token landed;
 * rejects when the grant fails.
 */
export async function mintToken(
  adapter: ProviderAdapter,
  accountId: string,
): Promise<boolean> {
  const mint = adapter.mintInferenceToken
  if (!mint) return false
  return withRefreshLock(adapter.id, accountId, async () => {
    const latest = await readPoolAccount(accountId)
    if (!latest || !tokenDue(latest, Date.now())) return false
    const attempt: RefreshAttempt = {
      refresh: latest.refresh,
      gen: genOf(latest),
    }
    const minted = await mint(attempt.refresh)
    return mutatePool((pool) => {
      const row = findAccount(pool, accountId)
      if (!row || !sameGeneration(row, attempt)) return false
      if (minted.refresh !== row.refresh) {
        row.refresh = minted.refresh
        row.tokenGen = attempt.gen + 1
      }
      if (minted.refreshExpires) row.refreshExpires = minted.refreshExpires
      const now = Date.now()
      if (minted.expires - now < MIN_LIFETIME_MS || !tokenDue(row, now))
        return false
      row.inferenceToken = minted.access
      row.inferenceExpires = minted.expires
      clearLostLogin(row, 'token')
      return true
    })
  })
}

/**
 * Mint every due row of `adapter`'s provider a token, in the background of
 * startup and the request path. A process asks for each row at most once
 * per RETRY_MS, and a failed grant leaves the row as it was: the grant is a
 * refresh like any other, so a dead login surfaces through the regular
 * refresh instead.
 */
export async function maintainTokens(
  adapter: ProviderAdapter,
  now: number,
  poolSnapshot?: PoolFile,
): Promise<void> {
  if (!adapter.mintInferenceToken || !autoTokenEnabled()) return
  const pool = poolSnapshot ?? (await readPool())
  let due: string[] | undefined
  for (const account of pool.accounts) {
    if (account.providerID !== adapter.id || !tokenDue(account, now)) continue
    const last = lastAttempt.get(account.id)
    if (last !== undefined && now - last < RETRY_MS) continue
    setBounded(lastAttempt, account.id, now, LAST_ATTEMPT_MAX)
    due ??= []
    due.push(account.id)
  }
  if (due)
    await Promise.all(due.map((id) => mintToken(adapter, id).catch(ignore)))
}

/** Mint a just-landed OAuth login its token at once, so the login completes paired. */
export async function mintAtLogin(
  adapter: ProviderAdapter,
  account: PoolAccount,
): Promise<boolean> {
  const now = Date.now()
  if (
    !adapter.mintInferenceToken ||
    !autoTokenEnabled() ||
    !tokenDue(account, now)
  )
    return false
  setBounded(lastAttempt, account.id, now, LAST_ATTEMPT_MAX)
  return mintToken(adapter, account.id).catch(() => false)
}
