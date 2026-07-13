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
 *     Click any account row for a menu to Rename (prompt), Disable/Enable
 *     (toggle), or Delete (confirm) it, written straight to the pool file.
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
  MANUAL_DISABLED_REASON,
  pct,
  type PoolShape,
  readPool,
  renameInPool,
  sessionAccountId,
  sessionFallback,
  setDisabledInPool,
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
/** Shared fallback lookup used by both the bottom bar and sidebar group labels. */
function providerLabel(id: string): string {
  return PROVIDER_NAMES[id] ?? id
}
const POLL_MS = 3000

/**
 * The current session id from the TUI route, or undefined on the home screen.
 * Unlike the `sidebar_content` slot (handed a `session_id` prop), the always-
 * visible `app_bottom` bar receives no slot props, so it reads the session from
 * the route to scope its in-use account to the VIEWER's own session.
 */
function routeSessionId(api: TuiPluginApi): string | undefined {
  const r = api.route.current
  if (r.name !== 'session') return undefined
  const sid = r.params?.sessionID
  return typeof sid === 'string' ? sid : undefined
}

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

/** Shared theme-color accessor used identically by `BottomBar` and `SidebarPanel`. */
function themeColor(api: TuiPluginApi) {
  return () => api.theme.current
}

/** The 4 usage-window display fields shared verbatim by `Chip` and `Row`. */
interface WindowDisplay {
  weeklyPct: string
  weeklyReset: string
  hourlyPct: string
  hourlyReset: string
}

interface Chip extends WindowDisplay {
  name: string
  label: string
  /** Raw model ids (requested → served) when this session runs on a fallback model, else undefined. */
  fallback?: { from: string; to: string }
}

/** Always-visible bottom bar (app_bottom): the in-use account per provider. */
function BottomBar(props: { api: TuiPluginApi }) {
  const pool = usePool()
  const color = themeColor(props.api)
  const chips = createMemo<Chip[]>(() => {
    const p = pool()
    const accounts = p.accounts ?? []
    const now = Date.now()
    const out: Chip[] = []
    const sid = routeSessionId(props.api)
    // Show the account THIS session is using per provider — NOT the global
    // `lastSelected` (whichever session served last across the whole pool). On
    // the home screen (no session) fall back to `lastSelected` so the bar isn't
    // blank. Providers byte-sorted (`< / >`, no locale) so the bar lists them in
    // the same order as the sidebar, CLI, and status tool.
    const providerIds = [...new Set(accounts.map((x) => x.providerID))].sort(
      compareAscii,
    )
    for (const providerID of providerIds) {
      const id =
        sessionAccountId(p, providerID, sid) ??
        (sid ? undefined : p.lastSelected?.[providerID])
      if (!id) continue
      const a = accounts.find((x) => x.id === id)
      if (!a) continue
      out.push({
        name: providerLabel(providerID),
        label: a.label,
        weeklyPct: winPct(a.usage?.weekly, now),
        weeklyReset: until(a.usage?.weekly?.resetAt, now),
        hourlyPct: winPct(a.usage?.hourly, now),
        hourlyReset: until(a.usage?.hourly?.resetAt, now),
        // Only THIS session's fallback (keyed by sid); the `lastSelected` home-screen
        // fallback path has no session, so no downgrade to surface there.
        fallback: sessionFallback(p, providerID, sid),
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
            {a.fallback ? (
              <span style={{ fg: color().warning }}>
                {`  fallback ${a.fallback.from}→${a.fallback.to}`}
              </span>
            ) : null}
            {`  wk ${a.weeklyPct} (${a.weeklyReset}) · 5h ${a.hourlyPct} (${a.hourlyReset})`}
          </text>
        )}
      </For>
    </box>
  )
}

interface Row extends WindowDisplay {
  id: string
  label: string
  current: boolean
  score: number | null
  rank: number | null
  state: string
  manuallyDisabled: boolean
}
interface Group {
  provider: string
  rows: Row[]
}

/** Sidebar panel: all accounts per provider, scored + sorted, click to rename. */
function SidebarPanel(props: {
  api: TuiPluginApi
  sessionId: string | undefined
}) {
  const pool = usePool()
  const color = themeColor(props.api)
  const groups = createMemo<Group[]>(() => {
    const p = pool()
    const accounts = p.accounts ?? []
    const now = Date.now()
    const providerIds = [...new Set(accounts.map((a) => a.providerID))].sort(
      compareAscii,
    )
    return providerIds.map((providerID) => {
      // The account the VIEWER's session is pinned to for this provider — used
      // for the in-use (▶) marker instead of the global `lastSelected`, so the
      // marker reflects THIS session, not whichever session served last.
      const sessionAcct = sessionAccountId(p, providerID, props.sessionId)
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
          current: sessionAcct === a.id,
          score: available ? score : null,
          rank: available ? rank : null,
          // Reuse the windows `toScore(a)` already normalized instead of
          // re-running toScoreWindow on the raw window (winPct) a second time.
          // `until()` deliberately stays on the RAW resetAt: a malformed
          // window with a reset but no utilization normalizes to null in `sa`,
          // yet the countdown should still render.
          weeklyPct: pct(displayUtil(sa.usage.weekly, now)),
          weeklyReset: until(a.usage?.weekly?.resetAt, now),
          hourlyPct: pct(displayUtil(sa.usage.hourly, now)),
          hourlyReset: until(a.usage?.hourly?.resetAt, now),
          // Raw reads are finiteness-guarded inside tierResets: a hand-edited
          // `1e999` entry (Infinity via JSON.parse) would otherwise render its
          // tier annotation forever until the server heals the file.
          state: stateOf(sa, tierResets(a, now), now),
          manuallyDisabled: a.disabledReason === MANUAL_DISABLED_REASON,
        }
      })
      return { provider: providerLabel(providerID), rows }
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

  // Click an account -> a small menu so Rename, Disable/Enable, and Delete are
  // all reachable. Deliberately NOT api.ui.DialogSelect: that always renders an
  // auto-focused filter <input>, and a focused opentui input swallows the FIRST
  // Esc (to blur itself) — so the menu needed TWO Esc presses to close. A plain
  // clickable list has no input, so the dialog stack's own Esc binding closes it
  // in ONE press. The menu is opened by a mouse click on the row, so mouse-driven
  // options stay consistent (there is no keyboard path that opens it).
  function openMenu(
    id: string,
    label: string,
    manuallyDisabled: boolean,
  ): void {
    const items: { title: string; run: () => void }[] = [
      { title: 'Rename', run: () => openRename(id, label) },
      {
        // Reversible (just a scheduler skip), so no confirm step — flip the
        // pool flag and close, unlike Delete which drops the tokens.
        title: manuallyDisabled
          ? 'Enable — include in selection'
          : 'Disable — exclude from selection',
        run: () => {
          setDisabledInPool(id, !manuallyDisabled)
          dialog().clear()
        },
      },
      { title: 'Delete — remove from pool', run: () => openDelete(id, label) },
    ]
    dialog().replace(() => {
      const c = color()
      const [hovered, setHovered] = createSignal(-1)
      return (
        <box
          gap={1}
          paddingBottom={1}
          paddingLeft={4}
          paddingRight={4}
          paddingTop={1}
        >
          <box flexDirection="row" justifyContent="space-between">
            <text fg={c.text}>
              <b>{label}</b>
            </text>
            <text fg={c.textMuted} onMouseUp={() => dialog().clear()}>
              esc
            </text>
          </box>
          <box>
            <For each={items}>
              {(item, i) => (
                <box
                  onMouseMove={() => setHovered(i())}
                  onMouseUp={() => item.run()}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={hovered() === i() ? c.primary : c.text}>
                    {item.title}
                  </text>
                </box>
              )}
            </For>
          </box>
        </box>
      )
    })
  }

  return (
    <Show when={groups().length > 0}>
      <box>
        <text fg={color().text}>
          <b>Auth accounts</b>
          <span style={{ fg: color().textMuted }}>
            {' '}
            (click: rename / disable / delete)
          </span>
        </text>
        <For each={groups()}>
          {(g) => (
            <box>
              <text fg={color().textMuted}>{g.provider}</text>
              <For each={g.rows}>
                {(r) => (
                  <box
                    onMouseUp={() =>
                      openMenu(r.id, r.label, r.manuallyDisabled)
                    }
                  >
                    <text
                      fg={
                        r.manuallyDisabled
                          ? color().textMuted
                          : r.current
                            ? color().primary
                            : color().text
                      }
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
                      {`      wk ${r.weeklyPct} (${r.weeklyReset}) · 5h ${r.hourlyPct} (${r.hourlyReset})`}
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
      // Panel in the session sidebar, next to Context / MCP / LSP. The host
      // hands this slot the current `session_id`, so the in-use marker can scope
      // to the VIEWER's session instead of the global last-selected account.
      sidebar_content(_ctx, props) {
        return <SidebarPanel api={api} sessionId={props.session_id} />
      },
    },
  }
}

/** Called from the `.ts` entry's `tui(api)` (TUI runtime only). */
export function registerSlots(api: TuiPluginApi): void {
  api.slots.register(makeSlots(api))
}
