import { WEEK_MS } from './scheduler/score-core'
import type { UsageWindow } from './types'

/**
 * Roll a FIXED weekly reset anchor forward to its next occurrence strictly after
 * `now`. Weekly windows are anchored per account (verified live: Anthropic's
 * promotional quota reset zeroed usage but the account's next reset stayed on
 * its pre-reset anchor), so a reset time observed in the PAST still predicts
 * every future reset — it repeats every 7 days. Returns 0 when there is no
 * usable anchor (unknown stays unknown).
 */
export function rollWeeklyAnchorForward(anchor: number, now: number): number {
  if (!Number.isFinite(anchor) || anchor <= 0) return 0
  if (anchor > now) return anchor
  const periods = Math.floor((now - anchor) / WEEK_MS) + 1
  return anchor + periods * WEEK_MS
}

/**
 * Merge helper for the weekly window: when an incoming window LOST the reset
 * time (`resetAt === 0`) but we have previously seen this account's anchor,
 * keep the anchor (rolled forward past `now`) instead of downgrading to
 * "unknown". This happens on every out-of-band quota reset — the usage
 * endpoint reports `resets_at: null` until usage restarts, and a header
 * response can carry utilization without its reset — and losing the anchor
 * used to make the scheduler assume a full week of headroom for an account
 * whose (fixed) reset could be hours away. Incoming utilization always wins;
 * only the reset metadata is preserved. An incoming window that carries its
 * own reset time is returned untouched (fresh server data beats memory).
 */
export function preserveWeeklyAnchor(
  incoming: UsageWindow | null,
  stored: UsageWindow | null | undefined,
  now: number,
): UsageWindow | null {
  if (!incoming || incoming.resetAt > 0) return incoming
  const anchor = rollWeeklyAnchorForward(stored?.resetAt ?? 0, now)
  if (anchor === 0) return incoming
  return { utilization: incoming.utilization, resetAt: anchor }
}
