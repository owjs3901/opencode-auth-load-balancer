import { z } from 'zod'

const accountStatus = z.object({
  id: z.string(),
  label: z.string(),
  weeklyUtil: z.number().nullable(),
  hourlyUtil: z.number().nullable(),
  weeklyResetAt: z.number(),
  available: z.boolean(),
  cooldownUntil: z.number(),
  modelCooldownsUntil: z.record(z.string(), z.number()),
  disabledReason: z.string().nullable(),
  login: z.string(),
  warnings: z.array(z.string()),
  lostNotes: z.array(z.string()),
  current: z.boolean(),
  rank: z.number(),
})

/** Display and management API; its status output never contains credentials. */
export const loadBalancerRpc = {
  id: 'auth-load-balancer',
  methods: {
    status: {
      input: z.object({ sessionID: z.string().optional() }),
      output: z.array(
        z.object({ providerID: z.string(), accounts: z.array(accountStatus) }),
      ),
    },
    manage: {
      input: z.object({
        account: z.string(),
        action: z.enum([
          'rename',
          'disable',
          'enable',
          'delete',
          'relogin',
          'clear-relogin',
        ]),
        name: z.string().optional(),
      }),
      output: z.string(),
    },
  },
  events: {
    toast: {
      schema: z.object({
        title: z.string().optional(),
        message: z.string(),
        variant: z.enum(['info', 'success', 'warning', 'error']),
        duration: z.number().optional(),
      }),
    },
  },
} as const

export type ProviderStatus = z.infer<
  typeof loadBalancerRpc.methods.status.output
>[number]
