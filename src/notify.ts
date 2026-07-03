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
  await client.tui
    .showToast({
      body: {
        title: `${providerName(providerID)} account`,
        message,
        variant: 'info',
        duration: 4000,
      },
    })
    .catch(ignore)
}

/** Last `fromModel` toasted per provider+account, so a downgraded sticky session doesn't re-toast every turn. */
const lastFallbackToasted = new Map<string, string>()

/**
 * Toast (once per account + source-model) when a request's model was
 * auto-downgraded to a fallback because the account's Opus weekly cap is
 * exhausted — so the downgrade is visible, not silent. De-duped so a session
 * pinned on the fallback for many turns toasts only when the source model
 * changes. Best-effort: a failed toast never affects the request.
 */
export async function notifyModelFallback(
  client: ToastClient,
  providerID: string,
  account: PoolAccount,
  fromModel: string,
  toModel: string,
): Promise<void> {
  const key = `${providerID}:${account.id}`
  if (lastFallbackToasted.get(key) === fromModel) return
  lastFallbackToasted.set(key, fromModel)
  await client.tui
    .showToast({
      body: {
        title: `${providerName(providerID)} model fallback`,
        message: `▶ ${account.label}  ·  ${fromModel} → ${toModel} (Opus weekly limit)`,
        variant: 'warning',
        duration: 6000,
      },
    })
    .catch(ignore)
}
