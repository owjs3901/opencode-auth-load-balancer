import type { AuthHook, Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

import {
  addAccount,
  bootstrapFromOpencodeAuth,
  type OpencodeAuthGetter,
} from './accounts'
import { createLoadBalancedFetch } from './fetch'
import { notifyOnSwitch, type ToastClient } from './notify'
import { mutatePool } from './pool/store'
import { primeInUse } from './prime'
import { anthropicAdapter } from './providers/anthropic/adapter'
import { openaiAdapter } from './providers/openai/adapter'
import type { ProviderAdapter } from './providers/types'
import { SESSION_HEADER } from './session'
import { readStatus, renderStatus } from './status'
import { refreshUsageInBackground } from './usage-refresh'
import { ignore } from './util'

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Claude Pro/Max',
  openai: 'ChatGPT/Codex',
}

interface LoaderProvider {
  models: Record<string, { cost: unknown }>
}

/** Subscription plans are flat-rate; zero out per-token cost so opencode shows $0. */
function zeroOutCost(provider: LoaderProvider): void {
  for (const model of Object.values(provider.models)) {
    model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
  }
}

/**
 * Build an opencode auth hook for one provider:
 *  - `loader`: seeds the pool from any existing opencode credential, then returns
 *    the load-balanced fetch so every request flows through the scheduler.
 *  - `methods`: a "Claude Pro/Max" style OAuth login that APPENDS each account to
 *    the pool (instead of overwriting opencode's single auth slot).
 */
function buildAuthHook(
  adapter: ProviderAdapter,
  client: ToastClient,
): AuthHook {
  const label = PROVIDER_LABELS[adapter.id] ?? adapter.id
  return {
    provider: adapter.id,
    async loader(getAuth: OpencodeAuthGetter, provider: LoaderProvider) {
      await bootstrapFromOpencodeAuth(adapter.id, getAuth)
      zeroOutCost(provider)
      // Seed usage for this provider's accounts at startup so the dashboard shows usage
      // even for a provider you don't immediately request (e.g. Codex while you work in
      // Claude); then point the in-use marker at the top-ranked account — startup is a
      // clean-context moment (no session pinned yet) so the next request picks it anyway.
      void refreshUsageInBackground(adapter, Date.now())
        .then(() => primeInUse(adapter.id, Date.now()))
        .catch(ignore)
      return {
        apiKey: '',
        fetch: createLoadBalancedFetch(adapter, {
          onUse: (providerID, account) => {
            void notifyOnSwitch(client, providerID, account)
          },
        }),
      }
    },
    methods: [
      {
        label: `${label} (add account to load balancer)`,
        type: 'oauth' as const,
        authorize: async () => {
          const result = await adapter.authorize()
          return {
            url: result.url,
            instructions: 'Paste the authorization code here:',
            method: 'code' as const,
            callback: async (code: string) => {
              const tokens = await adapter.exchange(
                code,
                result.verifier,
                result.redirectUri,
                result.state,
              )
              if (!tokens) return { type: 'failed' as const }
              await addAccount(adapter.id, tokens)
              // Seed the just-registered account's usage right away — awaited so the
              // dashboard shows usage immediately after login (no extra latency on the
              // request path; this is the one-time login flow). Throttled inside.
              await refreshUsageInBackground(adapter, Date.now()).catch(ignore)
              return {
                type: 'success' as const,
                refresh: tokens.refresh,
                access: tokens.access,
                expires: tokens.expires,
              }
            },
          }
        },
      },
    ],
  }
}

/**
 * Wrap an adapter as an opencode Plugin. opencode picks up every exported Plugin
 * function from the package, so one provider == one exported plugin.
 *
 * Hooks:
 *  - `auth`: registers the load-balanced fetch + login method (see buildAuthHook).
 *  - `chat.headers`: stamps the real opencode session id onto each request so the
 *    fetch can keep a conversation pinned to one account (prompt-cache affinity).
 *    The fetch strips this header before the request leaves for the provider.
 */
function createProviderPlugin(adapter: ProviderAdapter): Plugin {
  return async (input) => {
    // opencode's SDK client is a superset of the small toast slice we use.
    const client = input.client as unknown as ToastClient
    return {
      auth: buildAuthHook(adapter, client),
      'chat.headers': async (hook, output) => {
        if (hook.model.providerID !== adapter.id) return
        if (hook.sessionID) output.headers[SESSION_HEADER] = hook.sessionID
      },
    }
  }
}

export const AnthropicLoadBalancerPlugin =
  createProviderPlugin(anthropicAdapter)
export const OpenAILoadBalancerPlugin = createProviderPlugin(openaiAdapter)

/**
 * A standalone plugin that registers the `auth_lb_status` tool — an on-demand
 * dashboard (in-use account per provider, each account's weekly/5h usage,
 * cooldowns, and the ranked next candidates) across ALL providers. Registered once
 * (not per provider) so the tool name doesn't collide.
 */
export const AuthLoadBalancerStatusPlugin: Plugin = async () => ({
  tool: {
    auth_lb_status: tool({
      description:
        "Show the auth load-balancer pool: the in-use account per provider, each account's weekly and 5h usage, cooldowns, and the ranked next-candidate accounts.",
      args: {},
      execute: async () => ({
        title: 'Auth Load Balancer',
        output: renderStatus(await readStatus()),
      }),
    }),
    auth_lb_rename: tool({
      description:
        'Rename a pooled account. Match the account by its current label or its id, then set a new label. The new label appears in the switch toast, the auth_lb_status dashboard, and the TUI bar/sidebar.',
      args: {
        account: tool.schema
          .string()
          .describe('Current label or id of the account to rename'),
        name: tool.schema.string().describe('New label for the account'),
      },
      execute: async ({ account, name }) => {
        const result = await mutatePool((pool) => {
          const target = pool.accounts.find(
            (a) => a.id === account || a.label === account,
          )
          if (!target)
            return {
              ok: false as const,
              labels: pool.accounts.map((a) => `${a.label} (${a.providerID})`),
            }
          const previous = target.label
          target.label = name
          return { ok: true as const, previous }
        })
        if (!result.ok)
          return {
            title: 'Auth Load Balancer',
            output: `No account matching "${account}". Available: ${
              result.labels.join(', ') || '(none)'
            }`,
          }
        return {
          title: 'Auth Load Balancer',
          output: `Renamed "${result.previous}" → "${name}".`,
        }
      },
    }),
  },
})
