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
import type { TuiPluginApi, TuiSlotPlugin } from '@opencode-ai/plugin/tui'
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'

import {
  compareRanked,
  displayUtil,
  isAvailable,
  scoreAccount,
  utilOf,
} from './auth-load-balancer-scoring'
import {
  cfg,
  compareAscii,
  deleteFromPool,
  pct,
  type PoolShape,
  readPool,
  renameInPool,
  stateOf,
  tierResets,
  toScore,
  until,
  winPct,
} from './auth-load-balancer-tui.logic'

// NOTE: ships its OWN copy of `src/status.ts`'s `PROVIDER_NAMES` by design —
// the TUI runtime cannot import `src/` (see `auth-load-balancer-tui.logic.ts`'s
// `isPlainRecordValue`/`isFiniteNumber` NOTEs for the same trust boundary).
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
}
const POLL_MS = 3000

// Scoring knobs read from env exactly like the server — single-sourced in the shared
// ./auth-load-balancer-scoring module (a byte copy of src/scheduler/score-core.ts),
// shared with auth-load-balancer-tui.logic.ts (imported above as `cfg`) so it is
// computed exactly once.

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
    // `lastSelected` key order is whichever provider served first; sort by
    // provider id (byte-deterministic `< / >`, no locale) so the bar lists
    // providers in the same order as the sidebar, CLI, and status tool.
    const selected = Object.entries(p.lastSelected ?? {}).sort(([x], [y]) =>
      compareAscii(x, y),
    )
    for (const [providerID, id] of selected) {
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
    const providerIds = [...new Set(accounts.map((a) => a.providerID))].sort(
      compareAscii,
    )
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
          // Raw reads are finiteness-guarded inside tierResets: a hand-edited
          // `1e999` entry (Infinity via JSON.parse) would otherwise render its
          // tier annotation forever until the server heals the file.
          state: stateOf(sa, tierResets(a, now), now),
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
