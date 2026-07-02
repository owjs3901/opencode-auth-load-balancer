import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { mutatePool, readPool } from '../pool/store'
import type { PoolAccount } from '../types'
import { testAccount } from './fixtures/account'

interface TokenServer {
  url: string
  successCount: () => number
  stop: () => void
}

/** A token endpoint that rotates on first use of a refresh token and 400s on reuse. */
function startSingleUseTokenServer(): TokenServer {
  let gen = 0
  let successes = 0
  const consumed = new Set<string>()
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { refresh_token: string }
      if (consumed.has(body.refresh_token)) {
        // Single-use: a reused refresh token is rejected like the real OAuth server.
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      consumed.add(body.refresh_token)
      successes += 1
      gen += 1
      return Response.json({
        access_token: `access-${gen}`,
        refresh_token: `refresh-${gen}`,
        expires_in: 3600,
      })
    },
  })
  return {
    url: `http://localhost:${server.port}`,
    successCount: () => successes,
    stop: () => server.stop(true),
  }
}

function staleAccount(id: string): PoolAccount {
  const now = Date.now()
  return testAccount({
    id,
    label: id,
    access: 'stale-access',
    refresh: 'refresh-0',
    expires: now - 1, // already expired -> needsRefresh
    tokenGen: 0,
    createdAt: now,
  })
}

async function runWorker(
  workerPath: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const proc = Bun.spawn(['bun', workerPath], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out.trim()
}

describe('two real processes racing one single-use refresh token', () => {
  test('the token is spent exactly once and neither process bricks the account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-lb-2p-'))
    process.env.OPENCODE_AUTH_LB_DIR = dir
    const server = startSingleUseTokenServer()
    try {
      const id = 'shared-2p'
      await mutatePool((pool) => {
        pool.accounts.push(staleAccount(id))
      })
      const worker = join(import.meta.dir, 'fixtures', 'refresh-worker.ts')
      const env = {
        ...process.env,
        OPENCODE_AUTH_LB_DIR: dir,
        RACE_TOKEN_URL: server.url,
        RACE_ACCOUNT_ID: id,
      }
      const [a, b] = await Promise.all([
        runWorker(worker, env),
        runWorker(worker, env),
      ])

      // Cross-process serialization: the stale token (refresh-0) is spent EXACTLY
      // once. The loser adopts the winner's rotated token via the refresh lock +
      // reload-before-refresh instead of re-spending the single-use token.
      expect(server.successCount()).toBe(1)
      // Neither process permanently disabled the account (the "re-login" brick).
      expect(a).toContain('RESULT:OK:')
      expect(b).toContain('RESULT:OK:')
      const stored = (await readPool()).accounts.find((x) => x.id === id)
      expect(stored?.disabledReason ?? null).toBeNull()
      expect(stored?.tokenGen ?? 0).toBeGreaterThanOrEqual(1)
    } finally {
      server.stop()
    }
  }, 20_000)
})
