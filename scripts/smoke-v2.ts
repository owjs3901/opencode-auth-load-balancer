import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { OpenCode } from '@opencode/client'

import { loadBalancerRpc } from '../src/v2-rpc'

// Use a separate home/database/config/pool: no personal credentials are touched.
const scratch = await mkdtemp(join(tmpdir(), 'auth-lb-v2-host-'))
const project = join(scratch, 'project')
await mkdir(project)
const packagePath = resolve(process.argv[2] ?? '.')
await writeFile(
  join(project, 'opencode.json'),
  JSON.stringify({ plugins: [packagePath] }),
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
      OPENCODE_AUTH_LB_DIR: join(scratch, 'pool'),
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
  if (status.length !== 0) throw new Error('Isolated pool should be empty')
  console.info(
    `OpenCode V2 host smoke passed: ${methods.length} auth methods; RPC status available`,
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  if (process.platform === 'win32' && server.pid)
    spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  else server.kill()
}
