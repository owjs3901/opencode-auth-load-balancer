/**
 * opencode TUI plugin ENTRY for the load balancer's persistent bottom status bar.
 *
 * Why this is a `.ts` entry that lazily imports a `.tsx` view:
 *   - opencode discovers file plugins with the glob `{plugin,plugins}/*.{ts,js}`
 *     (packages/opencode/src/config/plugin.ts) — `.tsx` is NOT scanned, so a
 *     hand-authored `.tsx` is silently skipped and never loads.
 *   - opencode's TUI runtime registers the @opentui/solid JSX transform whose Bun
 *     onLoad filter is `/\.(js|ts)x$/` — i.e. it only transforms `.tsx`/`.jsx`.
 *     A `.ts` file therefore cannot itself contain JSX, but it CAN import a `.tsx`
 *     module, which the runtime transform compiles correctly.
 *   - The `.tsx` is imported LAZILY inside `tui()` (which only ever runs in the TUI
 *     runtime where the transform is registered), so the server plugin worker never
 *     evaluates the SolidJS/@opentui module graph.
 *
 * Install: copy BOTH this file and `auth-load-balancer-tui.view.tsx` into
 * `~/.config/opencode/plugins/` (or a project `.opencode/plugins/`) and restart.
 */
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'

const tui: TuiPlugin = async (api) => {
  // Lazy so the server worker (no Solid transform) never imports the .tsx graph.
  const { registerSlots } = await import('./auth-load-balancer-tui.view.tsx')
  registerSlots(api)
}

const plugin: TuiPluginModule & { id: string } = {
  id: 'auth-load-balancer-tui',
  tui,
}

export default plugin
