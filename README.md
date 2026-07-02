# opencode-auth-load-balancer

Load-balance [opencode](https://opencode.ai) across **multiple Claude (Anthropic) and Codex (OpenAI/ChatGPT) OAuth accounts** so you never have to stop and re-login when one account runs out of quota.

Selection is **not** round-robin. It is weighted primarily by **weekly** usage, with a continuous "drain the soonest-resetting account first" rule, per-conversation **session affinity** (to preserve prompt caching), and a proactive switch **before** an account hits 100%.

---

## Features

- **Account pool** — register many Claude / Codex OAuth accounts; the plugin manages and rotates them.
- **Weekly-usage-weighted scheduling** — `urgency = weeklyRemaining / daysUntilWeeklyReset`. A sooner reset (e.g. 3 days) outranks a later one (7 days) at equal headroom; perishable quota is drained progressively, never crammed into the final hour.
- **Automatic rotation** — on `429`/auth errors an account is cooled down and the next-best is tried; `retry-after` is honored.
- **Session affinity** — a conversation stays pinned to one account so you keep its prompt cache and don't re-send context on every turn.
- **Proactive migration** — leaves an account at a configurable soft threshold (~95%) instead of waiting for a hard 100% wall (which can break in-flight subagents).
- **Single-use refresh-token safety** — per-account singleflight refresh; rotated tokens are persisted immediately.
- **Visibility** — a toast when the in-use account switches, an on-demand `auth_lb_status` tool, and a `bun run status` CLI dashboard.

---

## Requirements

- [Bun](https://bun.com) ≥ 1.3
- opencode (TUI), with the Anthropic and/or OpenAI providers available

---

## Install & build

```bash
bun install
bun run build      # → dist/index.js (a single self-contained file)
```

The bundle imports only Node built-ins, so it can be dropped into opencode as one file.

### Load it into opencode (local / dev)

opencode auto-loads any `.ts`/`.js` file in a **plugins directory**:

- `.opencode/plugins/` — project-level (recommended; unambiguous on every OS)
- `~/.config/opencode/plugins/` — global

Copy or symlink the built bundle into your opencode project's plugin dir:

```bash
# macOS / Linux — symlink so rebuilds are picked up automatically
mkdir -p .opencode/plugins
ln -sf "$(pwd)/dist/index.js" .opencode/plugins/auth-load-balancer.js
```

```powershell
# Windows (PowerShell) — copy (symlinks need Developer Mode / admin)
New-Item -ItemType Directory -Force -Path .opencode\plugins | Out-Null
Copy-Item dist\index.js .opencode\plugins\auth-load-balancer.js
```

Restart opencode to load it. (opencode does **not** hot-reload plugins — see the dev loop below.)

### Install it from npm (once published)

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-auth-load-balancer"]
}
```

opencode installs the package and its dependencies automatically at startup.

---

## Register your accounts

Run opencode's auth flow once **per account**:

1. `opencode auth login`
2. Choose **"Claude Pro/Max (add account to load balancer)"** (or **"ChatGPT/Codex …"**).
3. Open the URL, authorize, and paste the resulting code/URL back.
4. Repeat for every account you want in the pool.

Each login **appends** to the pool (it does not overwrite opencode's single auth slot). If you already logged in with the upstream `opencode-anthropic-auth` plugin, that credential is imported automatically on first run.

The pool lives in a JSON file you can inspect/edit (e.g. to rename labels):

| When | Path |
|------|------|
| Default (**every** OS, incl. Windows) | `~/.local/share/opencode/auth-load-balancer.json` |
| `$XDG_DATA_HOME` set | `$XDG_DATA_HOME/opencode/auth-load-balancer.json` |

opencode resolves its data dir via `xdg-basedir`, which is platform-agnostic — it does **not** use `%LOCALAPPDATA%` on Windows or `Application Support` on macOS (verified with `opencode debug paths`).

> **OpenAI/Codex note:** the OpenAI path assumes opencode is configured to use the **Responses API** (the standard ChatGPT/Codex setup); `/responses` requests are routed to the Codex backend.

---

## See which account is in use

Three surfaces, in increasing detail:

1. **Toast on switch** — when the in-use account changes, opencode shows a toast: `Claude account ▶ claude-work · weekly 45% · 5h 10%`.
2. **`auth_lb_status` tool** — ask the agent to "show auth load balancer status"; it prints the full dashboard in chat.
3. **CLI** — run it directly in a terminal:

```bash
bun run status
```

```text
Claude — in use: claude-personal
  #  account            weekly   5h   resets   state
  1    claude-work        45%   10%    2d2h  ready
  2  ▶ claude-personal    72%   38%    1d6h  in use
  3    claude-burner     100%     -     30m  exhausted

Codex — in use: chatgpt-plus
  #  account            weekly   5h   resets   state
  1  ▶ chatgpt-plus       20%    5%   3d18h  in use
```

`▶` marks the in-use account; `#` is the rank the scheduler would pick next.

### Persistent bottom status bar (TUI)

A SolidJS TUI plugin renders a persistent bottom status bar (opencode's always-visible `app_bottom` slot) showing both the in-use account(s) per provider (polled from the pool, e.g. `Claude anthropic-1 58% · 5h 12%`) **and** the current session usage — tokens, % of the model context window, and `$` cost — computed the same way opencode's own footer does. It is **three files**:

| File | Role |
|------|------|
| [`tui/auth-load-balancer-tui.ts`](tui/auth-load-balancer-tui.ts) | Plugin **entry** (no JSX). Registered in `tui.json` (below). Inside `tui()` it **lazily** imports the view. |
| [`tui/auth-load-balancer-tui.view.tsx`](tui/auth-load-balancer-tui.view.tsx) | The SolidJS **view** (JSX). Compiled by opencode's TUI runtime Solid transform, whose loader matches `*.{tsx,jsx}`. |
| [`tui/auth-load-balancer-scoring.ts`](tui/auth-load-balancer-scoring.ts) | A byte-identical copy of [`src/scheduler/score-core.ts`](src/scheduler/score-core.ts) (kept in sync by `bun run build` + a test) so the dashboard ranks accounts with the **exact same** scorer as the server — never a drifting re-implementation. |

Install the three files into a directory the **server does not scan** (anything other than `plugin/` / `plugins/`) and register the entry in `tui.json`:

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/tui-plugins
cp tui/auth-load-balancer-tui.ts tui/auth-load-balancer-tui.view.tsx tui/auth-load-balancer-scoring.ts ~/.config/opencode/tui-plugins/
```

```powershell
# Windows
New-Item -ItemType Directory -Force -Path $env:USERPROFILE\.config\opencode\tui-plugins | Out-Null
Copy-Item tui\auth-load-balancer-tui.ts,tui\auth-load-balancer-tui.view.tsx,tui\auth-load-balancer-scoring.ts $env:USERPROFILE\.config\opencode\tui-plugins\
```

Then register the entry in `~/.config/opencode/tui.json` (this is how opencode loads TUI plugins) and restart:

```jsonc
{
  "plugin": [
    "file:///absolute/path/to/.config/opencode/tui-plugins/auth-load-balancer-tui.ts"
  ]
}
```

> **Why this shape (it matters):** TUI plugins load from the `plugin` array in `tui.json`, **not** from the server's plugins-dir glob. The server *separately* globs `{plugin,plugins}/*.{ts,js}` and loads every match as a **server** plugin — so a TUI entry dropped in `plugins/` is also loaded by the server, rejected (`must default export … server()`), and logs an error on **every** launch (and a stray scoring `.ts` there would be mis-loaded as a plugin and break provider resolution). Keeping the three files OUTSIDE `plugins/` and registering only via `tui.json` avoids that. The split into a `.ts` **entry** that **lazily imports** a `.tsx` **view** is still required because opencode's runtime SolidJS JSX transform (`@opentui/solid`) only matches `*.{tsx,jsx}` — a `.ts` cannot itself contain JSX, and the lazy import keeps the server plugin worker (which never runs `tui()`) from evaluating the SolidJS module graph. Verified against opencode / `@opencode-ai/plugin` **v1.17.9** + `@opentui/solid` 0.3.4. The `.tsx` view **is** typechecked (`tsconfig.tui.json`) and linted here — its JSX deps (`solid-js` + `@opentui/*`) are installed as devDependencies pinned to those versions — so type/import/prop breaks are caught in CI; only its runtime rendering still needs a live opencode TUI to verify. The toast + `auth_lb_status` tool + `bun run status` CLI cover the same information regardless.

---

## Configuration

All knobs are environment variables with sane defaults.

| Variable | Default | Meaning |
|----------|---------|---------|
| `OPENCODE_AUTH_LB_HOURLY_INFLUENCE` | `0.5` | How much 5h headroom modulates the weekly-urgency score (0–1). |
| `OPENCODE_AUTH_LB_MIN_RESET_MS` | `300000` | Floor on time-to-reset (caps urgency near a reset). |
| `OPENCODE_AUTH_LB_WEEK_WINDOW_MS` | `604800000` | Baseline horizon used when a weekly reset time is unknown. |
| `OPENCODE_AUTH_LB_EXHAUSTED_AT` | `0.999` | Hard exhaustion: at/above this utilization an account is excluded. |
| `OPENCODE_AUTH_LB_MIGRATE_AT` | `0.95` | Soft threshold to proactively leave a pinned account (before 100%). |
| `OPENCODE_AUTH_LB_WEEKLY_DRAIN_TARGET` | `0.98` | Soft threshold for the WEEKLY window: scoring treats weekly quota as "fully drained" past this utilization, and a pinned session proactively migrates once its weekly util crosses it. The 5h window uses `MIGRATE_AT` (~0.95); the weekly window uses this (~0.98). Must be in (`MIGRATE_AT`, `EXHAUSTED_AT`]. |
| `OPENCODE_AUTH_LB_CHEAP_SWITCH_MAX_BYTES` | `65536` | For non-forced (proactive/drain) switches, only switch when the request body ≤ this many bytes, so a grown conversation isn't re-sent onto a fresh (uncached) account — a full per-account prompt-cache write. `0` disables the gate (always switch). A proactive switch bypasses this gate when the pinned account is within ~1% of hard exhaustion (a forced switch is imminent anyway and the context only grows); forced switches always ignore it. |
| `OPENCODE_AUTH_LB_DRAIN_MIGRATE` | `false` | Allow switching a healthy session to drain another account whose weekly window is about to reset. |
| `OPENCODE_AUTH_LB_DRAIN_MIGRATE_MARGIN` | `1.5` | Urgency factor required to justify a drain switch. |
| `OPENCODE_AUTH_LB_SESSION_TTL_MS` | `21600000` | Session→account assignments older than this are pruned. |
| `OPENCODE_AUTH_LB_MAX_WAIT_MS` | `305000` | When **every** account is rate-limited (a `429`/`402` cooldown), how long a single request may **block** waiting for the soonest account's cooldown to expire (honoring `Retry-After`) before auto-retrying — instead of failing the turn abruptly. A client abort (cancelling the turn) interrupts the wait immediately. Must exceed the 5-min account cooldown to cover a `429` with no `Retry-After`. `0` disables waiting (fail fast). Auth (`401`/`403`) errors are never waited on. |
| `OPENCODE_AUTH_LB_DIR` | — | Override the pool-file directory (handy for tests). |
| `OPENCODE_AUTH_LB_DEBUG` | — | `1`/`true` logs each selection to stderr. |
| `ANTHROPIC_BASE_URL` | — | Route Anthropic requests through a custom base URL. |

---

## Development

### Scripts

| Script | What it does |
|--------|--------------|
| `bun run build` | Bundle `src/index.ts` → `dist/index.js` + emit `.d.ts`. |
| `bun run dev` | Rebuild the bundle on every change (watch). |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run lint` | Lint with oxlint (DevFive shared config). |
| `bun run lint:fix` | Auto-fix lint + formatting. |
| `bun test` | Run the suite **with 100% coverage enforced**. |
| `bun run test:watch` | Re-run tests on change. |
| `bun run status` | Print the dashboard for the current pool. |

### Linting & formatting

[oxlint](https://oxc.rs) with the DevFive shared config — `oxlint.config.ts` re-exports `eslint-plugin-devup/oxlint-config` (single quotes, no semicolons, sorted imports, `interface` over `type`). A husky `pre-commit` hook runs `bun lint`.

```bash
bun run lint        # check
bun run lint:fix    # auto-fix
```

### Testing

```bash
bun test
```

The unit/integration suite runs with coverage **gated at 100%** (lines and functions) via `bunfig.toml`. They mock the network and isolate the pool file per test, so **no real accounts are needed** to test the logic. Tests live in `src/__tests__/`.

### Dev loop (trying it in a real opencode)

opencode loads plugins once at startup, so the loop is:

1. `bun run dev` — keeps `dist/index.js` rebuilt on every edit.
2. Symlink `dist/index.js` into your opencode project's `.opencode/plugins/` once (see install above).
3. Edit code → the watcher rebuilds → **restart opencode** to reload the plugin.
4. Use it; watch the toasts, run `bun run status`, and set `OPENCODE_AUTH_LB_DEBUG=1` to log selections.

### Project structure

```
src/
  index.ts              # plugin entry: 3 exports (Anthropic, OpenAI, Status-tool)
  fetch.ts              # load-balanced fetch — the per-request choke point
  refresh.ts            # singleflight OAuth refresh, invalid_grant handling
  accounts.ts           # append / bootstrap accounts into the pool
  session.ts            # derive a stable session key (affinity)
  types.ts              # provider-agnostic data model (accounts, usage windows, pool file)
  usage-merge.ts        # fixed weekly-anchor preservation / roll-forward
  util.ts               # shared helpers (sleep, clamp01, JSON guards)
  status.ts             # ranked status model + text renderer
  notify.ts             # toast on account switch
  usage-refresh.ts      # cold-start usage seeding via the usage endpoint
  prime.ts              # point the in-use marker at the top-ranked account at startup
  scheduler/            # config, score-core (shared scorer), select
  pool/                 # data-dir resolution + atomic, serialized pool store
  providers/            # ProviderAdapter contract + headers
    anthropic/          #   Claude OAuth + Claude Code request transforms + usage
    openai/             #   ChatGPT/Codex OAuth + Responses transforms + usage
  cli/status.ts         # `bun run status`
  __tests__/            # all tests
tui/
  auth-load-balancer-tui.ts       # TUI plugin ENTRY (registered in tui.json; no JSX)
  auth-load-balancer-tui.view.tsx # SolidJS view (lazily imported; app_bottom + sidebar slots)
  auth-load-balancer-scoring.ts   # byte copy of src/scheduler/score-core.ts (shared scorer)
```

---

## How it works

opencode lets an auth plugin's `loader` return a custom `fetch` that **every** request for a provider flows through. That single choke point ([`src/fetch.ts`](src/fetch.ts)) is where the magic happens, per request:

1. derive a session key (from opencode's session id, or a hash of the request prefix);
2. pick the session's pinned account — or, if it's unavailable / over the soft threshold, the highest **weekly-urgency** account ([`src/scheduler/select.ts`](src/scheduler/select.ts));
3. refresh the OAuth token if needed (singleflight, rotated token persisted);
4. apply provider-specific auth + request transforms (Claude Code identity / Codex Responses quirks);
5. send the request, then record usage from the response headers;
6. on `429`/auth errors, cool the account down and try the next; on success, re-pin the session and toast if the account changed.

The pool is its own JSON file (opencode's native auth store holds only one credential per provider), written atomically and serialized by an in-process mutex.

---

## Limitations

- **Bottom status bar** ([`tui/auth-load-balancer-tui.ts`](tui/auth-load-balancer-tui.ts) + [`.view.tsx`](tui/auth-load-balancer-tui.view.tsx) + [`auth-load-balancer-scoring.ts`](tui/auth-load-balancer-scoring.ts)) is a SolidJS TUI artifact compiled by opencode (its JSX deps — `solid-js` + `@opentui/*` — are installed as devDependencies, so the `.tsx` view **is** typechecked via `tsconfig.tui.json` and linted, though not render-tested here since that needs a live opencode TUI; its scorer is a byte-identical copy of the unit-tested [`src/scheduler/score-core.ts`](src/scheduler/score-core.ts), enforced by a sync test). It is written against opencode 1.17.9 internals (the `app_bottom` slot + the `subagent-footer` usage computation, verified against source); confirm it renders in your opencode build. The toast/tool/CLI cover the account info regardless.
- **OpenAI/Codex** assumes the Responses API; chat-completions → responses conversion is out of scope.
- **Cross-process refresh**: per-process singleflight protects token rotation within one opencode instance. Running two opencode instances at once could still race the single-use refresh token.
- **TUI pool writes**: the TUI sidebar's Rename / Delete actions write the pool file atomically (temp + rename) but WITHOUT the cross-process file lock the server uses around its own read-modify-write — so a server usage / cooldown / session / `tokenGen` update committed between the TUI's `readFileSync` and `renameSync` can be silently overwritten. Impact is bounded: the next request re-records usage from response headers, so the window is one cycle of staleness on the affected account; correctness recovers on its own.
- Live OAuth/login and real-account end-to-end behavior should be smoke-tested in your environment; the test suite mocks the network.

---

## License

MIT
