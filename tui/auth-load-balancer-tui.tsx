/** @jsxImportSource @opentui/solid */
/**
 * opencode TUI plugin — a persistent right-of-prompt indicator that shows the load
 * balancer's in-use account(s) per provider (the "right toolbar").
 *
 * It reads the same pool file the server plugin writes, so it follows account
 * switches; it polls on an interval. Loaded ONLY by opencode's TUI runtime
 * (`kind: "tui"`): the server plugin loader skips this file because it default-
 * exports `tui`, not `server`. Verified against opencode / @opencode-ai/plugin
 * v1.17.9 + @opentui/solid 0.3.4 (slot signature `(ctx, props)`, ctx.theme first;
 * `<text fg={RGBA}>` and inline `<span style={{ fg: RGBA }}>` per the upstream
 * tui-smoke.tsx reference). JSX is compiled by opencode's own TUI runtime.
 *
 * Install: copy this file into `~/.config/opencode/plugins/` (or a project
 * `.opencode/plugins/`) and restart opencode.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSignal, onCleanup } from 'solid-js'
import type {
  TuiPlugin,
  TuiPluginModule,
  TuiSlotContext,
  TuiSlotPlugin,
} from '@opencode-ai/plugin/tui'

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
}
const POLL_MS = 3000

/** Resolve the load balancer's pool file (mirrors src/pool/paths.ts; self-contained). */
function poolFile(): string {
  const override = process.env.OPENCODE_AUTH_LB_DIR?.trim()
  if (override) return join(override, 'auth-load-balancer.json')
  const xdg = process.env.XDG_DATA_HOME?.trim()
  if (xdg) return join(xdg, 'opencode', 'auth-load-balancer.json')
  // xdg-basedir default — same on every OS (opencode does not use %LOCALAPPDATA%).
  return join(homedir(), '.local', 'share', 'opencode', 'auth-load-balancer.json')
}

interface PoolShape {
  accounts?: {
    id: string
    label: string
    usage?: {
      weekly?: { utilization?: number } | null
      hourly?: { utilization?: number } | null
    } | null
  }[]
  lastSelected?: Record<string, string>
}

interface InUse {
  name: string
  label: string
  weekly: string
  hourly: string
}

function pct(u: number | null | undefined): string {
  return typeof u === 'number' ? `${Math.round(u * 100)}%` : '-'
}

/** The in-use account per provider, read from the pool file. Empty if none/unreadable. */
function readInUse(): InUse[] {
  let pool: PoolShape
  try {
    pool = JSON.parse(readFileSync(poolFile(), 'utf8')) as PoolShape
  } catch {
    return []
  }
  const accounts = pool.accounts ?? []
  const out: InUse[] = []
  for (const [provider, id] of Object.entries(pool.lastSelected ?? {})) {
    const account = accounts.find((a) => a.id === id)
    if (!account) continue
    out.push({
      name: PROVIDER_NAMES[provider] ?? provider,
      label: account.label,
      weekly: pct(account.usage?.weekly?.utilization),
      hourly: pct(account.usage?.hourly?.utilization),
    })
  }
  return out
}

/**
 * The indicator component; polls the pool on an interval so it follows switches.
 * Runs inside a Solid reactive root, so `onCleanup` correctly clears the timer.
 */
function Indicator(props: { theme: TuiSlotContext['theme'] }) {
  const [inUse, setInUse] = createSignal(readInUse())
  const timer = setInterval(() => setInUse(readInUse()), POLL_MS)
  onCleanup(() => clearInterval(timer))
  return (
    <box flexDirection="row" gap={2}>
      {inUse().map((a) => (
        <text fg={props.theme.current.textMuted}>
          <span style={{ fg: props.theme.current.primary }}>{a.name}</span>{' '}
          {a.label} {a.weekly} · 5h {a.hourly}
        </text>
      ))}
    </box>
  )
}

/**
 * Slot render functions. Signature is `(ctx, props)` — the theme context is the
 * FIRST argument (slot-specific props such as `{ session_id }` are the second).
 */
function balancerSlot(): TuiSlotPlugin {
  return {
    slots: {
      home_prompt_right(ctx) {
        return <Indicator theme={ctx.theme} />
      },
      session_prompt_right(ctx) {
        return <Indicator theme={ctx.theme} />
      },
    },
  }
}

const tui: TuiPlugin = async (api) => {
  api.slots.register(balancerSlot())
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'auth-load-balancer-tui',
  tui,
}

export default plugin
