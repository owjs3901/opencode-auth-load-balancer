/** A row's login health for the dashboards: what it holds, and what needs a re-login. */
import type { PoolAccount } from './types'

const DAY_MS = 24 * 60 * 60 * 1000
/** Claude Code warns about an expiring login in its last 3 days; so do these dashboards. */
const LOGIN_EXPIRY_WARNING_MS = 3 * DAY_MS

/** A setup-token row's credentials, `token` or `token+oauth`; '' for any other row. */
export function credentialTag(account: PoolAccount): string {
  if (account.inferenceToken === undefined) return ''
  return account.refresh ? 'token+oauth' : 'token'
}

/**
 * Login trouble on a row still in service: a lost half of a paired row,
 * or an OAuth login about to expire. A parked row shows none — its state
 * already reads `re-login` / `disabled`.
 */
export function loginWarnings(account: PoolAccount, now: number): string[] {
  if (account.disabledReason) return []
  const warnings: string[] = []
  if (account.lostLogins?.oauth) warnings.push('oauth re-login')
  if (account.lostLogins?.token) warnings.push('token re-login')
  const left = (account.refreshExpires ?? 0) - now
  if (account.refresh && left > 0 && left <= LOGIN_EXPIRY_WARNING_MS)
    warnings.push(`oauth expires ${Math.ceil(left / DAY_MS)}d`)
  return warnings
}

function ago(at: number, now: number): string {
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 120) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  return hrs < 48 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`
}

/** Why each lost login stopped working, and when: one dashboard line apiece. */
export function lostLoginNotes(account: PoolAccount, now: number): string[] {
  const notes: string[] = []
  for (const login of ['oauth', 'token'] as const) {
    const lost = account.lostLogins?.[login]
    const name = login === 'oauth' ? 'OAuth login' : 'token'
    if (lost) notes.push(`${name} lost ${ago(lost.at, now)} — ${lost.reason}`)
  }
  return notes
}
