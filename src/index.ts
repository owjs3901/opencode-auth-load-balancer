import type { AuthHook, Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

import {
  addAccount,
  bootstrapFromOpencodeAuth,
  type OpencodeAuthGetter,
} from './accounts'
import { createLoadBalancedFetch } from './fetch'
import { notifyModelFallback, notifyOnSwitch, type ToastClient } from './notify'
import { mutatePool, readPool } from './pool/store'
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

interface ModelCost {
  input: number
  output: number
  cache: { read: number; write: number }
}

interface LoaderProvider {
  models: Record<string, { cost: ModelCost }>
}

/** Subscription plans are flat-rate; zero out per-token cost so opencode shows $0. */
function zeroOutCost(provider: LoaderProvider): void {
  for (const model of Object.values(provider.models)) {
    model.cost = {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    }
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
          onModelFallback: (providerID, account, fromModel, toModel) => {
            void notifyModelFallback(
              client,
              providerID,
              account,
              fromModel,
              toModel,
            )
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

/** The tool-result shape shared by every auth_lb_* tool response below. */
const lbResult = (output: string) => ({ title: 'Auth Load Balancer', output })

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
        "Show the auth load-balancer pool: the in-use account per provider, each account's weekly and 5h usage, cooldowns, and the ranked next-candidate accounts. Refreshes stale usage from the provider usage endpoints (throttled) before rendering.",
      args: {},
      execute: async () => {
        // The pool only converges to server-side truth via response headers (needs
        // model requests in flight) or the usage-endpoint poll (request-path /
        // startup only). Checking the dashboard is exactly when a user wants an
        // out-of-band change — e.g. Anthropic's promotional weekly-quota reset —
        // reflected NOW, so poll stale accounts here too. AWAITED so the freshly
        // fetched numbers are in THIS render; the internal SEED_TTL/lastPoll
        // throttle keeps repeat calls cheap, and failures fall back to the
        // last-known snapshot (never fail the dashboard).
        const now = Date.now()
        // ONE serialized pool read shared by both refresh calls: without the
        // snapshot each call performs its own readPool() just for the
        // staleness gates (the actual usage write still goes through
        // mutatePool, which re-reads under the lock). The final readStatus
        // below re-reads regardless, so freshly polled numbers still render.
        const pool = await readPool()
        await Promise.all(
          [anthropicAdapter, openaiAdapter].map((adapter) =>
            refreshUsageInBackground(adapter, now, pool).catch(ignore),
          ),
        )
        // ONE clock for ranking (readStatus → available/rank/displayUtil) AND
        // rendering (renderStatus → stateOf/relTime): two separate Date.now()
        // stamps let an account whose cooldown expires between them rank as
        // unavailable yet render `exhausted` instead of `cooldown …`, and skew
        // countdowns from the ranks printed beside them. Taken AFTER the
        // awaited refresh so the freshly polled numbers are in this render.
        const renderedAt = Date.now()
        return lbResult(renderStatus(await readStatus(renderedAt), renderedAt))
      },
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
        // An empty label renders blank in the toast/dashboard/TUI and can never
        // be matched by label again — reject before touching the pool.
        const trimmed = name.trim()
        if (!trimmed) return lbResult('New label must not be empty.')
        const result = await mutatePool((pool) => {
          const target = pool.accounts.find(
            (a) => a.id === account || a.label === account,
          )
          if (!target)
            return {
              ok: false as const,
              reason: 'missing' as const,
              labels: pool.accounts.map((a) => `${a.label} (${a.providerID})`),
            }
          // Duplicate labels make rename-by-label ambiguous (the first match
          // wins), so refuse to create a second account with the same label.
          if (
            pool.accounts.some((a) => a.id !== target.id && a.label === trimmed)
          )
            return { ok: false as const, reason: 'taken' as const }
          const previous = target.label
          target.label = trimmed
          return { ok: true as const, previous }
        })
        if (!result.ok)
          return lbResult(
            result.reason === 'taken'
              ? `Label "${trimmed}" is already used by another account.`
              : `No account matching "${account}". Available: ${
                  result.labels.join(', ') || '(none)'
                }`,
          )
        return lbResult(`Renamed "${result.previous}" → "${trimmed}".`)
      },
    }),
  },
})
