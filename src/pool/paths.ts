import { homedir } from 'node:os'
import { join } from 'node:path'

interface DataDirEnv {
  override?: string | undefined
  xdgDataHome?: string | undefined
}

/**
 * Resolve opencode's data directory, matching opencode-core's `xdg-basedir` usage:
 *   $XDG_DATA_HOME/opencode  or  ~/.local/share/opencode
 *
 * xdg-basedir is platform-agnostic — it does NOT special-case Windows or macOS, so
 * opencode uses ~/.local/share/opencode on every OS (verified with `opencode debug
 * paths` on Windows). OPENCODE_AUTH_LB_DIR overrides everything (handy for tests).
 */
export function resolveDataDir(env: DataDirEnv, home: string): string {
  const override = env.override?.trim()
  if (override) return override

  const xdg = env.xdgDataHome?.trim()
  if (xdg) return join(xdg, 'opencode')

  return join(home, '.local', 'share', 'opencode')
}

/** Resolve the data dir from the live process environment. */
export function opencodeDataDir(): string {
  return resolveDataDir(
    {
      override: process.env.OPENCODE_AUTH_LB_DIR,
      xdgDataHome: process.env.XDG_DATA_HOME,
    },
    homedir(),
  )
}

/**
 * One-slot memo for `poolFilePath()`, keyed by the RAW values of the two env
 * vars the path depends on. Every `readPool()` calls `poolFilePath()` once and
 * every `mutatePool()` calls it ≥3 times (lock dir + read + write), and each
 * uncached call re-reads two env vars, crosses the JS↔native boundary via
 * `homedir()`, and re-runs two `path.join`s — all to produce a string that is
 * constant unless the env changes (same rationale as the module-load
 * `HOSTNAME` capture in `pool/lock.ts`). Keying by the raw env values keeps
 * the tests' per-test `OPENCODE_AUTH_LB_DIR` isolation exact: any env change
 * is a cache miss and the path is recomputed.
 */
let cachedPool: {
  override: string | undefined
  xdg: string | undefined
  path: string
} | null = null

/** Path to the load-balancer's credential pool file. */
export function poolFilePath(): string {
  const override = process.env.OPENCODE_AUTH_LB_DIR
  const xdg = process.env.XDG_DATA_HOME
  if (
    cachedPool &&
    cachedPool.override === override &&
    cachedPool.xdg === xdg
  ) {
    return cachedPool.path
  }
  const path = join(
    resolveDataDir({ override, xdgDataHome: xdg }, homedir()),
    'auth-load-balancer.json',
  )
  cachedPool = { override, xdg, path }
  return path
}
