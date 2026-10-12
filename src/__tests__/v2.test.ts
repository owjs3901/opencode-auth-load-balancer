import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LanguageModelV3 } from '@ai-sdk/provider'
import type { Plugin } from '@opencode/plugin'
import type { AISDKHooks } from '@opencode/plugin/promise/aisdk'
import type { IntegrationOAuthMethodRegistration } from '@opencode/plugin/promise/integration'
import type { SessionHooks } from '@opencode/plugin/promise/session'
import type { Info } from '@opencode/plugin/promise/tool'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'

import plugin from '../index'
import { listPendingForWorkspace, upsertPending } from '../pending/store'
import { createV2ResumeClient } from '../pending/v2'
import { mutatePool, readPool } from '../pool/store'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import {
  kimiCodeAdapter,
  kimiCodeGlobalAdapter,
} from '../providers/kimi/adapter'
import { openaiAdapter } from '../providers/openai/adapter'
import { MESSAGE_HEADER, SESSION_HEADER } from '../session'
import { MANUAL_DISABLED_REASON } from '../types'
import { setupV2 } from '../v2'
import { loadBalancerRpc } from '../v2-rpc'
import { testAccount } from './fixtures/account'
import { responderFetch } from './fixtures/fetch-mock'

const dir = mkdtempSync(join(tmpdir(), 'auth-lb-v2-'))
const originalFetch = globalThis.fetch
let dispose: Plugin.Cleanup | undefined

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = dir
  process.env.OPENCODE_AUTH_LB_SYNC = '0'
  process.env.OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN = '0'
  process.env.OPENCODE_AUTH_LB_ANTHROPIC_CLAUDE_CODE_VERSION = '2.1.258'
  await rm(join(dir, 'auth-load-balancer.json'), { force: true })
  await rm(join(dir, 'auth-load-balancer-pending.json'), { force: true })
  globalThis.fetch = responderFetch(() => () => Response.json({}))
})
afterEach(async () => {
  await dispose?.()
  dispose = undefined
  globalThis.fetch = originalFetch
  delete process.env.OPENCODE_AUTH_LB_DIR
  delete process.env.OPENCODE_AUTH_LB_SYNC
  delete process.env.OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN
  delete process.env.OPENCODE_AUTH_LB_ANTHROPIC_CLAUDE_CODE_VERSION
})

function host(eventList: unknown[] = []) {
  const sdk = new Map<string, (event: AISDKHooks['sdk']) => Promise<void>>()
  const language = new Map<string, (event: AISDKHooks['language']) => void>()
  const request = new Map<
    string,
    (event: SessionHooks['model.request']) => Promise<void>
  >()
  const methods: IntegrationOAuthMethodRegistration[] = []
  const resumed: unknown[] = []
  const prompts: ((event: SessionHooks['prompt']) => void)[] = []
  const tools: Info[] = []
  const providers = [
    'anthropic',
    'openai',
    'kimi-code-plan-cn',
    'kimi-code-plan-global',
  ].map((id) => ({
    id,
    package: 'native',
    activation: 'auto',
    settings: { transport: 'websocket' },
  }))
  const models = providers.map((provider) => ({
    providerID: provider.id,
    id: `${provider.id}-model`,
    modelID: `${provider.id}-model`,
    package: 'native',
    cost: [{ input: 1, output: 2, cache: { read: 1, write: 1 } }],
  }))
  let rpcHandlers!: {
    status(input: { sessionID?: string }): Promise<unknown>
    manage(input: {
      account: string
      action: string
      name?: string
    }): Promise<string>
  }
  let signal: AbortSignal | undefined
  const events: unknown[] = []
  const ctx = {
    location: { directory: dir },
    rpc: {
      register: async (_definition: unknown, handlers: typeof rpcHandlers) => {
        rpcHandlers = handlers
        return {
          events: {
            emit: async (_name: string, data: unknown) => {
              events.push(data)
            },
          },
        }
      },
    },
    integration: {
      connection: { active: async () => undefined },
      transform: async (callback: (editor: unknown) => void) =>
        callback({
          get: (id: string) => ({ id }),
          method: {
            update: (method: IntegrationOAuthMethodRegistration) =>
              methods.push(method),
          },
        }),
    },
    provider: {
      reload: async () => {},
      transform: async (callback: (editor: unknown) => void) =>
        callback({
          get: (id: string) => ({
            models: new Map(
              models
                .filter((model) => model.providerID === id)
                .map((model) => [model.id, model]),
            ),
          }),
          update: (id: string, update: (value: unknown) => void) =>
            update(providers.find((provider) => provider.id === id)),
          models: {
            update: (
              id: string,
              modelID: string,
              update: (value: unknown) => void,
            ) =>
              update(
                models.find(
                  (model) => model.providerID === id && model.id === modelID,
                ),
              ),
          },
        }),
    },
    model: {
      list: async () => ({ data: models }),
      transform: async (callback: (editor: unknown) => void) =>
        callback({
          list: (id: string) =>
            models.filter((model) => model.providerID === id),
          update: (
            id: string,
            modelID: string,
            update: (value: unknown) => void,
          ) =>
            update(
              models.find(
                (model) => model.providerID === id && model.id === modelID,
              ),
            ),
        }),
    },
    aisdk: {
      hook: async (
        name: string,
        callback: never,
        options: { providerID: string },
      ) => {
        if (name === 'sdk') sdk.set(options.providerID, callback)
        else language.set(options.providerID, callback)
      },
    },
    session: {
      context: async () => [{ type: 'user', id: 'delivered-message' }],
      prompt: async (input: unknown) => {
        resumed.push(input)
      },
      hook: async (
        name: string,
        callback: never,
        options?: { providerID: string },
      ) => {
        if (name === 'model.request') request.set(options!.providerID, callback)
        if (name === 'prompt') prompts.push(callback)
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) =>
        callback({ add: (value: Info) => tools.push(value) }),
    },
    event: {
      subscribe: async function* (options: { signal: AbortSignal }) {
        signal = options.signal
        for (const event of eventList) yield event
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    sdk,
    language,
    request,
    methods,
    prompts,
    resumed,
    tools,
    providers,
    models,
    events,
    rpc: () => rpcHandlers,
    signal: () => signal,
  }
}

test('V2 entry registers integrations, tools, transport and cleanup', async () => {
  await mutatePool((pool) => {
    pool.accounts.push(
      testAccount({ providerID: 'openai', expires: Date.now() + 3_600_000 }),
    )
  })
  const fake = host()
  expect(plugin.id).toBe('opencode-auth-load-balancer')
  dispose = await plugin.setup(fake.ctx)
  expect(fake.methods.map((method) => method.integrationID)).toContain('openai')
  expect(fake.tools.map((tool) => tool.name)).toEqual([
    'auth_lb_status',
    'auth_lb_rename',
    'auth_lb_disable',
  ])
  expect(
    fake.providers.find((provider) => provider.id === 'openai'),
  ).toMatchObject({
    package: expect.stringMatching(/^aisdk:file:.*\/sdk\/openai\.js$/),
    activation: 'enabled',
    integrationID: 'auth-load-balancer-openai',
    settings: { transport: 'http' },
  })
  expect(
    fake.models.find((model) => model.providerID === 'openai')?.cost,
  ).toEqual([])
  expect(
    fake.providers.find((provider) => provider.id === 'anthropic')?.package,
  ).toBe('native')
  await dispose()
  expect(fake.signal()?.aborted).toBe(true)
})

test('a real V3 Codex SDK request rotates on 429 and preserves session identity', async () => {
  await mutatePool((pool) => {
    pool.accounts.push(
      testAccount({
        id: 'codex-a',
        providerID: 'openai',
        access: 'token-a',
        refresh: '',
        expires: Number.MAX_SAFE_INTEGER,
      }),
      testAccount({
        id: 'codex-b',
        providerID: 'openai',
        access: 'token-b',
        refresh: '',
        expires: Number.MAX_SAFE_INTEGER,
      }),
    )
  })
  const sent: {
    url: string
    headers: Headers
    body: Record<string, unknown>
  }[] = []
  globalThis.fetch = responderFetch(() => (url, init) => {
    if (!url.includes('/responses')) return Response.json({})
    const headers = new Headers(init?.headers)
    sent.push({ url, headers, body: JSON.parse(String(init?.body)) })
    if (headers.get('authorization') === 'Bearer token-a')
      return Response.json(
        { error: { message: 'rate limited' } },
        { status: 429, headers: { 'retry-after': '60' } },
      )
    return Response.json({
      id: 'resp_1',
      created_at: 1,
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok', annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  })
  const fake = host()
  dispose = await setupV2(fake.ctx)
  const event = {
    model: fake.models.find((model) => model.providerID === 'openai'),
    options: {},
    package: '@ai-sdk/openai',
  } as unknown as AISDKHooks['sdk']
  await fake.sdk.get('openai')!(event)
  const lang = {
    model: event.model,
    sdk: event.sdk,
    options: {},
  } as AISDKHooks['language']
  fake.language.get('openai')!(lang)
  const hook = {
    sessionID: 'session-a',
    kind: 'primary',
    headers: {},
  } as SessionHooks['model.request']
  await fake.request.get('openai')!(hook)
  expect(hook.headers[MESSAGE_HEADER]).toBe('delivered-message')
  const result = await (lang.language as LanguageModelV3).doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    headers: hook.headers,
  })
  expect(result.content).toContainEqual({
    type: 'text',
    text: 'ok',
    providerMetadata: { openai: { itemId: 'msg_1' } },
  })
  expect(sent.map((entry) => entry.headers.get('authorization'))).toEqual([
    'Bearer token-a',
    'Bearer token-b',
  ])
  expect(
    sent.every(
      (entry) =>
        entry.url === 'https://chatgpt.com/backend-api/codex/responses',
    ),
  ).toBe(true)
  expect(sent[1]?.body.store).toBe(false)
  expect(sent[1]?.headers.has(SESSION_HEADER)).toBe(false)
  expect(sent[1]?.headers.has(MESSAGE_HEADER)).toBe(false)
  expect((await readPool()).sessions['openai:s:session-a']?.accountId).toBe(
    'codex-b',
  )
})

test('RPC exposes safe status and serializes management through the pool lock', async () => {
  await mutatePool((pool) => {
    pool.accounts.push(
      testAccount({
        id: 'one',
        access: 'secret-token',
        refresh: 'secret-refresh',
        expires: Number.MAX_SAFE_INTEGER,
      }),
      testAccount({
        id: 'two',
        label: 'two',
        expires: Number.MAX_SAFE_INTEGER,
      }),
    )
    pool.sessions['anthropic:s:viewer'] = {
      accountId: 'two',
      updatedAt: Date.now(),
    }
    pool.lastSelected.anthropic = 'two'
  })
  const fake = host()
  dispose = await setupV2(fake.ctx)
  const status = await fake.rpc().status({ sessionID: 'viewer' })
  expect(JSON.stringify(status)).not.toContain('secret-token')
  expect(JSON.stringify(status)).not.toContain('secret-refresh')
  expect(
    loadBalancerRpc.methods.status.output
      .parse(status)[0]
      ?.accounts.find((account) => account.id === 'two')?.current,
  ).toBe(true)
  await fake.rpc().manage({ account: 'one', action: 'disable' })
  expect(
    (await readPool()).accounts.find((account) => account.id === 'one')
      ?.disabledReason,
  ).toBe(MANUAL_DISABLED_REASON)
  await fake.rpc().manage({ account: 'one', action: 'enable' })
  await fake.rpc().manage({ account: 'one', action: 'rename', name: 'renamed' })
  await expect(
    fake.rpc().manage({ account: 'one', action: 'rename', name: '  ' }),
  ).rejects.toThrow('empty')
  await expect(
    fake.rpc().manage({ account: 'missing', action: 'delete' }),
  ).rejects.toThrow('no longer exists')
  await fake.rpc().manage({ account: 'one', action: 'relogin' })
  expect((await readPool()).relogin?.accountId).toBe('one')
  await fake.rpc().manage({ account: 'one', action: 'clear-relogin' })
  expect((await readPool()).relogin).toBeUndefined()
  await expect(
    fake.rpc().manage({ account: 'one', action: 'rename', name: 'two' }),
  ).rejects.toThrow('already used')
  await fake.rpc().manage({ account: 'two', action: 'delete' })
  expect((await readPool()).sessions['anthropic:s:viewer']).toBeUndefined()
})

test('V2 login and host refresh share the pooled token lifecycle', async () => {
  const authorize = spyOn(openaiAdapter, 'authorize').mockResolvedValue({
    url: 'https://example.com/login',
    verifier: 'verifier',
    state: 'state',
    redirectUri: 'http://localhost',
  })
  const exchange = spyOn(openaiAdapter, 'exchange').mockResolvedValue({
    access: 'login-token',
    refresh: 'login-refresh',
    expires: Date.now() + 3_600_000,
  })
  const refresh = spyOn(openaiAdapter, 'refresh').mockResolvedValue({
    access: 'rotated-token',
    refresh: 'rotated-refresh',
    expires: Date.now() + 3_600_000,
  })
  try {
    const fake = host()
    dispose = await setupV2(fake.ctx)
    const method = fake.methods.find(
      (method) => method.integrationID === 'openai',
    )!
    const login = await method.authorize({})
    expect(login.mode).toBe('code')
    if (login.mode !== 'code') throw new Error('Expected code login')
    const credential = await login.callback('valid-code')
    expect(credential.metadata?.accountID).toBe(
      (await readPool()).accounts[0]?.id,
    )
    await mutatePool((pool) => {
      pool.accounts[0]!.expires = 1
    })
    const renewed = await method.refresh!(credential)
    expect(renewed.refresh).toBe('rotated-refresh')
    expect((await readPool()).accounts[0]?.access).toBe('rotated-token')
    await mutatePool((pool) => {
      pool.accounts = []
    })
    await expect(method.refresh!(credential)).rejects.toThrow(
      'no longer exists',
    )
    exchange.mockResolvedValueOnce(null)
    const failed = await method.authorize({})
    if (failed.mode === 'code')
      await expect(failed.callback('invalid')).rejects.toThrow(
        'authorization failed',
      )
  } finally {
    authorize.mockRestore()
    exchange.mockRestore()
    refresh.mockRestore()
  }
})

test('Kimi key and automatic device login register accounts under V2', async () => {
  const device = spyOn(kimiCodeAdapter, 'startDeviceLogin').mockResolvedValue({
    url: 'https://example.com/device',
    instructions: 'Approve device',
    complete: async () => ({
      access: 'device-token',
      refresh: 'device-refresh',
      expires: Date.now() + 3_600_000,
    }),
  })
  const key = spyOn(kimiCodeAdapter, 'exchange').mockResolvedValue({
    access: 'kimi-key',
    refresh: '',
    expires: Number.MAX_SAFE_INTEGER,
  })
  try {
    const fake = host()
    dispose = await setupV2(fake.ctx)
    const methods = fake.methods.filter(
      (method) => method.integrationID === 'kimi-code-plan-cn',
    )
    const login = await methods[0]!.authorize({})
    expect(login.mode).toBe('auto')
    if (login.mode === 'auto')
      expect((await login.callback).access).toBe('device-token')
    const paste = await methods[1]!.authorize({})
    if (paste.mode === 'code') {
      const credential = await paste.callback('key')
      expect(credential.access).toBe('kimi-key')
      expect(credential.expires).toBe(Number.MAX_SAFE_INTEGER)
    }
  } finally {
    device.mockRestore()
    key.mockRestore()
  }
})

test('V2 Claude and both Kimi SDKs route requests through pooled credentials', async () => {
  await mutatePool((pool) => {
    for (const adapter of [
      anthropicAdapter,
      kimiCodeAdapter,
      kimiCodeGlobalAdapter,
    ])
      pool.accounts.push(
        testAccount({
          id: adapter.id,
          providerID: adapter.id,
          access: `${adapter.id}-token`,
          refresh: '',
          expires: Number.MAX_SAFE_INTEGER,
        }),
      )
  })
  const sent: { url: string; headers: Headers }[] = []
  globalThis.fetch = responderFetch(() => (url, init) => {
    if (url.includes('/messages')) {
      if (JSON.parse(String(init?.body)).model === 'claude-sonnet-4-5')
        sent.push({ url, headers: new Headers(init?.headers) })
      return Response.json({
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }
    if (url.includes('/chat/completions')) {
      sent.push({ url, headers: new Headers(init?.headers) })
      return Response.json({
        id: 'chat',
        object: 'chat.completion',
        created: 1,
        model: 'kimi',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    return Response.json({})
  })
  const fake = host()
  dispose = await setupV2(fake.ctx)
  for (const providerID of [
    'anthropic',
    'kimi-code-plan-cn',
    'kimi-code-plan-global',
  ]) {
    const event = {
      model: fake.models.find((model) => model.providerID === providerID),
      options: {},
      package: '',
    } as unknown as AISDKHooks['sdk']
    await fake.sdk.get(providerID)!(event)
    const language = event.sdk.languageModel(
      providerID === 'anthropic' ? 'claude-sonnet-4-5' : 'kimi',
    ) as LanguageModelV3
    await language.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    })
  }
  expect(sent.map((entry) => entry.headers.get('authorization'))).toEqual([
    'Bearer anthropic-token',
    'Bearer kimi-code-plan-cn-token',
    'Bearer kimi-code-plan-global-token',
  ])
  expect(sent[1]?.url).toStartWith('https://api.kimi.com/coding/v1/')
  expect(sent[2]?.url).toStartWith('https://api.kimi.ai/coding/v1/')
  const toolContext = { signal: new AbortController().signal } as Parameters<
    Info['execute']
  >[1]
  const result = await fake.tools
    .find((tool) => tool.name === 'auth_lb_status')!
    .execute({}, toolContext)
  expect(result.content).toContain('Claude')
})

test('unpooled providers remain native and setup failures clean up', async () => {
  const fake = host([
    { type: 'other' },
    {
      type: 'session.deleted',
      location: { directory: 'another-project' },
      data: { sessionID: 'deleted' },
    },
    {
      type: 'session.execution.interrupted',
      location: { directory: dir },
      data: { sessionID: 'cancelled' },
    },
  ])
  dispose = await setupV2(fake.ctx)
  const sdk = { options: {}, package: 'native' } as AISDKHooks['sdk']
  await fake.sdk.get('openai')!(sdk)
  expect(sdk.sdk).toBeUndefined()
  const lang = {} as AISDKHooks['language']
  fake.language.get('openai')!(lang)
  expect(lang.language).toBeUndefined()
  const event = {
    sessionID: 's',
    kind: 'primary',
    headers: {},
  } as SessionHooks['model.request']
  await fake.request.get('openai')!(event)
  expect(event.headers).toEqual({})
  fake.prompts[0]!({ sessionID: 's', messageID: 'm' } as SessionHooks['prompt'])
  await Bun.sleep(20)
  await dispose()
  dispose = undefined
  const broken = host()
  Object.assign(broken.ctx.tool, {
    transform: async () => {
      throw new Error('registration failed')
    },
  })
  await expect(setupV2(broken.ctx)).rejects.toThrow('registration failed')
})

test('restart recovery resumes the same V2 prompt without copying its payload', async () => {
  const prompts: unknown[] = []
  let messages: unknown[] = [{ id: 'user-1', type: 'user' }]
  const ctx = {
    session: {
      context: async () => messages,
      prompt: async (input: unknown) => {
        prompts.push(input)
      },
    },
  } as unknown as Plugin.Context
  const client = createV2ResumeClient(ctx)
  const turn = {
    key: 'key',
    workspace: dir,
    providerID: 'openai',
    sessionID: 'session-1',
    messageID: 'user-1',
    createdAt: 1,
    updatedAt: 1,
    nextCheckAt: 2,
    resumeAt: null,
  }
  expect(await client.resumePending(turn)).toBe('resumed')
  expect(prompts).toEqual([
    { sessionID: 'session-1', id: 'user-1', text: '', resume: true },
  ])
  messages = [
    ...messages,
    { id: 'assistant', type: 'assistant', finish: 'stop' },
  ]
  expect(await client.resumePending(turn)).toBe('obsolete')
  expect(prompts).toHaveLength(1)
  messages = [{ id: 'different-user', type: 'user' }]
  expect(await client.resumePending(turn)).toBe('obsolete')
})

test('V2 imports a connected Kimi key and cleans stale restart references', async () => {
  const fake = host()
  Object.assign(fake.ctx.integration.connection, {
    active: async (id: string) =>
      id === 'kimi-code-plan-cn' ? { id: 'key-connection' } : undefined,
    resolve: async () => ({ type: 'key', key: 'connected-kimi-key' }),
  })
  await upsertPending(
    {
      workspace: dir,
      providerID: 'openai',
      sessionID: 'stale',
      messageID: 'missing',
    },
    { now: 1, nextCheckAt: 2, resumeAt: null },
  )
  await upsertPending(
    {
      workspace: dir,
      providerID: 'openai',
      sessionID: 'restart',
      messageID: 'delivered-message',
    },
    { now: 1, nextCheckAt: 2, resumeAt: null },
  )
  dispose = await setupV2(fake.ctx)
  await Bun.sleep(30)
  expect(
    (await readPool()).accounts.find(
      (account) => account.providerID === 'kimi-code-plan-cn',
    )?.access,
  ).toBe('connected-kimi-key')
  expect(fake.resumed).toContainEqual({
    sessionID: 'restart',
    id: 'delivered-message',
    text: '',
    resume: true,
  })
  expect(
    (await listPendingForWorkspace(dir)).some(
      (turn) => turn.sessionID === 'stale',
    ),
  ).toBe(false)
})

test('V2 pending emits waiting and resumed notifications when quota resets', async () => {
  await mutatePool((pool) => {
    pool.accounts.push(
      testAccount({
        id: 'pending-account',
        providerID: 'openai',
        access: 'pending-token',
        refresh: '',
        expires: Number.MAX_SAFE_INTEGER,
        usage: {
          capturedAt: Date.now(),
          hourly: null,
          weekly: { utilization: 1, resetAt: Date.now() + 300 },
        },
      }),
    )
  })
  globalThis.fetch = responderFetch(
    () => (url) =>
      url.includes('/responses')
        ? Response.json({
            id: 'resp',
            created_at: 1,
            model: 'gpt-5',
            status: 'completed',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          })
        : Response.json({}),
  )
  const fake = host()
  dispose = await setupV2(fake.ctx)
  const event = {
    model: fake.models.find((model) => model.providerID === 'openai'),
    options: {},
    package: '',
  } as unknown as AISDKHooks['sdk']
  await fake.sdk.get('openai')!(event)
  const request = {
    sessionID: 'pending-session',
    kind: 'primary',
    headers: {},
  } as SessionHooks['model.request']
  await fake.request.get('openai')!(request)
  const language = event.sdk.responses('gpt-5') as LanguageModelV3
  await language.doGenerate({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    headers: request.headers,
    abortSignal: AbortSignal.timeout(2000),
  })
  expect(fake.events.length).toBeGreaterThanOrEqual(2)
  expect((await listPendingForWorkspace(dir)).length).toBe(0)
})

test('V2 restart recovery discards missing sessions but retries transient failures', async () => {
  const turn = {
    key: 'key',
    workspace: dir,
    providerID: 'openai',
    sessionID: 's',
    messageID: 'm',
    createdAt: 1,
    updatedAt: 1,
    nextCheckAt: 2,
    resumeAt: null,
  }
  const ctx = {
    session: {
      context: async () => {
        throw { _tag: 'SessionNotFoundError' }
      },
    },
  } as unknown as Plugin.Context
  expect(await createV2ResumeClient(ctx).resumePending(turn)).toBe('obsolete')
  Object.assign(ctx.session, {
    context: async () => {
      throw new Error('temporary')
    },
  })
  await expect(createV2ResumeClient(ctx).resumePending(turn)).rejects.toThrow(
    'temporary',
  )
})
