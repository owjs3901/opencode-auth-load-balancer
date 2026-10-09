import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { syncOriginFilePath, syncStateFilePath } from '../pool/paths'
import { machineOrigin } from '../sync/origin'
import { updateSyncState } from '../sync/state'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-sync-origin-'))

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(syncOriginFilePath(), { force: true })
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
})

describe('machine origin', () => {
  test('is 128 random bits as hex, in a file of its own, and the same every time', async () => {
    const first = await machineOrigin()
    expect(first).toMatch(/^[\da-f]{32}$/)
    expect(syncOriginFilePath()).toBe(
      join(DIR, 'auth-load-balancer-sync-origin.json'),
    )
    expect(JSON.parse(await readFile(syncOriginFilePath(), 'utf8'))).toEqual({
      origin: first,
    })
    expect(await machineOrigin()).toBe(first)
  })

  test('two windows starting together agree on one origin', async () => {
    const seen = await Promise.all([1, 2, 3, 4].map(() => machineOrigin()))
    expect(new Set(seen).size).toBe(1)
  })

  test('stopping sync does not touch it, so rejoining lists as the same machine', async () => {
    const before = await machineOrigin()
    await updateSyncState(() => null)
    await rm(syncStateFilePath(), { force: true })
    expect(await machineOrigin()).toBe(before)
  })

  test('a file that is not an origin is replaced, not trusted', async () => {
    for (const text of [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ origin: 'short' }),
      JSON.stringify({ origin: 'A'.repeat(32) }),
      JSON.stringify({ origin: 5 }),
    ]) {
      await writeFile(syncOriginFilePath(), text)
      expect(await machineOrigin()).toMatch(/^[\da-f]{32}$/)
    }
  })
})
