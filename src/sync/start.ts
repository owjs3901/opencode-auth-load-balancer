import { createEngine } from './engine'
import { createSyncLoop, type SyncLoop } from './loop'

/** On unless `OPENCODE_AUTH_LB_SYNC` is `0` / `false` / `no` / `off`. */
export function syncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENCODE_AUTH_LB_SYNC?.trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off'
}

/** Start the gist-sync schedule for this process; null when sync is switched off. */
export function startSync(): SyncLoop | null {
  if (!syncEnabled()) return null
  const loop = createSyncLoop({
    engine: createEngine({ now: Date.now }),
    now: Date.now,
  })
  loop.start()
  return loop
}
