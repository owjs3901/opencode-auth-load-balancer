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

/** Path to the load-balancer's credential pool file. */
export function poolFilePath(): string {
  return join(opencodeDataDir(), 'auth-load-balancer.json')
}
