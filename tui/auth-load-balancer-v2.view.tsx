/** @jsxImportSource @opentui/solid */
import type { Plugin } from '@opencode/plugin/tui'
import { createSignal, For, onCleanup, Show } from 'solid-js'

import { loadBalancerRpc, type ProviderStatus } from './auth-load-balancer-rpc'

const names: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'Codex',
  'kimi-code-plan-cn': 'Kimi',
  'kimi-code-plan-global': 'Kimi (kimi.ai)',
}
const pct = (value: number | null) =>
  value === null ? '?' : `${Math.round(value * 100)}%`

function StatusView(props: {
  ctx: Plugin.Context
  sessionID?: string
  compact?: boolean
}) {
  const rpc = props.ctx.client.rpc(loadBalancerRpc)
  const [providers, setProviders] = createSignal<ProviderStatus[]>([])
  const [error, setError] = createSignal('')
  let disposed = false
  const [refreshing, setRefreshing] = createSignal(false)
  const refresh = async () => {
    if (refreshing()) return
    setRefreshing(true)
    try {
      const result = await rpc.status(
        { sessionID: props.sessionID },
        { location: props.ctx.location },
      )
      if (!disposed) {
        setProviders(result)
        setError('')
      }
    } catch {
      if (!disposed) setError('Auth Load Balancer unavailable')
    } finally {
      setRefreshing(false)
    }
  }
  const timer = setInterval(() => void refresh(), 3000)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
  })
  void refresh()

  const login = async (
    provider: ProviderStatus,
    account: ProviderStatus['accounts'][number],
  ) => {
    const result = await props.ctx.client.integration.get({
      integrationID: provider.providerID,
      location: props.ctx.location,
    })
    const methods = result.data.methods.flatMap((method) =>
      method.type === 'oauth' && method.id.startsWith('auth-lb-')
        ? [method]
        : [],
    )
    const methodID = await props.ctx.ui.dialog.select({
      title: `Sign in to ${names[provider.providerID] ?? provider.providerID}`,
      options: methods.map((method) => ({
        title: method.label,
        value: method.id,
      })),
    })
    if (!methodID) return
    await rpc.manage(
      { account: account.id, action: 'relogin' },
      { location: props.ctx.location },
    )
    let attemptID: string | undefined
    try {
      const { data } = await props.ctx.client.integration.oauth.connect({
        integrationID: provider.providerID,
        methodID,
        location: props.ctx.location,
      })
      attemptID = data.attemptID
      const code =
        data.mode === 'code'
          ? await props.ctx.ui.dialog.prompt({
              title: 'Authorize account',
              description: `${data.url}\n${data.instructions}`,
            })
          : await props.ctx.ui.dialog.confirm({
              title: 'Authorize account',
              message: `${data.url}\n${data.instructions}\nContinue after approving in your browser.`,
            })
      if (code === undefined || code === false) return
      await props.ctx.client.integration.oauth.complete({
        integrationID: provider.providerID,
        attemptID,
        ...(typeof code === 'string' ? { code } : {}),
        location: props.ctx.location,
      })
      attemptID = undefined
      props.ctx.ui.toast.show({
        message: 'Account added to load balancer',
        variant: 'success',
      })
    } finally {
      if (attemptID)
        await props.ctx.client.integration.oauth
          .cancel({
            integrationID: provider.providerID,
            attemptID,
            location: props.ctx.location,
          })
          .catch(() => {})
      await rpc
        .manage(
          { account: account.id, action: 'clear-relogin' },
          { location: props.ctx.location },
        )
        .catch(() => {})
    }
  }
  const manage = async (
    provider: ProviderStatus,
    account: ProviderStatus['accounts'][number],
  ) => {
    try {
      const disabled = account.disabledReason === 'manually disabled'
      const action = await props.ctx.ui.dialog.select({
        title: account.label,
        options: [
          { title: 'Rename', value: 'rename' as const },
          {
            title: disabled ? 'Enable' : 'Disable',
            value: disabled ? ('enable' as const) : ('disable' as const),
          },
          { title: 'Re-login / pair credential', value: 'relogin' as const },
          { title: 'Delete', value: 'delete' as const },
        ],
      })
      if (!action) return
      if (action === 'relogin') {
        await login(provider, account)
        return
      }
      const name =
        action === 'rename'
          ? await props.ctx.ui.dialog.prompt({
              title: 'Rename account',
              value: account.label,
            })
          : undefined
      if (action === 'rename' && name === undefined) return
      if (
        action === 'delete' &&
        !(await props.ctx.ui.dialog.confirm({
          title: 'Delete account',
          message: `Remove ${account.label} from the pool?`,
        }))
      )
        return
      await rpc.manage(
        { account: account.id, action, name },
        { location: props.ctx.location },
      )
    } catch (cause) {
      props.ctx.ui.toast.show({
        message:
          cause instanceof Error ? cause.message : 'Account update failed',
        variant: 'error',
      })
    } finally {
      await refresh()
    }
  }

  return (
    <box flexDirection={props.compact ? 'row' : 'column'} gap={1}>
      <Show when={error()}>
        <text fg={props.ctx.theme.text.muted}>{error()}</text>
      </Show>
      <For each={providers()}>
        {(provider) => (
          <box flexDirection="column">
            <Show when={!props.compact}>
              <text fg={props.ctx.theme.text.base}>
                <b>{names[provider.providerID] ?? provider.providerID}</b>
              </text>
            </Show>
            <For
              each={
                props.compact
                  ? provider.accounts.filter((account) => account.current)
                  : provider.accounts
              }
            >
              {(account) => (
                <box
                  flexDirection="column"
                  onMouseDown={() => void manage(provider, account)}
                >
                  <text fg={props.ctx.theme.text.base} wrapMode="word">
                    {`${account.current ? '●' : `#${account.rank}`} ${props.compact ? `${names[provider.providerID] ?? provider.providerID}: ` : ''}${account.label} · weekly ${pct(account.weeklyUtil)} · 5h ${pct(account.hourlyUtil)}${account.disabledReason ? ' · disabled' : account.available ? '' : ' · waiting'}`}
                  </text>
                  <Show when={!props.compact && account.warnings.length > 0}>
                    <text fg={props.ctx.theme.text.muted}>
                      {account.warnings.join(' · ')}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

export function registerV2Slots(ctx: Plugin.Context): () => void {
  const stopToast = ctx.client
    .rpc(loadBalancerRpc)
    .events.on('toast', (event) => {
      if (event.location?.directory === ctx.location?.directory)
        ctx.ui.toast.show(event.data)
    })
  const stopFooter = ctx.ui.slot({
    after: 'prompt.footer',
    render: (props) => (
      <StatusView compact ctx={ctx} sessionID={props.sessionID} />
    ),
  })
  const stopSidebar = ctx.ui.slot({
    append: 'sidebar.content',
    render: (props) => <StatusView ctx={ctx} sessionID={props.sessionID} />,
  })
  return () => {
    stopToast()
    stopFooter()
    stopSidebar()
  }
}
