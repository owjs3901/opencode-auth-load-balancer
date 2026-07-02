/** @jsxImportSource @opentui/solid */
/**
 * SolidJS view for the load balancer's TUI surfaces (loaded by opencode's TUI
 * runtime via the entry's lazy import). It reads the pool file the server plugin
 * writes (polled) and renders:
 *
 *   - app_bottom — an always-visible bottom bar OUTSIDE the prompt, showing the
 *     in-use account per provider with weekly % (+ days to reset) and 5h % (+ time
 *     to reset). (Rendering inside the prompt's right slot squeezed the prompt and
 *     broke its layout when the input was empty.)
 *   - sidebar_content — a panel next to Context / MCP / LSP listing ALL accounts
 *     per provider, sorted by the scheduler's score (highest = use next), showing
 *     the score + use-order, usage + reset countdowns, in-use marker, and state.
 *     Click any account row for a menu to Rename (prompt) or Delete (confirm) it,
 *     written straight to the pool file.
 *
 * The ranking is computed by the SAME code the server scheduler uses — imported from a
 * byte-identical copy of src/scheduler/score-core.ts installed alongside this file
 * (auth-load-balancer-scoring.ts) — so the displayed order can never drift from what the
 * scheduler actually picks.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { TuiPluginApi, TuiSlotPlugin } from '@opencode-ai/plugin/tui'
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import {
  compareRanked,
  displayUtil,
  isAvailable,
  isExhausted,
  loadScoreConfig,
  type ScoreAccount,
  scoreAccount,
  type ScoreWindow,
  utilOf,
} from './auth-load-balancer-scoring'

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
}
const POLL_MS = 3000

// Scoring knobs read from env exactly like the server — single-sourced in the shared
// ./auth-load-balancer-scoring module (a byte copy of src/scheduler/score-core.ts).
const cfg = loadScoreConfig()

function poolFile(): string {
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

interface UsageWindow {
  utilization?: number
  resetAt?: number
}
interface PoolAccount {
  id: string
  providerID: string
  label: string
  usage?: { weekly?: UsageWindow | null; hourly?: UsageWindow | null } | null
  cooldownUntil?: number
  disabledReason?: string | null
}
/** Loosely-typed view of the on-disk pool JSON (one shape for reads AND read-modify-writes). */
interface PoolShape {
  accounts?: PoolAccount[]
  lastSelected?: Record<string, string>
  sessions?: Record<string, { accountId?: string }>
}

function readPool(): PoolShape {
  try {
    return JSON.parse(readFileSync(poolFile(), 'utf8')) as PoolShape
  } catch {
    return {}
  }
}

/** Read-modify-write the pool file atomically (temp + rename — never a direct overwrite). */
function mutatePoolFile(fn: (pool: PoolShape) => void): void {
  let tmp: string | undefined
  try {
    const path = poolFile()
    const pool = JSON.parse(readFileSync(path, 'utf8')) as PoolShape
    fn(pool)
    const payload = JSON.stringify(pool, null, 2)
    tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, payload, { mode: 0o600 })
    renameSync(tmp, path)
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
        unlinkSync(tmp)
      } catch {
        /* ignore — best-effort cleanup */
      }
    }
  }
}

function renameInPool(id: string, label: string): void {
  mutatePoolFile((pool) => {
    const acct = (pool.accounts ?? []).find((a) => a.id === id)
    if (acct) acct.label = label
  })
}

/** Remove an account from the pool and drop any in-use / session references to it. */
function deleteFromPool(id: string): void {
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
  })
}

/** Normalize a raw (loosely-typed) pool account into the strict shape the shared scorer reads. */
function toScoreWindow(w: UsageWindow | null | undefined): ScoreWindow | null {
  return w && typeof w.utilization === 'number'
    ? { utilization: w.utilization, resetAt: w.resetAt ?? 0 }
    : null
}
function toScore(a: PoolAccount): ScoreAccount {
  return {
    usage: {
      hourly: toScoreWindow(a.usage?.hourly),
      weekly: toScoreWindow(a.usage?.weekly),
    },
    cooldownUntil: a.cooldownUntil ?? 0,
    disabledReason: a.disabledReason ?? null,
  }
}

function pct(u: number | null | undefined): string {
  return typeof u === 'number' ? `${Math.round(u * 100)}%` : '-'
}
function until(resetAt: number | undefined, now: number): string {
  if (!resetAt || resetAt <= now) return '-'
  // Mirror the server's `relTime` (src/status.ts) semantics: floor minutes at 1
  // (a sub-30s future reset must not render "0m" — '-' is reserved for elapsed)
  // and FLOOR the day figure (36h is "1d", not "2d") so the TUI bar can never
  // disagree with the CLI/tool dashboard about the same account's countdown.
  const mins = Math.max(1, Math.round((resetAt - now) / 60_000))
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}
/** A window's utilization for the bar: "-" when absent, "0%" once it has reset (stale value dropped). */
function winPct(w: UsageWindow | null | undefined, now: number): string {
  return pct(displayUtil(toScoreWindow(w), now))
}
function stateOf(sa: ScoreAccount, now: number): string {
  if (sa.disabledReason) return 're-login'
  if (sa.cooldownUntil > now) return 'cooldown'
  if (isExhausted(sa, cfg, now)) return 'full'
  return ''
}

function usePool() {
  const [pool, setPool] = createSignal<PoolShape>(readPool())
  const timer = setInterval(() => setPool(readPool()), POLL_MS)
  onCleanup(() => clearInterval(timer))
  return pool
}

interface Chip {
  name: string
  label: string
  wk: string
  wkReset: string
  h: string
  hReset: string
}

/** Always-visible bottom bar (app_bottom): the in-use account per provider. */
function BottomBar(props: { api: TuiPluginApi }) {
  const pool = usePool()
  const color = () => props.api.theme.current
  const chips = createMemo<Chip[]>(() => {
    const p = pool()
    const accounts = p.accounts ?? []
    const now = Date.now()
    const out: Chip[] = []
    for (const [providerID, id] of Object.entries(p.lastSelected ?? {})) {
      const a = accounts.find((x) => x.id === id)
      if (!a) continue
      out.push({
        name: PROVIDER_NAMES[providerID] ?? providerID,
        label: a.label,
        wk: winPct(a.usage?.weekly, now),
        wkReset: until(a.usage?.weekly?.resetAt, now),
        h: winPct(a.usage?.hourly, now),
        hReset: until(a.usage?.hourly?.resetAt, now),
      })
    }
    return out
  })

  return (
    <box flexDirection="row" flexShrink={0} gap={2} paddingLeft={1}>
      <For each={chips()}>
        {(a) => (
          <text fg={color().textMuted} wrapMode="none">
            <span style={{ fg: color().primary }}>
              {a.name} {a.label}
            </span>
            {`  wk ${a.wk} (${a.wkReset}) · 5h ${a.h} (${a.hReset})`}
          </text>
        )}
      </For>
    </box>
  )
}

interface Row {
  id: string
  label: string
  current: boolean
  score: number | null
  rank: number | null
  wk: string
  wkReset: string
  h: string
  hReset: string
  state: string
}
interface Group {
  provider: string
  rows: Row[]
}

/** Sidebar panel: all accounts per provider, scored + sorted, click to rename. */
function SidebarPanel(props: { api: TuiPluginApi }) {
  const pool = usePool()
  const color = () => props.api.theme.current
  const groups = createMemo<Group[]>(() => {
    const p = pool()
    const accounts = p.accounts ?? []
    const now = Date.now()
    const providerIds = [...new Set(accounts.map((a) => a.providerID))].sort()
    return providerIds.map((providerID) => {
      const ranked = accounts
        .filter((a) => a.providerID === providerID)
        .map((a) => {
          const sa = toScore(a)
          const available = isAvailable(sa, cfg, now)
          return {
            a,
            sa,
            available,
            score: available
              ? scoreAccount(sa, cfg, now)
              : Number.NEGATIVE_INFINITY,
            weeklyUtil: utilOf(sa.usage.weekly, now),
          }
        })
        .sort(compareRanked)
      let rank = 0
      const rows: Row[] = ranked.map(({ a, sa, available, score }) => {
        if (available) rank += 1
        return {
          id: a.id,
          label: a.label,
          current: p.lastSelected?.[providerID] === a.id,
          score: available ? score : null,
          rank: available ? rank : null,
          // Reuse the windows `toScore(a)` already normalized instead of
          // re-running toScoreWindow on the raw window (winPct) a second time.
          // `until()` deliberately stays on the RAW resetAt: a malformed
          // window with a reset but no utilization normalizes to null in `sa`,
          // yet the countdown should still render.
          wk: pct(displayUtil(sa.usage.weekly, now)),
          wkReset: until(a.usage?.weekly?.resetAt, now),
          h: pct(displayUtil(sa.usage.hourly, now)),
          hReset: until(a.usage?.hourly?.resetAt, now),
          state: stateOf(sa, now),
        }
      })
      return { provider: PROVIDER_NAMES[providerID] ?? providerID, rows }
    })
  })

  const dialog = () => props.api.ui.dialog

  function openRename(id: string, label: string): void {
    dialog().replace(() =>
      props.api.ui.DialogPrompt({
        title: `Rename "${label}"`,
        value: label,
        placeholder: 'New label',
        onConfirm: (next: string) => {
          const trimmed = next.trim()
          if (trimmed) renameInPool(id, trimmed)
          dialog().clear()
        },
        onCancel: () => dialog().clear(),
      }),
    )
  }

  function openDelete(id: string, label: string): void {
    dialog().replace(() =>
      props.api.ui.DialogConfirm({
        title: 'Delete account',
        message: `Remove "${label}" from the load-balancer pool? Its stored tokens are dropped — sign in again to re-add it.`,
        onConfirm: () => {
          deleteFromPool(id)
          dialog().clear()
        },
        onCancel: () => dialog().clear(),
      }),
    )
  }

  // Click an account -> a small menu so both Rename and Delete are reachable.
  function openMenu(id: string, label: string): void {
    dialog().replace(() =>
      props.api.ui.DialogSelect({
        title: label,
        options: [
          {
            title: 'Rename',
            value: 'rename',
            onSelect: () => openRename(id, label),
          },
          {
            title: 'Delete — remove from pool',
            value: 'delete',
            onSelect: () => openDelete(id, label),
          },
        ],
      }),
    )
  }

  return (
    <Show when={groups().length > 0}>
      <box>
        <text fg={color().text}>
          <b>Auth accounts</b>
          <span style={{ fg: color().textMuted }}>
            {' '}
            (click: rename / delete)
          </span>
        </text>
        <For each={groups()}>
          {(g) => (
            <box>
              <text fg={color().textMuted}>{g.provider}</text>
              <For each={g.rows}>
                {(r) => (
                  <box onMouseUp={() => openMenu(r.id, r.label)}>
                    <text
                      fg={r.current ? color().primary : color().text}
                      wrapMode="word"
                    >
                      {(r.current ? '▶ ' : '  ') +
                        (r.rank ? `${r.rank}. ` : '  ') +
                        r.label}
                      <Show when={r.score !== null}>
                        <span style={{ fg: color().secondary }}>
                          {`  ${(r.score ?? 0).toFixed(2)}`}
                        </span>
                      </Show>
                      <Show when={r.state}>
                        <span
                          style={{ fg: color().warning }}
                        >{` (${r.state})`}</span>
                      </Show>
                    </text>
                    <text fg={color().textMuted}>
                      {`      wk ${r.wk} (${r.wkReset}) · 5h ${r.h} (${r.hReset})`}
                    </text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

function makeSlots(api: TuiPluginApi): TuiSlotPlugin {
  return {
    order: 250,
    slots: {
      // Bottom bar OUTSIDE the prompt — rendering inside the prompt's right slot
      // squeezes the prompt and breaks its layout when the input is empty.
      app_bottom() {
        return <BottomBar api={api} />
      },
      // Panel in the session sidebar, next to Context / MCP / LSP.
      sidebar_content() {
        return <SidebarPanel api={api} />
      },
    },
  }
}

/** Called from the `.ts` entry's `tui(api)` (TUI runtime only). */
export function registerSlots(api: TuiPluginApi): void {
  api.slots.register(makeSlots(api))
}
