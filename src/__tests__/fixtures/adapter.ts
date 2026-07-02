import type { ProviderAdapter } from '../../providers/types'

/**
 * Shared no-op ProviderAdapter test stub. Every field is an inert default;
 * callers override only what their test actually exercises (the refresh
 * family in stateful.test.ts, the URL-hitting `refresh` in the two-process
 * refresh worker). Lives in fixtures for the same reason as `testAccount`:
 * a future ProviderAdapter field addition is edited ONCE here, not once per
 * hand-rolled copy.
 */
export function fakeAdapter(
  over: Partial<ProviderAdapter> = {},
): ProviderAdapter {
  return {
    id: 'anthropic',
    authorize: async () => ({
      url: '',
      verifier: '',
      state: '',
      redirectUri: '',
    }),
    exchange: async () => null,
    refresh: async () => ({
      access: 'new',
      refresh: 'newref',
      expires: Date.now() + 3_600_000,
    }),
    applyAuth: () => undefined,
    transformUrl: (i) => i,
    transformBody: (b) => b,
    transformResponse: (r) => r,
    parseUsageHeaders: () => null,
    fetchUsage: async () => null,
    classifyError: () => 'ok',
    ...over,
  }
}
