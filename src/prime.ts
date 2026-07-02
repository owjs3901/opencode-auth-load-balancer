import { mutatePool, readPool } from './pool/store'
import { loadConfig } from './scheduler/config'
import { selectAccount } from './scheduler/select'

/**
 * Point the "in-use" marker at the top-ranked account for a provider. Startup is a
 * clean-context moment — no session is pinned yet — so the next request will pick this
 * account anyway; reflecting it immediately means the dashboard shows the account that
 * will actually be used next, not whichever one happened to serve last. Best-effort.
 *
 * The selection is folded INTO the `mutatePool` callback so it runs against the
 * just-locked pool snapshot we are about to write. That closes the small TOCTOU
 * window between a prior `readPool()` and this write (another opencode process could
 * re-rank, a cooldown could apply, or an account could be deleted via the TUI in
 * between) and saves the extra read on the hot startup path. The `lastSelected`
 * field is informational, so even with the old window the commit was benign — but
 * the invariant is now local ("we commit the account selected from the SAME snapshot
 * we are writing").
 *
 * NOTE: this lives in its own module (not exported from `index.ts`) on purpose —
 * opencode's plugin loader treats EVERY function exported by the plugin entry module
 * as a plugin and invokes it, so a stray exported helper there gets called with the
 * plugin input and its `undefined` return poisons the hook list.
 *
 * Fast path (same pattern as `bootstrapFromOpencodeAuth`): both provider plugins
 * run this at every opencode startup, so without it every start would take the
 * in-process mutex + cross-process file lock and atomically rewrite the pool
 * file byte-identically — `selectAccount` over zero accounts changes nothing,
 * and in the steady state (every restart after the first request)
 * `lastSelected` already points at the top-ranked account. One cheap serialized
 * read skips all of those no-op writes. No TOCTOU concern: the fast path only
 * skips a write that would change nothing, an account added concurrently is
 * primed by its own login/startup flow, and `lastSelected` is informational
 * anyway (see above).
 */
export async function primeInUse(
  providerID: string,
  now: number,
): Promise<void> {
  const snapshot = await readPool()
  if (!snapshot.accounts.some((a) => a.providerID === providerID)) return
  const cfg = loadConfig()
  const preview = selectAccount(snapshot.accounts, providerID, now, cfg)
  if (!preview || snapshot.lastSelected[providerID] === preview.account.id)
    return
  await mutatePool((pool) => {
    const selection = selectAccount(pool.accounts, providerID, now, cfg)
    if (selection) pool.lastSelected[providerID] = selection.account.id
  })
}
