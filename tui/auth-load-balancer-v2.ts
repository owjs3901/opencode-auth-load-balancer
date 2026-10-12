import type { Plugin } from '@opencode/plugin/tui'

export default {
  id: 'auth-load-balancer-tui',
  async setup(ctx: Plugin.Context) {
    // The host installs its Solid transform before evaluating this view.
    const { registerV2Slots } = await import('./auth-load-balancer-v2.view.tsx')
    return registerV2Slots(ctx)
  },
}
