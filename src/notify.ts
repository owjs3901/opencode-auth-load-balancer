import type { ProviderRecovery } from './pending/recovery'
import { displayUtil } from './scheduler/score-core'
import { pct, providerName } from './status'
import type { PoolAccount } from './types'
import { ignore, setBounded } from './util'

/** The slice of the opencode SDK client we need to show a toast. */
export interface ToastClient {
  tui: {
    showToast(opts: {
      body: {
        title?: string
        message: string
        variant: 'info' | 'success' | 'warning' | 'error'
        duration?: number
      }
    }): Promise<unknown>
  }
}

/**
 * Post a toast best-effort — a failed toast never affects the request. Both
 * notifiers share this shell so the failure contract lives in one place.
 */
async function postToast(
  client: ToastClient,
  body: Parameters<ToastClient['tui']['showToast']>[0]['body'],
): Promise<void> {
  await client.tui.showToast({ body }).catch(ignore)
}

/** Last account toasted per provider, so we only notify on an actual switch. */
const lastToasted = new Map<string, string>()

/**
 * Toast (once) when a provider's in-use account changes — the user's "which account
 * is in use" indicator. De-duped per provider so a sticky session doesn't re-toast.
 * Best-effort: a failed toast never affects the request.
 */
export async function notifyOnSwitch(
  client: ToastClient,
  providerID: string,
  account: PoolAccount,
): Promise<void> {
  if (lastToasted.get(providerID) === account.id) return
  lastToasted.set(providerID, account.id)
  const now = Date.now()
  const message = `▶ ${account.label}  ·  weekly ${pct(displayUtil(account.usage.weekly, now))}  ·  5h ${pct(displayUtil(account.usage.hourly, now))}`
  await postToast(client, {
    title: `${providerName(providerID)} account`,
    message,
    variant: 'info',
    duration: 4000,
  })
}

/** Last `fromModel@window` toasted per provider+account, so a downgraded sticky session doesn't re-toast every turn. */
const lastFallbackToasted = new Map<string, string>()

/**
 * Bounded cap for `lastFallbackToasted` (evicted via the shared `setBounded`
 * helper in `src/util.ts` — the same "clear-on-full" pattern as
 * `sanitizeCache` in `src/providers/anthropic/transform.ts`): the map is keyed
 * by `${providerID}:${account.id}` and grows by one entry the first time an
 * account's model-tier downgrade is toasted. A long-running process that
 * accumulates account churn (TUI sidebar deletes + re-logins over
 * weeks/months) would otherwise leak one entry per distinct account ever
 * downgraded, unbounded for the process lifetime. 256 is generous headroom
 * for any realistic pool; a clear only risks one spurious re-toast for an
 * account that had already been deduped, never a missed one.
 */
const LAST_FALLBACK_TOASTED_MAX = 256

/**
 * Toast (once per account + source-model + exhaustion window) when a request's
 * model was auto-downgraded to a fallback because its MODEL TIER's weekly cap
 * is exhausted — so the downgrade is visible, not silent. The de-dupe value is
 * scoped to the latest tier exhaustion window (the max entry of
 * `modelCooldownsUntil`): turns within one window toast once, but after the
 * tier cap RESETS and later re-exhausts (a NEW window, hence a new cooldown
 * timestamp) the downgrade toasts again — otherwise every window after the
 * first in a process's lifetime would be silent. A source-model change
 * re-toasts within a window too. The scan ignores tier entries that have
 * already expired (`until <= now`): nothing in the codebase purges a stale
 * `modelCooldownsUntil[tier]` entry once its window passes, so an old,
 * long-reset tier's timestamp can otherwise outrank a fresh, currently-active
 * tier's smaller timestamp and mask a genuinely NEW exhaustion window behind
 * an unchanged de-dupe key — silently suppressing the toast this function
 * exists to guarantee. When the caller supplies `fromTier` (the SPECIFIC
 * tier that triggered this downgrade — `ModelFallback.fromTier`, threaded
 * through from `downgradeModel`), that tier's own window is used directly
 * instead of the max-scan: with two tiers simultaneously active on one
 * account (e.g. `fable` capped, downgrade to `opus`, `opus` ALSO capped,
 * downgrade to `sonnet`) the max-scan could pick whichever window is later,
 * not necessarily the one that actually triggered this toast. Callers that
 * don't supply `fromTier` (older call sites, or a provider with no tier
 * concept) keep the max-scan heuristic unchanged. Best-effort: a failed
 * toast never affects the request.
 */
export async function notifyModelFallback(
  client: ToastClient,
  providerID: string,
  account: PoolAccount,
  fromModel: string,
  toModel: string,
  fromTier?: string,
): Promise<void> {
  const key = `${providerID}:${account.id}`
  const now = Date.now()
  const tiers = account.modelCooldownsUntil
  let latestWindow = 0
  const triggeringWindow = fromTier ? tiers?.[fromTier] : undefined
  if (triggeringWindow !== undefined && triggeringWindow > now) {
    latestWindow = triggeringWindow
  } else if (tiers) {
    for (const until of Object.values(tiers)) {
      if (until > now && until > latestWindow) latestWindow = until
    }
  }
  const window = `${fromModel}@${latestWindow}`
  if (lastFallbackToasted.get(key) === window) return
  setBounded(lastFallbackToasted, key, window, LAST_FALLBACK_TOASTED_MAX)
  await postToast(client, {
    title: `${providerName(providerID)} model fallback`,
    message: `▶ ${account.label}  ·  ${fromModel} → ${toModel} (model-tier weekly limit)`,
    variant: 'warning',
    duration: 6000,
  })
}

function pendingDate(at: number): string {
  const date = new Date(at)
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const month = months[date.getMonth()] ?? ''
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month} ${date.getDate()}, ${hour}:${minute}`
}

/** Announce a durable provider wait. Coordinator-level signatures dedupe it. */
export async function notifyPending(
  client: ToastClient,
  providerID: string,
  recovery: Extract<ProviderRecovery, { state: 'quota-blocked' }>,
  now: number = Date.now(),
): Promise<void> {
  const provider = providerName(providerID)
  const message =
    recovery.resumeAt === null
      ? `${provider} usage exhausted — checking again in ${Math.max(1, Math.round((recovery.nextCheckAt - now) / 60_000))}m (Esc to cancel)`
      : `${provider} usage exhausted — pending until ${pendingDate(recovery.resumeAt)} (Esc to cancel)`
  await postToast(client, {
    title: `${provider} request pending`,
    message,
    variant: 'warning',
    duration: 8000,
  })
}

export async function notifyPendingResumed(
  client: ToastClient,
  providerID: string,
): Promise<void> {
  const provider = providerName(providerID)
  await postToast(client, {
    title: `${provider} request resumed`,
    message: `${provider} usage recovered — resuming request`,
    variant: 'success',
    duration: 5000,
  })
}

export async function notifyPendingRestored(
  client: ToastClient,
  providerID: string,
  count: number,
): Promise<void> {
  const provider = providerName(providerID)
  await postToast(client, {
    title: `${provider} pending restored`,
    message: `Restored ${count} pending ${provider} session${count === 1 ? '' : 's'}`,
    variant: 'info',
    duration: 6000,
  })
}

const restoreErrorsToasted = new Map<string, true>()

export async function notifyPendingRestoreError(
  client: ToastClient,
  providerID: string,
  messageID: string,
): Promise<void> {
  const key = `${providerID}:${messageID}`
  if (restoreErrorsToasted.has(key)) return
  setBounded(restoreErrorsToasted, key, true, 256)
  const provider = providerName(providerID)
  await postToast(client, {
    title: `${provider} pending restore`,
    message: `Could not restore a pending ${provider} request yet — retrying automatically`,
    variant: 'error',
    duration: 8000,
  })
}
