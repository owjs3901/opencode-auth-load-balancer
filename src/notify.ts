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
 * Toast (once per account + source-model + exhaustion window) when a request's
 * model was auto-downgraded to a fallback because the account's Opus weekly cap
 * is exhausted — so the downgrade is visible, not silent. The de-dupe value is
 * scoped to the tier's exhaustion window (`opusCooldownUntil`): turns within
 * one window toast once, but after the Opus cap RESETS and later re-exhausts (a
 * NEW window, hence a new cooldown timestamp) the downgrade toasts again —
 * otherwise every window after the first in a process's lifetime would be
 * silent. A source-model change re-toasts within a window too. Best-effort: a
 * failed toast never affects the request.
 */
export async function notifyModelFallback(
  client: ToastClient,
  providerID: string,
  account: PoolAccount,
  fromModel: string,
  toModel: string,
): Promise<void> {
  const key = `${providerID}:${account.id}`
  const window = `${fromModel}@${account.opusCooldownUntil ?? 0}`
  if (lastFallbackToasted.get(key) === window) return
  lastFallbackToasted.set(key, window)
  await postToast(client, {
    title: `${providerName(providerID)} model fallback`,
    message: `▶ ${account.label}  ·  ${fromModel} → ${toModel} (Opus weekly limit)`,
    variant: 'warning',
    duration: 6000,
  })
}
