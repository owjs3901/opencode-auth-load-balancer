import { displayUtil } from './scheduler/score-core'
import { pct, providerName } from './status'
import type { PoolAccount } from './types'
import { ignore } from './util'

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
  const message = `▶ ${account.label}  ·  weekly ${pct(displayUtil(account.usage.weekly, now))} · 5h ${pct(displayUtil(account.usage.hourly, now))}`
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
 * Bounded cap for `lastFallbackToasted` (same "clear-on-full" pattern as
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
 * exists to guarantee. Best-effort: a failed toast never affects the
 * request.
 */
export async function notifyModelFallback(
  client: ToastClient,
  providerID: string,
  account: PoolAccount,
  fromModel: string,
  toModel: string,
): Promise<void> {
  const key = `${providerID}:${account.id}`
  const now = Date.now()
  let latestWindow = 0
  const tiers = account.modelCooldownsUntil
  if (tiers) {
    for (const until of Object.values(tiers)) {
      if (until > now && until > latestWindow) latestWindow = until
    }
  }
  const window = `${fromModel}@${latestWindow}`
  if (lastFallbackToasted.get(key) === window) return
  if (lastFallbackToasted.size >= LAST_FALLBACK_TOASTED_MAX)
    lastFallbackToasted.clear()
  lastFallbackToasted.set(key, window)
  await postToast(client, {
    title: `${providerName(providerID)} model fallback`,
    message: `▶ ${account.label}  ·  ${fromModel} → ${toModel} (model-tier weekly limit)`,
    variant: 'warning',
    duration: 6000,
  })
}
