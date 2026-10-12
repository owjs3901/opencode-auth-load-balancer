import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { Plugin } from '@opencode/plugin'
import { tool, type ToolDefinition } from '@opencode-ai/plugin/tool'

import { bootstrapFromOpencodeAuth } from './accounts'
import { AuthLoadBalancerStatusPlugin, buildAuthHook } from './legacy'
import { notifyPending, notifyPendingResumed, type ToastClient } from './notify'
import { PendingCoordinator } from './pending/coordinator'
import { createV2ResumeClient } from './pending/v2'
import { mutatePool, readPool } from './pool/store'
import { KIMI_CODE, KIMI_CODE_GLOBAL } from './providers/kimi/constants'
import { ADAPTERS } from './providers/registry'
import { ensureAccessToken } from './refresh'
import { loadConfig } from './scheduler/config'
import { MESSAGE_HEADER, SESSION_HEADER } from './session'
import { buildStatus } from './status'
import { MANUAL_DISABLED_REASON } from './types'
import { ignore, setBounded } from './util'
import { loadBalancerRpc } from './v2-rpc'

const packages: Record<string, string> = {
  // V2 rewrites known @ai-sdk names to native drivers. Local factory entries
  // retain the AISDK route and also satisfy the host's earlier dynamic hook.
  anthropic: `aisdk:${new URL('./sdk/anthropic.js', import.meta.url).href}`,
  openai: `aisdk:${new URL('./sdk/openai.js', import.meta.url).href}`,
  'kimi-code-plan-cn': `aisdk:${new URL('./sdk/kimi.js', import.meta.url).href}`,
  'kimi-code-plan-global': `aisdk:${new URL('./sdk/kimi.js', import.meta.url).href}`,
}

// The shared status tools use the pool and workspace captured at registration;
// they do not depend on a V1 execution context or permission callback.
type StatusToolDefinition = Omit<ToolDefinition, 'execute'> & {
  execute(input: Record<string, unknown>): ReturnType<ToolDefinition['execute']>
}

export async function setupV2(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  const rpc = await ctx.rpc.register(loadBalancerRpc, {
    status: async ({ sessionID }) => {
      const pool = await readPool()
      if (sessionID) {
        pool.lastSelected = Object.fromEntries(
          ADAPTERS.map((adapter) => [
            adapter.id,
            pool.sessions[`${adapter.id}:s:${sessionID}`]?.accountId ??
              pool.lastSelected[adapter.id] ??
              '',
          ]),
        )
      }
      return buildStatus(pool, Date.now(), loadConfig())
    },
    manage: async ({ account, action, name }) =>
      mutatePool((pool) => {
        const target = pool.accounts.find((value) => value.id === account)
        if (!target) throw new Error('Account no longer exists')
        if (action === 'rename') {
          const label = name?.trim()
          if (!label) throw new Error('New label must not be empty')
          if (
            pool.accounts.some(
              (value) => value.id !== account && value.label === label,
            )
          )
            throw new Error('Label is already used by another account')
          target.label = label
        } else if (action === 'delete') {
          pool.accounts = pool.accounts.filter((value) => value.id !== account)
          for (const [key, value] of Object.entries(pool.lastSelected)) {
            if (value === account) delete pool.lastSelected[key]
          }
          for (const [key, value] of Object.entries(pool.sessions)) {
            if (value.accountId === account) delete pool.sessions[key]
          }
        } else if (action === 'relogin') {
          pool.relogin = {
            accountId: account,
            providerID: target.providerID,
            expiresAt: Date.now() + 15 * 60_000,
          }
        } else if (action === 'clear-relogin') {
          if (pool.relogin?.accountId === account) delete pool.relogin
        } else {
          target.disabledReason =
            action === 'disable' ? MANUAL_DISABLED_REASON : null
        }
        return 'Updated account'
      }),
  })
  const client: ToastClient = {
    tui: { showToast: ({ body }) => rpc.events.emit('toast', body) },
  }
  const pending = new Map<string, PendingCoordinator>()
  const messageIDs = new Map<string, string>()
  const controller = new AbortController()
  // Reuse the status tools and their pool mutations in both host versions.
  const status = await AuthLoadBalancerStatusPlugin({
    directory: ctx.location.directory,
    worktree: ctx.location.directory,
  })

  try {
    for (const adapter of ADAPTERS) {
      const coordinator = new PendingCoordinator({
        workspace: ctx.location.directory,
        adapter,
        config: loadConfig(),
        dependencies: {
          onPending: (_ref, recovery) =>
            notifyPending(client, adapter.id, recovery),
          onResumed: () => notifyPendingResumed(client, adapter.id),
        },
      })
      pending.set(adapter.id, coordinator)
      const auth = buildAuthHook(adapter, client, coordinator)
      const integrationID = adapter.id
      const getAuth = async () => {
        const connection =
          await ctx.integration.connection.active(integrationID)
        const credential =
          connection && (await ctx.integration.connection.resolve(connection))
        if (!credential || credential.type === 'external')
          return { type: 'api' as const, key: '' }
        return credential.type === 'key'
          ? { type: 'api' as const, key: credential.key }
          : credential
      }
      await bootstrapFromOpencodeAuth(
        adapter.id,
        getAuth,
        adapter.tokensFromApiKey,
      )
      const pool = await readPool()
      let active = pool.accounts.some(
        (account) => account.providerID === adapter.id,
      )

      await ctx.integration.transform((editor) => {
        if (!editor.get(integrationID)) return
        auth.methods.forEach((method, index) => {
          if (method.type !== 'oauth') return
          const methodID = `auth-lb-${index}`
          editor.method.update({
            integrationID,
            method: { id: methodID, type: 'oauth', label: method.label },
            refresh: async (credential) => {
              const accounts = (await readPool()).accounts
              const account = accounts.find(
                (value) =>
                  value.providerID === adapter.id &&
                  (value.id === credential.metadata?.accountID ||
                    value.refresh === credential.refresh ||
                    value.access === credential.access),
              )
              if (!account) throw new Error('Pooled account no longer exists')
              await ensureAccessToken(adapter, account, Date.now())
              return {
                ...credential,
                access: account.access,
                refresh: account.refresh,
                expires: account.expires,
              }
            },
            authorize: async () => {
              const authorization = await method.authorize()
              const complete = async (code?: string) => {
                const result =
                  authorization.method === 'auto'
                    ? await authorization.callback()
                    : await authorization.callback(code ?? '')
                if (result.type !== 'success')
                  throw new Error('Account authorization failed')
                active = true
                await ctx.provider.reload()
                const access = 'key' in result ? result.key : result.access
                const account = (await readPool()).accounts.find(
                  (value) =>
                    value.providerID === adapter.id &&
                    (value.access === access ||
                      value.inferenceToken === access),
                )
                return {
                  type: 'oauth' as const,
                  methodID:
                    methodID as import('@opencode/plugin').Integration.MethodID,
                  access: 'key' in result ? result.key : result.access,
                  refresh: 'key' in result ? '' : result.refresh,
                  expires:
                    'key' in result ? Number.MAX_SAFE_INTEGER : result.expires,
                  metadata: account ? { accountID: account.id } : undefined,
                }
              }
              return authorization.method === 'auto'
                ? {
                    ...authorization,
                    mode: 'auto' as const,
                    callback: complete(),
                  }
                : {
                    ...authorization,
                    mode: 'code' as const,
                    callback: complete,
                  }
            },
          })
        })
      })

      await ctx.provider.transform((editor) => {
        if (!active) return
        const record = editor.get(adapter.id)
        if (!record) return
        editor.update(adapter.id, (provider) => {
          provider.package = packages[adapter.id]!
          // ModelResolver refreshes the provider's integration before loading
          // its SDK. Pooled requests must not depend on a stale single slot;
          // our fetch owns credential selection and singleflight refresh.
          provider.integrationID =
            `auth-load-balancer-${adapter.id}` as import('@opencode/plugin').Integration.ID
          if (active) provider.activation = 'enabled'
          provider.settings = { ...provider.settings, transport: 'http' }
        })
        for (const model of record.models.values()) {
          editor.models.update(adapter.id, model.id, (value) => {
            value.package = packages[adapter.id]!
          })
        }
      })
      await ctx.model.transform((editor) => {
        if (!active) return
        for (const model of editor.list(adapter.id)) {
          editor.update(adapter.id, String(model.id), (value) => {
            value.cost = []
            value.settings = { ...value.settings, transport: 'http' }
          })
        }
      })

      await ctx.aisdk.hook(
        'sdk',
        async (event) => {
          if (!active) return
          const models = (await ctx.model.list()).data.filter(
            (model) => model.providerID === adapter.id,
          )
          const loader = await auth.loader!(getAuth, {
            models: Object.fromEntries(
              models.map((model) => [
                model.id,
                {
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                },
              ]),
            ),
          } as Parameters<NonNullable<typeof auth.loader>>[1])
          const options = {
            ...event.options,
            apiKey: 'auth-load-balancer',
            fetch: loader.fetch,
          }
          event.sdk =
            adapter.id === 'anthropic'
              ? createAnthropic(options)
              : adapter.id === 'openai'
                ? createOpenAI(options)
                : createOpenAICompatible({
                    ...options,
                    name: adapter.id,
                    baseURL:
                      event.options.baseURL ??
                      (adapter.id === KIMI_CODE.id
                        ? KIMI_CODE.baseUrl
                        : KIMI_CODE_GLOBAL.baseUrl),
                  })
        },
        { providerID: adapter.id },
      )
      if (adapter.id === 'openai') {
        await ctx.aisdk.hook(
          'language',
          (event) => {
            if (!active) return
            // OAuth Codex requires Responses, never chat completions or sockets.
            event.language = event.sdk.responses(
              event.model.modelID ?? event.model.id,
            )
          },
          { providerID: adapter.id },
        )
      }
      await ctx.session.hook(
        'model.request',
        async (event) => {
          if (!active) return
          event.headers[SESSION_HEADER] = event.sessionID
          const messages =
            event.kind === 'primary'
              ? await ctx.session.context({ sessionID: event.sessionID })
              : []
          const messageID =
            event.kind === 'primary' &&
            (messages.findLast((message) => message.type === 'user')?.id ??
              messageIDs.get(event.sessionID))
          if (messageID) event.headers[MESSAGE_HEADER] = messageID
        },
        { providerID: adapter.id },
      )
      void coordinator.restore(createV2ResumeClient(ctx)).catch(ignore)
    }

    await ctx.session.hook('prompt', (event) => {
      setBounded(messageIDs, event.sessionID, event.messageID, 1024)
    })
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(
        status.tool as Record<string, StatusToolDefinition>,
      )) {
        editor.add({
          name,
          description: definition.description,
          input: tool.schema.object(definition.args),
          execute: async (input) => {
            const result = await definition.execute(input)
            return typeof result === 'string'
              ? { content: result }
              : { content: result.output, metadata: { title: result.title } }
          },
        })
      }
    })
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        if (
          event.type !== 'session.deleted' &&
          event.type !== 'session.execution.interrupted'
        )
          continue
        if (event.location?.directory !== ctx.location.directory) continue
        messageIDs.delete(event.data.sessionID)
        await Promise.all(
          [...pending.values()].map((value) =>
            value.removeSession(event.data.sessionID),
          ),
        )
      }
    })().catch(ignore)
  } catch (error) {
    controller.abort()
    await Promise.allSettled(
      [...pending.values()].map((value) => value.dispose()),
    )
    await status.dispose?.()
    throw error
  }

  return async () => {
    controller.abort()
    messageIDs.clear()
    await Promise.allSettled(
      [...pending.values()].map((value) => value.dispose()),
    )
    await status.dispose?.()
  }
}
