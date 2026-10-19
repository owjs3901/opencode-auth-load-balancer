import { setRefreshHooks } from '../refresh-hooks'
import { ignore } from '../util'
import { syncEnabled } from './enabled'
import { createEngine, type SyncEngine } from './engine'
import { pullLogin } from './login-hooks'
import { loginsSyncEnabled } from './logins'
import { createSyncLoop, type SyncLoop, withCycleLock } from './loop'
import { readSyncState } from './state'

export { syncEnabled }

/**
 * Start the gist-sync schedule for this process; null when sync is switched
 * off. With login sharing on it also plugs into the refresh path: a refresh is
 * published at once, and a refresh about to happen first looks at the gist.
 */
export function startSync(): SyncLoop | null {
  if (!syncEnabled()) return null
  const loop = createSyncLoop({
    engine: createEngine({ now: Date.now }),
    now: Date.now,
  })
  loop.start()
  if (!loginsSyncEnabled()) return loop
  setRefreshHooks({
    pull: pullLogin,
    afterRefresh: () => void publishAfterLogin().catch(ignore),
  })
  return {
    ...loop,
    dispose() {
      setRefreshHooks(null)
      return loop.dispose()
    },
  }
}

/** The longest a fresh login waits for its upload: the lock and the cycle share it. */
const LOGIN_PUBLISH_MS = 20_000

export interface LoginPublishOptions {
  engine?: SyncEngine
  timeoutMs?: number
}

/**
 * Publish a login that just landed, in the same breath: one sync cycle, so the
 * machines that follow the gist get it without waiting for the schedule (the
 * process may be a login command that exits right after). A no-op unless sync
 * and login sharing are on and this machine follows a gist. Bounded, and it
 * swallows every failure: a login never waits long for, or fails because of,
 * its upload.
 */
export async function publishAfterLogin(
  options: LoginPublishOptions = {},
): Promise<void> {
  const { engine = createEngine({ now: Date.now }) } = options
  const { timeoutMs = LOGIN_PUBLISH_MS } = options
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = async (): Promise<void> => {
    if (!syncEnabled() || !loginsSyncEnabled() || !(await readSyncState()))
      return
    await withCycleLock(() => engine.sync(), timeoutMs)
  }
  await Promise.race([
    publish().catch(ignore),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    }),
  ])
  clearTimeout(timer)
}
