import { recordLostLogin } from './accounts'
import { type LockOptions, withLock as withFileLock } from './pool/lock'
import { poolFilePath } from './pool/paths'
import { findAccount, mutatePool, readPoolAccount } from './pool/store'
import type { ProviderAdapter } from './providers/types'
import {
  MANUAL_DISABLED_REASON,
  type PoolAccount,
  STATIC_CREDENTIAL_EXPIRES,
  type TokenSet,
} from './types'
import { errorSummary } from './util'

/** Refresh this many ms before the access token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000

/**
 * The per-account refresh lock is held across the network refresh POST, so it
 * tolerates a slow token endpoint (staleMs) and lets a second process WAIT for an
 * in-flight refresh (timeoutMs) instead of racing the same single-use token.
 */
const REFRESH_LOCK: LockOptions = {
  staleMs: 120_000,
  timeoutMs: 60_000,
  retryMs: 50,
  heartbeatMs: 5_000,
}

/**
 * Per-account in-flight refresh promises (same-process singleflight).
 *
 * Anthropic and OpenAI rotate the refresh token on every refresh (single-use).
 * Collapsing concurrent same-process refreshes to one in-flight promise avoids
 * spending the token twice; the cross-process refresh lock + `tokenGen` guard
 * below handle the multi-process case. The promise resolves to the full TokenSet
 * so every concurrent caller can update its OWN local PoolAccount (production
 * fan-out via readPool() hands each parallel request a different object).
 */
const inflight = new Map<string, Promise<TokenSet>>()

/** The single-use refresh token + the generation it was read at (the CAS key). */
export interface RefreshAttempt {
  readonly refresh: string
  readonly gen: number
}

export function needsRefresh(account: PoolAccount, now: number): boolean {
  return !account.access || account.expires - REFRESH_SKEW_MS <= now
}

// Hoisted to module scope like the repo's other repeatedly-evaluated regexes:
// `isInvalidGrant` runs on every failed refresh (twice when in-flight joiners
// exist). Sharing one instance is safe — no `/g` flag, and `match` leaves no
// cross-call state on the RegExp.
const REFRESH_STATUS_RE = /^Token refresh failed: (\d+)/

function isInvalidGrant(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  // The "Token refresh failed: <status>" prefix both OAuth paths throw makes the
  // HTTP status AUTHORITATIVE — only a real 400/401 is invalid_grant (RFC 6749
  // §5.2). Body text on a 5xx must NOT flip the verdict (locked in stateful.test).
  const m = error.message.match(REFRESH_STATUS_RE)
  if (m) {
    const status = Number(m[1])
    return status === 400 || status === 401
  }
  // No status prefix (e.g. a test fake throwing `new Error('invalid_grant')`).
  return error.message.includes('invalid_grant')
}

/** The status and server body `readRefreshResponse` puts in its error message. */
const REFRESH_FAILURE_RE = /^Token refresh failed: (\d+) — ([\s\S]*)$/

/** Why the token endpoint refused a refresh, as one line for the dashboards. */
function refusalReason(error: Error): string {
  const m = REFRESH_FAILURE_RE.exec(error.message)
  return m ? errorSummary(Number(m[1]), m[2] ?? '') : error.message
}

export function genOf(account: PoolAccount): number {
  return account.tokenGen ?? 0
}

function tokensOf(account: PoolAccount): TokenSet {
  return {
    access: account.access,
    refresh: account.refresh,
    expires: account.expires,
    accountId: account.accountId ?? undefined,
  }
}

export function sameGeneration(
  account: PoolAccount,
  attempt: RefreshAttempt,
): boolean {
  return genOf(account) === attempt.gen && account.refresh === attempt.refresh
}

function disableReason(adapter: ProviderAdapter, label: string): string {
  return `invalid_grant: re-login required (${adapter.id}:${label})`
}

/** Copy a rotated TokenSet onto a PoolAccount in place. */
function applyTokensTo(account: PoolAccount, tokens: TokenSet): void {
  account.access = tokens.access
  account.refresh = tokens.refresh
  account.expires = tokens.expires
  if (tokens.accountId) account.accountId = tokens.accountId
  if (tokens.refreshExpires) account.refreshExpires = tokens.refreshExpires
}

function refreshLockDir(providerID: string, accountId: string): string {
  return `${poolFilePath()}.refresh.${providerID}.${accountId}.lock`
}

/**
 * Run `fn` holding the account's refresh lock — taken by everything that
 * spends its single-use refresh token (a refresh, a token mint).
 */
export function withRefreshLock<T>(
  providerID: string,
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withFileLock(refreshLockDir(providerID, accountId), REFRESH_LOCK, fn)
}

/**
 * Persist a freshly rotated token under the pool write lock, but ONLY if the
 * on-disk account still carries the generation we refreshed from. If a concurrent
 * (cross-process) refresh already advanced it, adopt that newer token instead of
 * clobbering it.
 */
async function commitRefresh(
  accountId: string,
  attempt: RefreshAttempt,
  next: TokenSet,
): Promise<TokenSet> {
  return mutatePool((pool) => {
    const stored = findAccount(pool, accountId)
    if (!stored) return next
    if (!sameGeneration(stored, attempt)) return tokensOf(stored)
    applyTokensTo(stored, next)
    stored.tokenGen = attempt.gen + 1
    // A working rotation heals a re-login reason, never a MANUAL disable:
    // usage polling refreshes manually disabled accounts too.
    if (stored.disabledReason !== MANUAL_DISABLED_REASON)
      stored.disabledReason = null
    return next
  })
}

/**
 * Decide what to do after an invalid_grant: if the on-disk token moved on while we
 * were refreshing, our token was merely superseded by a concurrent refresh — adopt
 * the newer one (returned). Only when the failed token is STILL the current on-disk
 * token is a permanent disable justified — that is real revocation, not a race.
 *
 * Unless the row also holds a setup-token: then only its OAuth login is gone, and
 * the row falls back to the token alone (returned) — still serving inference,
 * with usage measured by the token's probe until an OAuth login is paired again.
 * Either way the server's reason is kept for the dashboards.
 */
async function resolveInvalidGrant(
  adapter: ProviderAdapter,
  accountId: string,
  attempt: RefreshAttempt,
  reason: string,
): Promise<TokenSet | null> {
  return mutatePool((pool) => {
    const stored = findAccount(pool, accountId)
    if (!stored) return null
    if (!sameGeneration(stored, attempt)) return tokensOf(stored)
    recordLostLogin(stored, 'oauth', reason)
    if (stored.inferenceToken !== undefined) {
      stored.access = stored.inferenceToken
      stored.refresh = ''
      stored.expires = STATIC_CREDENTIAL_EXPIRES
      stored.tokenGen = attempt.gen + 1
      delete stored.refreshExpires
      return tokensOf(stored)
    }
    stored.disabledReason = disableReason(adapter, stored.label)
    return null
  })
}

/**
 * The actual refresh, serialized across processes by the per-account lock: reload
 * the latest token, skip if another process already rotated it, otherwise refresh
 * and commit under the generation guard.
 */
async function runRefresh(
  adapter: ProviderAdapter,
  account: PoolAccount,
  now: number,
): Promise<TokenSet> {
  return withFileLock(
    refreshLockDir(adapter.id, account.id),
    REFRESH_LOCK,
    async () => {
      const latest = (await readPoolAccount(account.id)) ?? account
      // Won the wait but another process already rotated: adopt, don't re-spend.
      // Fresh Date.now(), NOT only the caller's loop-start `now`: acquiring the
      // lock may block up to REFRESH_LOCK.timeoutMs (60 s) behind another
      // process's refresh, and a token whose remaining life was eaten by that
      // wait must NOT be adopted as fresh (it would ship an expired Bearer and
      // 401-cool a healthy account). Math.max keeps the STRICTER of the two
      // clocks so a deliberately future `now` still forces a refresh.
      if (!needsRefresh(latest, Math.max(now, Date.now())))
        return tokensOf(latest)
      const attempt: RefreshAttempt = {
        refresh: latest.refresh,
        gen: genOf(latest),
      }
      try {
        const next = await adapter.refresh(attempt.refresh)
        return await commitRefresh(account.id, attempt, next)
      } catch (error) {
        if (!(error instanceof Error) || !isInvalidGrant(error)) throw error
        const adopted = await resolveInvalidGrant(
          adapter,
          account.id,
          attempt,
          refusalReason(error),
        )
        if (adopted) return adopted
        throw error
      }
    },
  )
}

/**
 * Settle a refresh job — apply the rotated tokens to OUR local account object,
 * or mirror disabledReason and rethrow. Shared by the job creator and every
 * in-flight joiner so the settle contract lives in one place.
 */
async function settleRefresh(
  adapter: ProviderAdapter,
  account: PoolAccount,
  job: Promise<TokenSet>,
): Promise<string> {
  try {
    const tokens = await job
    applyTokensTo(account, tokens)
    return tokens.access
  } catch (error) {
    // The pool file is already updated by the refresh job itself (via
    // `resolveInvalidGrant`); mirror disabledReason onto our OWN local object
    // so fetch.ts's `!account.disabledReason` gate holds for callers that
    // share it.
    if (isInvalidGrant(error))
      account.disabledReason = disableReason(adapter, account.label)
    throw error
  }
}

/**
 * Ensure the account has a fresh access token, refreshing if needed. The rotated
 * refresh token is persisted immediately. On a genuine invalid_grant (the current
 * token was revoked) the account is marked disabled and the error rethrown; a token
 * merely superseded by a concurrent refresh is adopted, not disabled.
 *
 * Mutates the passed `account` in place so the caller sees the new token. Concurrent
 * callers that reuse the in-flight refresh have their OWN local objects updated too.
 */
export async function ensureAccessToken(
  adapter: ProviderAdapter,
  account: PoolAccount,
  now: number,
): Promise<string> {
  if (!needsRefresh(account, now)) return account.access

  const existing = inflight.get(account.id)
  if (existing) return settleRefresh(adapter, account, existing)

  const job = runRefresh(adapter, account, now)
  inflight.set(account.id, job)
  try {
    return await settleRefresh(adapter, account, job)
  } finally {
    inflight.delete(account.id)
  }
}
