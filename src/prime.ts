import { mutatePool, readPool } from './pool/store'
import { loadConfig } from './scheduler/config'
import { selectAccount } from './scheduler/select'

/**
 * Point the "in-use" marker at the top-ranked account for a provider. Startup is a
 * clean-context moment — no session is pinned yet — so the next request will pick this
 * account anyway; reflecting it immediately means the dashboard shows the account that
 * will actually be used next, not whichever one happened to serve last. Best-effort.
 *
 * NOTE: this lives in its own module (not exported from `index.ts`) on purpose —
 * opencode's plugin loader treats EVERY function exported by the plugin entry module
 * as a plugin and invokes it, so a stray exported helper there gets called with the
 * plugin input and its `undefined` return poisons the hook list.
 */
export async function primeInUse(
  providerID: string,
  now: number,
): Promise<void> {
  const pool = await readPool()
  const selection = selectAccount(pool.accounts, providerID, now, loadConfig())
  if (!selection) return
  await mutatePool((p) => {
    p.lastSelected[providerID] = selection.account.id
  })
}
