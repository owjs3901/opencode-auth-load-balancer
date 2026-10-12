import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { OpenCode } from '@opencode/client'

import { testAccount } from '../src/__tests__/fixtures/account'
import { poolFilePath } from '../src/pool/paths'
import { loadBalancerRpc } from '../src/v2-rpc'

// Default modes isolate home/database/config/pool. Explicit --live modes reuse
// the existing pool for a real request; host credentials remain isolated.
const scratch = await mkdtemp(join(tmpdir(), 'auth-lb-v2-host-'))
const project = join(scratch, 'project')
await mkdir(project)
const packagePath = resolve(process.argv[2] ?? '.')
const inference = process.argv.includes('--inference')
const liveCodex = process.argv.includes('--live-codex')
const live = process.argv.includes('--live') || liveCodex
const requests: string[] = []
const upstream = inference
  ? Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const token = request.headers.get('authorization') ?? ''
        requests.push(token)
        if (token === 'Bearer revoked-smoke-token')
          return Response.json(
            {
              type: 'error',
              error: {
                type: 'authentication_error',
                message: 'OAuth access token has been revoked.',
              },
            },
            { status: 401 },
          )
        if (token !== 'Bearer valid-smoke-token')
          return new Response('Unexpected credential', { status: 500 })
        const body = (await request.json()) as {
          stream?: boolean
          model: string
        }
        const message = {
          id: 'msg_smoke',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'rotation works' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 2 },
        }
        if (!body.stream) return Response.json(message)
        const events = [
          [
            'message_start',
            {
              type: 'message_start',
              message: { ...message, content: [], stop_reason: null },
            },
          ],
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'rotation works' },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 2 },
            },
          ],
          ['message_stop', { type: 'message_stop' }],
        ]
        return new Response(
          events
            .map(
              ([name, data]) =>
                `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
            )
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
  : undefined
if (inference) {
  await mkdir(join(scratch, 'pool'))
  await writeFile(
    join(scratch, 'pool', 'auth-load-balancer.json'),
    JSON.stringify({
      version: 1,
      accounts: ['revoked', 'valid'].map((id) =>
        testAccount({
          id,
          label: id,
          access: `${id}-smoke-token`,
          refresh: '',
          expires: Number.MAX_SAFE_INTEGER,
          usage: { hourly: null, weekly: null, capturedAt: Date.now() },
        }),
      ),
      lastSelected: { anthropic: 'revoked' },
      sessions: {},
    }),
  )
}
await writeFile(
  join(project, 'opencode.json'),
  JSON.stringify({
    plugins: [packagePath],
    ...(upstream
      ? {
          providers: {
            anthropic: { settings: { baseURL: `${upstream.url}v1` } },
          },
        }
      : {}),
  }),
)
const server = spawn(
  'opencode',
  ['serve', '--hostname', '127.0.0.1', '--port', '0'],
  {
    cwd: project,
    windowsHide: true,
    env: {
      ...process.env,
      OPENCODE_TEST_HOME: scratch,
      OPENCODE_CONFIG_DIR: join(scratch, 'config'),
      OPENCODE_CONFIG: join(project, 'opencode.json'),
      XDG_DATA_HOME: join(scratch, 'data'),
      XDG_CACHE_HOME: join(scratch, 'cache'),
      XDG_CONFIG_HOME: join(scratch, 'config'),
      XDG_STATE_HOME: join(scratch, 'state'),
      OPENCODE_AUTH_LB_DIR: live
        ? dirname(poolFilePath())
        : join(scratch, 'pool'),
      OPENCODE_AUTH_LB_SYNC: '0',
      OPENCODE_SERVER_PASSWORD: 'auth-lb-isolated-smoke',
      OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN: '0',
      OPENCODE_AUTH_LB_ANTHROPIC_CLAUDE_CODE_VERSION: '2.1.258',
    },
  },
)
let output = ''
server.stdout.on('data', (data) => {
  output += String(data)
})
server.stderr.on('data', (data) => {
  output += String(data)
})
try {
  const deadline = Date.now() + 60_000
  let url: string | undefined
  while (!url && Date.now() < deadline) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`)
    if (!url) await Bun.sleep(200)
  }
  if (!url) throw new Error(`Server startup timed out: ${output}`)
  const client = OpenCode.make({
    baseUrl: url,
    headers: {
      authorization: `Basic ${Buffer.from('opencode:auth-lb-isolated-smoke').toString('base64')}`,
    },
  })
  let loaded = false
  while (!loaded && Date.now() < deadline) {
    const plugins = await client.plugin.list({
      location: { directory: project },
    })
    const plugin = plugins.data.find(
      (entry) => entry.id === 'opencode-auth-load-balancer',
    )
    if (plugin && plugin.state.status !== 'active')
      throw new Error(JSON.stringify(plugin))
    loaded = plugin?.state.status === 'active'
    if (!loaded) await Bun.sleep(200)
  }
  if (!loaded) throw new Error('Plugin activation timed out')
  const integrations = await client.integration.list({
    location: { directory: project },
  })
  const methods = integrations.data.flatMap((integration) =>
    integration.methods.filter(
      (method) => method.type === 'oauth' && method.id.startsWith('auth-lb-'),
    ),
  )
  if (methods.length < 4) throw new Error('Load balancer auth methods missing')
  const status = await client
    .rpc(loadBalancerRpc)
    .status({}, { location: { directory: project } })
  if (!inference && !live && status.length !== 0)
    throw new Error('Isolated pool should be empty')
  if (inference) {
    const models = await client.model.list({ location: { directory: project } })
    const model = models.data.find((value) => value.providerID === 'anthropic')
    if (
      !model ||
      !/^aisdk:file:.*\/sdk\/anthropic\.js$/.test(model.package ?? '')
    )
      throw new Error(
        `Pooled model was rewritten to a native driver: ${model?.package}`,
      )
    const result = await client.generate.text({
      prompt: 'hello',
      model: { providerID: 'anthropic', id: model.id },
    })
    if (result.text !== 'rotation works')
      throw new Error(`Unexpected generation: ${result.text}`)
    if (
      requests.join(',') !==
      'Bearer revoked-smoke-token,Bearer valid-smoke-token'
    )
      throw new Error(`Account rotation was bypassed: ${requests.join(',')}`)
    console.info(
      'Anthropic inference smoke passed: revoked token rotated to a healthy pooled account',
    )
  }
  if (live) {
    const providerID = liveCodex ? 'openai' : 'anthropic'
    // An obsolete single-slot credential must never gate a healthy pool.
    // This credential is synthetic and exists only in the isolated database.
    await client.credential.create({
      integrationID: providerID,
      value: {
        type: 'oauth',
        methodID: 'auth-lb-0',
        access: 'obsolete-host-access',
        refresh: 'obsolete-host-refresh',
        expires: 0,
        metadata: { accountID: 'missing-host-account' },
      },
    })
    const models = await client.model.list({ location: { directory: project } })
    const model = models.data.find(
      (value) =>
        value.providerID === providerID &&
        (liveCodex ? value.id === 'gpt-6.1-sol' : /sonnet/.test(value.id)),
    )
    if (
      !model ||
      !/^aisdk:file:.*\/sdk\/(anthropic|openai)\.js$/.test(model.package ?? '')
    )
      throw new Error(
        `${providerID} pooled driver unavailable: ${model?.package}`,
      )
    const result = await client.generate.text({
      prompt: 'Reply with exactly OK.',
      model: { providerID, id: model.id },
    })
    if (!result.text.trim())
      throw new Error('Live provider returned an empty response')
    console.info(
      `Live ${providerID} inference passed with obsolete host credential (${model.id}): ${result.text.trim()}`,
    )
  }
  console.info(
    `OpenCode V2 host smoke passed: ${methods.length} auth methods; RPC status available`,
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  upstream?.stop(true)
  if (process.platform === 'win32' && server.pid)
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  else server.kill()
}
