import { displayUtil } from './scheduler/score'
import { providerName } from './status'
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

function pct(u: number | null | undefined): string {
  return typeof u === 'number' ? `${Math.round(u * 100)}%` : '-'
}

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
