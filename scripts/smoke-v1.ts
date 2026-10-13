import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { poolFilePath } from '../src/pool/paths'

// Explicit live opt-in: reuse the registered pool, isolate host auth and config.
if (!process.argv.includes('--live'))
  throw new Error('Pass --live to call Anthropic')
const scratch = await mkdtemp(join(tmpdir(), 'auth-lb-v1-host-'))
const project = join(scratch, 'project')
const data = join(scratch, 'data', 'opencode')
await mkdir(project)
await mkdir(data, { recursive: true })
await writeFile(
  join(data, 'auth.json'),
  JSON.stringify({
    anthropic: { type: 'api', key: 'isolated-host-placeholder' },
  }),
)
await writeFile(
  join(project, 'opencode.json'),
  JSON.stringify({
    plugin: [resolve(process.argv[2] ?? '.')],
    permission: { '*': 'deny' },
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
      OPENCODE_CONFIG: join(project, 'opencode.json'),
      OPENCODE_CONFIG_DIR: join(scratch, 'config'),
      XDG_CONFIG_HOME: join(scratch, 'config'),
      XDG_DATA_HOME: join(scratch, 'data'),
      XDG_CACHE_HOME: join(scratch, 'cache'),
      XDG_STATE_HOME: join(scratch, 'state'),
      OPENCODE_AUTH_LB_DIR: dirname(poolFilePath()),
      OPENCODE_AUTH_LB_SYNC: '0',
      OPENCODE_AUTH_LB_ANTHROPIC_AUTO_TOKEN: '0',
      OPENCODE_SERVER_PASSWORD: 'auth-lb-isolated-smoke',
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
  if (!url) throw new Error(`Startup timed out: ${output}`)
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('opencode:auth-lb-isolated-smoke').toString('base64')}`,
        'content-type': 'application/json',
        'x-opencode-directory': project,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(JSON.stringify(result))
    return result
  }
  const auth = await request('/provider/auth')
  if (
    !auth.anthropic?.some((method: { label: string }) =>
      method.label.includes('load balancer'),
    )
  )
    throw new Error('V1 pooled authentication hook was not loaded')
  const session = await request('/session', {})
  const result = await request(`/session/${session.id}/message`, {
    model: { providerID: 'anthropic', modelID: 'claude-opus-5-5' },
    parts: [
      { type: 'text', text: 'Reply with exactly OK. Do not use any tools.' },
    ],
  })
  if (result.info?.error) throw new Error(JSON.stringify(result.info.error))
  const text = result.parts
    ?.filter((part: { type: string }) => part.type === 'text')
    .map((part: { text: string }) => part.text)
    .join('')
  if (text?.trim() !== 'OK')
    throw new Error(`Unexpected generation: ${JSON.stringify(result)}`)
  console.info(
    `OpenCode 1 real ${result.info?.modelID} inference passed: ${text}`,
  )
} finally {
  if (process.platform === 'win32' && server.pid)
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  else server.kill()
}
