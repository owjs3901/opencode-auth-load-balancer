/** Which pool row a fresh login belongs to: the rules `addAccount` lands it by. */
import {
  MANUAL_DISABLED_REASON,
  type PoolAccount,
  type TokenSet,
  type UsageSnapshot,
  type UsageWindow,
} from './types'

export function holdsCredential(row: PoolAccount, tokens: TokenSet): boolean {
  if (tokens.inferenceOnly) return row.inferenceToken === tokens.access
  return (
    (!!tokens.refresh && row.refresh === tokens.refresh) ||
    (!!tokens.accountId && row.accountId === tokens.accountId)
  )
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** Two readings of one reset may differ by formatting (ISO vs epoch seconds). */
const RESET_TOLERANCE_MS = 2 * 60 * 1000

/** Distance between two resets on a cycle of `period` ms (0 = one long window). */
function resetGap(a: UsageWindow, b: UsageWindow, period: number): number {
  const d = Math.abs(a.resetAt - b.resetAt)
  return period ? Math.min(d % period, period - (d % period)) : d
}

/**
 * Whether two usage readings come from the same account, judged by when its
 * windows reset — the only identity a setup-token reveals. The weekly window
 * resets at a fixed per-account anchor (so readings weeks apart compare modulo
 * a week); a live 5h window started with the account's own first request.
 * false: some known reset differs; true: the weekly anchor matches and no
 * live 5h window disagrees; undefined: nothing to compare.
 */
function sameAccount(
  a: UsageSnapshot | undefined,
  b: UsageSnapshot,
  now: number,
): boolean | undefined {
  const live = (w: UsageWindow | null | undefined) =>
    w && w.resetAt > now ? w : undefined
  const [h1, h2] = [live(a?.hourly), live(b.hourly)]
  if (h1 && h2 && resetGap(h1, h2, 0) > RESET_TOLERANCE_MS) return false
  const [w1, w2] = [a?.weekly, b.weekly]
  if (!w1?.resetAt || !w2?.resetAt) return undefined
  return resetGap(w1, w2, WEEK_MS) <= RESET_TOLERANCE_MS
}

/**
 * Auto-pairing: the one row of the credential's organization, among those
 * its usage readings do not rule out, that can take this kind of credential.
 * A setup-token carries no account identity, so the organization narrows it
 * — exact for personal Pro/Max accounts (one organization each), shared by
 * Team/Enterprise seats — and the reset times tell seats apart. A working
 * credential of the same kind is replaced only when the readings confirm
 * the same account (a renewed token); an OAuth login never replaces one,
 * since its account id already failed to match.
 */
export function orgPartner(
  rows: readonly PoolAccount[],
  tokens: TokenSet,
): PoolAccount | undefined {
  if (!tokens.orgId) return undefined
  const now = Date.now()
  const candidates = rows.filter(
    (row) =>
      row.orgId === tokens.orgId &&
      sameAccount(tokens.usage, row.usage, now) !== false,
  )
  const only = candidates.length === 1 ? candidates[0] : undefined
  if (!only) return undefined
  if (!tokens.inferenceOnly) return only.refresh ? undefined : only
  const tokenDead =
    !!only.disabledReason && only.disabledReason !== MANUAL_DISABLED_REASON
  const confirmed = sameAccount(tokens.usage, only.usage, now) === true
  return only.inferenceToken === undefined || tokenDead || confirmed
    ? only
    : undefined
}
