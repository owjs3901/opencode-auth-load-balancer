/**
 * Pure, non-JSX pool-file logic for the load balancer's TUI surfaces: resolving
 * the pool-file path, reading/normalizing the on-disk pool file, the atomic
 * rename/delete mutations reachable from the sidebar menu, and the
 * display-formatting helpers (`pct`/`until`/`winPct`/`tierResets`/`stateOf`) both
 * `app_bottom` and `sidebar_content` render with. Split out of
 * `auth-load-balancer-tui.view.tsx` (which imports these unchanged) so this
 * logic — which needs no SolidJS/@opentui/JSX at all — is directly
 * unit-testable exactly like its server-side analogue, `src/pool/store.ts`,
 * already is.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  displayUtil,
  isExhausted,
  loadScoreConfig,
  type ScoreAccount,
  type ScoreWindow,
} from './auth-load-balancer-scoring'

// Scoring knobs read from env exactly like the server — single-sourced in the shared
// ./auth-load-balancer-scoring module (a byte copy of src/scheduler/score-core.ts).
// Used by `stateOf` below (`isExhausted(sa, cfg, now)`).
const cfg = loadScoreConfig()

export function poolFile(): string {
  const override = process.env.OPENCODE_AUTH_LB_DIR?.trim()
  if (override) return join(override, 'auth-load-balancer.json')
  const xdg = process.env.XDG_DATA_HOME?.trim()
  if (xdg) return join(xdg, 'opencode', 'auth-load-balancer.json')
  return join(
    homedir(),
    '.local',
    'share',
    'opencode',
    'auth-load-balancer.json',
  )
}

// Captured ONCE at module load, like `cfg` above (and the server's cachedPool
// in src/pool/paths.ts) — the env-derived path never changes at runtime.
export const POOL_FILE = poolFile()

export interface UsageWindow {
  utilization?: number
  resetAt?: number
}
export interface PoolAccount {
  id: string
  providerID: string
  label: string
  usage?: { weekly?: UsageWindow | null; hourly?: UsageWindow | null } | null
  cooldownUntil?: number
  /** tier name → epoch ms until that model tier's cap resets (tier requests steer around the account until then). */
  modelCooldownsUntil?: Record<string, number> | null
  /** LEGACY pre-tier-map field (folded into `modelCooldownsUntil.opus` for display until the server migrates the file). */
  opusCooldownUntil?: number
  disabledReason?: string | null
}
/** Loosely-typed view of the on-disk pool JSON (one shape for reads AND read-modify-writes). */
export interface PoolShape {
  accounts?: PoolAccount[]
  lastSelected?: Record<string, string>
  sessions?: Record<string, { accountId?: string }>
}

/**
 * True for a plain JSON object (non-null `object`, not an array). Local copy
 * of `isPlainObject` (src/util.ts) by design — the TUI runtime cannot import
 * `src/` — under the name that file's NOTE cross-references. No `value is
 * Record<…>` narrowing: the `.filter(isPlainRecordValue)` site below must
 * keep its `PoolAccount[]` element type, which a type-guard predicate to a
 * different type would widen away.
 */
export function isPlainRecordValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize parsed pool JSON defensively. `JSON.parse('null')` SUCCEEDS (so
 * readPool's catch never fires) and a hand-edited non-array `accounts` passes
 * straight through — either then throws inside the BottomBar/SidebarPanel
 * memos (`p.accounts ?? []` on null / `.find` on an object), breaking BOTH
 * slots until the file is repaired by hand. The server guards these cases in
 * `readRaw` (src/pool/store.ts); mirror that trust boundary here.
 */
export function toPoolShape(parsed: unknown): PoolShape {
  if (!isPlainRecordValue(parsed)) return {}
  const pool = parsed as PoolShape
  // Row-level mirror of the server's `normalizeAccounts` trust boundary
  // (store.ts): a hand-edited `accounts: [null, …]` (or a primitive element)
  // otherwise throws inside the BottomBar/SidebarPanel memos (`x.id` on null)
  // every poll until the file is repaired by hand — the server only heals it
  // on its next write. Only the IDENTITY fields are irreparable:
  // `normalizeAccounts` (src/pool/store.ts) drops rows with a non-string `id`
  // OR `providerID` (they cannot be guessed), so drop exactly those here too.
  // A non-string `label` is REPARABLE — `normalizeAccounts`' label heal sets
  // it to `''` and KEEPS the row — so healing
  // (not dropping) below keeps the bar/sidebar consistent with the server
  // dashboards AND keeps `mutatePoolFile` (which re-serializes this shape)
  // from permanently deleting an account the server would have healed. The
  // inline arrow (not a type-guard predicate) keeps the `PoolAccount[]`
  // element type — see the isPlainRecordValue note.
  pool.accounts = Array.isArray(pool.accounts)
    ? pool.accounts.filter(
        (row) =>
          isPlainRecordValue(row) &&
          typeof row.id === 'string' &&
          typeof row.providerID === 'string',
      )
    : undefined
  if (pool.accounts) {
    for (const row of pool.accounts) {
      // Mirror `normalizeAccounts`' label heal — an empty label renders
      // blank but never throws.
      if (typeof (row as { label?: unknown }).label !== 'string') row.label = ''
    }
  }
  // `lastSelected` / `sessions` must be plain records (the server heals these
  // via `isPlainObject`). A hand-edited primitive (`"lastSelected": "oops"`)
  // or array otherwise survives: `Object.entries` on a string iterates
  // per-character garbage every poll, and `mutatePoolFile` writes the corrupt
  // shape back. Reject to `undefined` so the `?? {}` fallbacks apply and the
  // next TUI write heals the file.
  if (!isAbsentOrPlainRecord(pool.lastSelected)) pool.lastSelected = undefined
  if (!isAbsentOrPlainRecord(pool.sessions)) pool.sessions = undefined
  return pool
}

/**
 * True when the value is absent (`undefined`) or a plain JSON object. NOT the
 * same as `isPlainObject` (src/util.ts) — that returns false for `undefined`;
 * here absent fields are fine because the `?? {}` fallbacks downstream heal them.
 */
export function isAbsentOrPlainRecord(value: unknown): boolean {
  return value === undefined || isPlainRecordValue(value)
}

/** Read the pool file at `path` (defaults to `POOL_FILE`); malformed/missing → `{}`. */
export function readPool(path: string = POOL_FILE): PoolShape {
  try {
    return toPoolShape(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return {}
  }
}

/**
 * Injectable sync fs surface — mirrors `src/pool/store.ts`'s async `FsOps` so
 * `mutatePoolFile`'s atomic-write + cleanup-on-failure branches are
 * unit-testable without racing the real filesystem. `BottomBar`/`SidebarPanel`
 * never pass this — they get `realFsOps` via the default parameter.
 */
export interface FsOps {
  readFileSync: (path: string, encoding: 'utf8') => string
  writeFileSync: (path: string, data: string, options: { mode: number }) => void
  renameSync: (oldPath: string, newPath: string) => void
  unlinkSync: (path: string) => void
}
const realFsOps: FsOps = { readFileSync, writeFileSync, renameSync, unlinkSync }

/** Read-modify-write the pool file atomically (temp + rename — never a direct overwrite). */
export function mutatePoolFile(
  fn: (pool: PoolShape) => void,
  path: string = POOL_FILE,
  ops: FsOps = realFsOps,
): void {
  let tmp: string | undefined
  try {
    // Same guard as readPool: `fn` must never run on `null` / a non-object
    // (JSON.parse('null') succeeds), and healing here also repairs the file.
    const pool = toPoolShape(JSON.parse(ops.readFileSync(path, 'utf8')))
    fn(pool)
    const payload = JSON.stringify(pool, null, 2)
    tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    ops.writeFileSync(tmp, payload, { mode: 0o600 })
    ops.renameSync(tmp, path)
    tmp = undefined
  } catch {
    // Atomic temp+rename failed (e.g. the server briefly holds the file on
    // Windows). NEVER fall back to a direct overwrite — that would shred a
    // concurrent server write of usage/cooldown/session/tokenGen state
    // (see src/pool/store.ts writeJsonAtomic, which was deliberately changed
    // away from that fallback in iteration #0046). Mirror its cleanup so a
    // sustained failure doesn't leave a stray .tmp behind; the user can retry.
    if (tmp) {
      try {
        ops.unlinkSync(tmp)
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
  }
}

export function renameInPool(
  id: string,
  label: string,
  path: string = POOL_FILE,
): void {
  mutatePoolFile((pool) => {
    const acct = (pool.accounts ?? []).find((a) => a.id === id)
    if (acct) acct.label = label
  }, path)
}

/** Remove an account from the pool and drop any in-use / session references to it. */
export function deleteFromPool(id: string, path: string = POOL_FILE): void {
  mutatePoolFile((pool) => {
    pool.accounts = (pool.accounts ?? []).filter((a) => a.id !== id)
    const lastSelected = pool.lastSelected ?? {}
    for (const key of Object.keys(lastSelected)) {
      if (lastSelected[key] === id) delete lastSelected[key]
    }
    const sessions = pool.sessions ?? {}
    for (const key of Object.keys(sessions)) {
      if (sessions[key]?.accountId === id) delete sessions[key]
    }
  }, path)
}

/**
 * Normalize a raw (loosely-typed) pool account into the strict shape the shared
 * scorer reads. The pool file is user-editable and read RAW here (the server
 * normalizes at its own read boundary — `normalizeWindow`/`normalizeAccounts`
 * in src/pool/store.ts), so a hand-edited string `resetAt`/`cooldownUntil`
 * would otherwise survive `?? 0` into the scorer and poison its numeric
 * comparisons (`isWindowExpired`, `stateOf`'s `> now`) until the server heals
 * the file — guard with Number.isFinite, not just nullish or typeof:
 * `JSON.parse('1e999') === Infinity` and `typeof Infinity === 'number'`, so a
 * hand-edited `1e999` cooldownUntil would render "(cooldown)" forever and a
 * `1e999` resetAt would render the literal "Infinityd" every poll.
 */
export function isFiniteNumber(v: unknown): v is number {
  return Number.isFinite(v)
}
export function toScoreWindow(
  w: UsageWindow | null | undefined,
): ScoreWindow | null {
  return w && isFiniteNumber(w.utilization)
    ? {
        utilization: w.utilization,
        resetAt: isFiniteNumber(w.resetAt) && w.resetAt >= 0 ? w.resetAt : 0,
      }
    : null
}
export function toScore(a: PoolAccount): ScoreAccount {
  return {
    usage: {
      hourly: toScoreWindow(a.usage?.hourly),
      weekly: toScoreWindow(a.usage?.weekly),
    },
    cooldownUntil: isFiniteNumber(a.cooldownUntil) ? a.cooldownUntil : 0,
    disabledReason: a.disabledReason ?? null,
  }
}

export function pct(u: number | null | undefined): string {
  return typeof u === 'number' ? `${Math.round(u * 100)}%` : '-'
}
export function until(resetAt: number | undefined, now: number): string {
  // Finiteness guard, not just truthiness/typeof: this reads the RAW
  // pool-file value (see the callers' "deliberately stays on the RAW
  // resetAt" note), so a hand-edited string (`"2026-01-01"`) would make
  // `resetAt - now` NaN and render the literal "NaNd" — and a `1e999`
  // (`Infinity`, which typeof calls a number) the literal "Infinityd" —
  // every poll until the server heals the file.
  if (!isFiniteNumber(resetAt) || resetAt <= now) return '-'
  // Mirror the server's `relTime` (src/status.ts) semantics: floor minutes at 1
  // (a sub-30s future reset must not render "0m" — '-' is reserved for elapsed)
  // and FLOOR the day figure (36h is "1d", not "2d") so the TUI bar's day/minute
  // rounding can never disagree with the CLI/tool dashboard's. NOTE: this is
  // coarser than the CLI within the hour band on purpose (bar-width budget) —
  // the CLI renders `${hrs}h${mins % 60}m` (e.g. "3h25m"), this renders just
  // `${hrs}h` (e.g. "3h"). Same day-level bucket, less precision inside it —
  // not byte-identical output.
  const mins = Math.max(1, Math.round((resetAt - now) / 60_000))
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}
/** A window's utilization for the bar: "-" when absent, "0%" once it has reset (stale value dropped). */
export function winPct(w: UsageWindow | null | undefined, now: number): string {
  return pct(displayUtil(toScoreWindow(w), now))
}
/**
 * The account's active model-tier cooldowns as display pairs, read from the
 * RAW pool file: entries must be finiteness-guarded like every other raw read
 * here (a hand-edited `1e999` → Infinity would render "opus" forever), and
 * the LEGACY `opusCooldownUntil` field is folded in (max-merged) until the
 * server migrates the file. Sorted by tier name (raw `< / >`, no locale) so
 * the bar can never disagree with the CLI/tool dashboard's ordering.
 */
export function tierResets(a: PoolAccount, now: number): [string, number][] {
  const raw = a.modelCooldownsUntil
  const merged: Record<string, number> = {}
  if (isPlainRecordValue(raw)) {
    for (const [tier, resetAt] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      if (isFiniteNumber(resetAt) && resetAt > now) merged[tier] = resetAt
    }
  }
  if (isFiniteNumber(a.opusCooldownUntil) && a.opusCooldownUntil > now) {
    merged.opus = Math.max(merged.opus ?? 0, a.opusCooldownUntil)
  }
  return Object.entries(merged).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
}
export function stateOf(
  sa: ScoreAccount,
  tiers: [string, number][],
  now: number,
): string {
  if (sa.disabledReason) return 're-login'
  if (sa.cooldownUntil > now) return 'cooldown'
  if (isExhausted(sa, cfg, now)) return 'full'
  // A model-tier limit keeps the account usable (other models + downgrade),
  // so it annotates rather than sidelines — mirrors src/status.ts.
  if (tiers.length > 0)
    return tiers.map(([tier, at]) => `${tier} ${until(at, now)}`).join(' · ')
  return ''
}
