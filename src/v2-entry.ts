import type { Plugin } from '@opencode/plugin'

export default {
  id: 'opencode-auth-load-balancer',
  async setup(ctx: Plugin.Context) {
    const { setupV2 } = await import('./v2')
    return setupV2(ctx)
  },
}
