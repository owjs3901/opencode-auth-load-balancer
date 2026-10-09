import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mutatePool, readPool } from '../../pool/store'
import type { ProviderAdapter } from '../../providers/types'
import { decodeKey, open } from '../../sync/crypto'
import { createEngine, type SyncEngine } from '../../sync/engine'
import { formatGistLink } from '../../sync/gist'
import { readSyncState } from '../../sync/state'
import type { PoolAccount } from '../../types'
import { claudeSyncAdapter, kimiSyncAdapter } from './sync-adapters'

/**
 * Several machines on one in-memory GitHub: each is a data directory of its
 * own, `on(name, fn)` runs `fn` as that machine (the data directory, the
 * clock, and whether it has a GitHub token all follow the name), and calls
 * may nest, which is how a test makes two machines overlap.
 */
export function createPcs(label: string) {
  const root = mkdtempSync(join(tmpdir(), `auth-lb-${label}-`))
  const world = {
    current: '',
    clock: 1_000_000,
    skew: new Map<string, number>(),
    tokens: new Set<string>(),
    adapters: [claudeSyncAdapter(), kimiSyncAdapter()] as ProviderAdapter[],
  }
  const now = (): number => world.clock + (world.skew.get(world.current) ?? 0)
  const runGh = (): Promise<string> =>
    world.tokens.has(world.current)
      ? Promise.resolve(`ghp_${world.current}\n`)
      : Promise.reject(new Error('no gh'))

  async function on<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const [dir, was] = [process.env.OPENCODE_AUTH_LB_DIR, world.current]
    process.env.OPENCODE_AUTH_LB_DIR = join(root, name)
    world.current = name
    try {
      return await fn()
    } finally {
      world.current = was
      if (dir === undefined) delete process.env.OPENCODE_AUTH_LB_DIR
      else process.env.OPENCODE_AUTH_LB_DIR = dir
    }
  }

  const engine = (
    list: readonly ProviderAdapter[] = world.adapters,
  ): SyncEngine => createEngine({ now, runGh, adapters: list })

  const seed = (name: string, ...rows: PoolAccount[]) =>
    on(name, () =>
      mutatePool((pool) => {
        pool.accounts = rows
      }),
    )
  const rows = (name: string) =>
    on(name, async () => (await readPool()).accounts)
  const state = (name: string) => on(name, readSyncState)
  const run = <T>(name: string, fn: (e: SyncEngine) => Promise<T>) =>
    on(name, () => fn(engine()))

  /** The share link of the machine that created the gist. */
  async function linkOf(name: string): Promise<string> {
    const s = await state(name)
    const key = decodeKey(s?.key ?? '')
    if (!s || !key) throw new Error('no sync state')
    return formatGistLink(s.owner, s.gistId, key)
  }

  /** The snapshot now in the gist, decrypted with `name`'s key. */
  async function snapshot(
    name: string,
    blob: string,
  ): Promise<{ at: number; entries: Record<string, string>[] }> {
    const key = decodeKey((await state(name))?.key ?? '') ?? Buffer.alloc(0)
    return JSON.parse(open(blob, key))
  }

  return { root, world, on, engine, seed, rows, state, run, linkOf, snapshot }
}
