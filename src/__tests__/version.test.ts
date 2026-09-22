import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { versionCacheFilePath } from '../pool/paths'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import {
  CLAUDE_CODE_REGISTRY_URL,
  CLAUDE_CODE_VERSION_ENV,
  CLAUDE_CODE_VERSION_GATE_CODE,
  CLAUDE_CODE_VERSION_TTL_MS,
  FALLBACK_CLAUDE_CODE_VERSION,
} from '../providers/anthropic/constants'
import {
  claudeCodeVersion,
  primeClaudeCodeVersion,
  recoverClaudeCodeVersion,
  refreshClaudeCodeVersion,
  usageUserAgent,
  userAgent,
} from '../providers/anthropic/version'
import { type Responder, responderFetch } from './fixtures/fetch-mock'

/**
 * `version.ts` keeps ONE module-level `current` that is deliberately monotonic
 * — it only ever moves up. These tests therefore drive it with a strictly
 * ASCENDING ladder of versions and never assume it can be reset; each block
 * documents the value it leaves behind. Versions far above the shipped floor
 * are used so the ladder can never collide with `FALLBACK_CLAUDE_CODE_VERSION`.
 */
const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-version-'))

const realFetch = globalThis.fetch
let respond: Responder

/** Serve npm dist-tags for `latest`. */
const tags = (latest: unknown): Responder => {
  return () => new Response(JSON.stringify({ latest }), { status: 200 })
}

function writeCache(version: unknown, fetchedAt: unknown): void {
  writeFileSync(versionCacheFilePath(), JSON.stringify({ version, fetchedAt }))
}

beforeEach(() => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  delete process.env[CLAUDE_CODE_VERSION_ENV]
  respond = tags(FALLBACK_CLAUDE_CODE_VERSION)
  globalThis.fetch = responderFetch(() => respond)
})

afterEach(async () => {
  globalThis.fetch = realFetch
  delete process.env[CLAUDE_CODE_VERSION_ENV]
  await rm(versionCacheFilePath(), { force: true })
})

describe('claudeCodeVersion — env override', () => {
  test('falls back to the pinned floor when nothing is configured', () => {
    expect(claudeCodeVersion()).toBe(FALLBACK_CLAUDE_CODE_VERSION)
  })

  test('a valid override wins outright — including BELOW the floor', () => {
    // The escape hatch must be able to go DOWN (e.g. to reproduce a
    // claude_code_version_too_old failure), which the monotonic `current`
    // deliberately cannot.
    process.env[CLAUDE_CODE_VERSION_ENV] = '2.1.87'
    expect(claudeCodeVersion()).toBe('2.1.87')
  })

  test('surrounding whitespace is trimmed', () => {
    process.env[CLAUDE_CODE_VERSION_ENV] = '  3.0.1  '
    expect(claudeCodeVersion()).toBe('3.0.1')
  })

  test.each([
    ['empty', ''],
    ['not a version', 'latest'],
    ['two-part', '2.1'],
    ['prerelease tail', '2.1.258-beta.1'],
  ])('a malformed override (%s) is ignored', (_label, value) => {
    process.env[CLAUDE_CODE_VERSION_ENV] = value
    expect(claudeCodeVersion()).toBe(FALLBACK_CLAUDE_CODE_VERSION)
  })
})

describe('user-agent shapes', () => {
  test('the two endpoints use different product tokens', () => {
    process.env[CLAUDE_CODE_VERSION_ENV] = '9.9.9'
    expect(userAgent()).toBe('claude-cli/9.9.9 (external, cli)')
    expect(usageUserAgent()).toBe('claude-code/9.9.9')
  })
})

describe('refreshClaudeCodeVersion', () => {
  test('adopts a newer registry version and caches it', async () => {
    respond = tags('90.0.0')
    await refreshClaudeCodeVersion(1_000)
    expect(claudeCodeVersion()).toBe('90.0.0')
    const cached: unknown = JSON.parse(
      await Bun.file(versionCacheFilePath()).text(),
    )
    expect(cached).toEqual({ version: '90.0.0', fetchedAt: 1_000 })
  })

  test('hits the npm dist-tags endpoint, not the packument', async () => {
    let seen = ''
    respond = (url) => {
      seen = url
      return new Response('{"latest":"90.0.0"}', { status: 200 })
    }
    await refreshClaudeCodeVersion(2_000)
    expect(seen).toBe(CLAUDE_CODE_REGISTRY_URL)
  })

  test.each([
    ['a lower major', '89.0.0'],
    ['a lower minor', '90.0.0'],
    ['an equal version', '90.0.0'],
    ['a lower patch', '90.0.0'],
    ['a malformed version', 'v90.1.0'],
  ])('never regresses on %s', async (_label, latest) => {
    respond = tags(latest)
    await refreshClaudeCodeVersion(3_000)
    expect(claudeCodeVersion()).toBe('90.0.0')
  })

  test('each version segment is compared numerically, not lexically', async () => {
    // '90.0.9' vs '90.0.10': string compare would rank '9' above '10'.
    respond = tags('90.0.10')
    await refreshClaudeCodeVersion(4_000)
    expect(claudeCodeVersion()).toBe('90.0.10')
    respond = tags('90.1.0')
    await refreshClaudeCodeVersion(5_000)
    expect(claudeCodeVersion()).toBe('90.1.0')
    respond = tags('91.0.0')
    await refreshClaudeCodeVersion(6_000)
    expect(claudeCodeVersion()).toBe('91.0.0')
  })

  test.each([
    ['a transport failure', () => new Response('nope', { status: 503 })],
    ['a non-object body', () => new Response('42', { status: 200 })],
    ['a missing latest tag', () => new Response('{"next":"92.0.0"}', {})],
    ['a non-string latest tag', () => new Response('{"latest":92}', {})],
  ])('leaves the version untouched on %s', async (_label, responder) => {
    respond = responder
    await refreshClaudeCodeVersion(7_000)
    expect(claudeCodeVersion()).toBe('91.0.0')
  })

  test('an unusable answer does NOT refresh the cache TTL', async () => {
    // The cache must keep its previous timestamp so the next startup retries
    // instead of trusting a write that never described a real answer.
    writeCache('91.0.0', 1)
    respond = () => new Response('null', { status: 200 })
    await refreshClaudeCodeVersion(8_000)
    expect(JSON.parse(await Bun.file(versionCacheFilePath()).text())).toEqual({
      version: '91.0.0',
      fetchedAt: 1,
    })
  })

  test('an unwritable data dir is swallowed — the version still updates', async () => {
    // Point the data dir at a path UNDER a regular file so the atomic write's
    // mkdir fails; the in-memory value must still advance.
    const blocker = join(DIR, 'blocker')
    writeFileSync(blocker, 'not a directory')
    process.env.OPENCODE_AUTH_LB_DIR = join(blocker, 'nested')
    respond = tags('92.0.0')
    await refreshClaudeCodeVersion(9_000)
    expect(claudeCodeVersion()).toBe('92.0.0')
    process.env.OPENCODE_AUTH_LB_DIR = DIR
  })
})

describe('primeClaudeCodeVersion', () => {
  test('an explicit pin skips the registry entirely', async () => {
    let called = false
    respond = () => {
      called = true
      return new Response('{"latest":"99.0.0"}', { status: 200 })
    }
    process.env[CLAUDE_CODE_VERSION_ENV] = '2.1.87'
    await primeClaudeCodeVersion(Date.now())
    expect(called).toBe(false)
  })

  test('a FRESH cache is adopted without any registry call', async () => {
    let called = false
    respond = () => {
      called = true
      return new Response('{"latest":"99.0.0"}', { status: 200 })
    }
    const now = Date.now()
    writeCache('93.0.0', now)
    await primeClaudeCodeVersion(now)
    expect(claudeCodeVersion()).toBe('93.0.0')
    expect(called).toBe(false)
  })

  test('a STALE cache is adopted AND triggers a background refresh', async () => {
    const now = Date.now()
    writeCache('94.0.0', now - CLAUDE_CODE_VERSION_TTL_MS - 1)
    respond = tags('95.0.0')
    await primeClaudeCodeVersion(now)
    // The stale value lands synchronously with the awaited cache read...
    expect(claudeCodeVersion()).toBe('94.0.0')
    // ...and the registry answer follows on the un-awaited refresh.
    await Bun.sleep(20)
    expect(claudeCodeVersion()).toBe('95.0.0')
  })

  test('a missing cache falls through to the registry', async () => {
    respond = tags('96.0.0')
    await primeClaudeCodeVersion(Date.now())
    await Bun.sleep(20)
    expect(claudeCodeVersion()).toBe('96.0.0')
  })

  test.each([
    ['corrupt JSON', '{not json'],
    ['a JSON primitive', '42'],
    ['a non-string version', '{"version":97,"fetchedAt":1}'],
    ['a non-finite fetchedAt', '{"version":"98.0.0","fetchedAt":null}'],
  ])('a cache file with %s is ignored', async (_label, contents) => {
    writeFileSync(versionCacheFilePath(), contents)
    respond = tags('99.0.0')
    await primeClaudeCodeVersion(Date.now())
    await Bun.sleep(20)
    // Fell through to the registry rather than trusting the broken file.
    expect(claudeCodeVersion()).toBe('99.0.0')
  })

  test('a background refresh failure never rejects the prime', async () => {
    respond = () => {
      throw new Error('registry down')
    }
    await primeClaudeCodeVersion(Date.now())
    await Bun.sleep(20)
    expect(claudeCodeVersion()).toBe('99.0.0')
  })
})

describe('recoverClaudeCodeVersion', () => {
  /** A gate rejection in Anthropic's real envelope. */
  const gate = (sent: string, required: string): Response =>
    new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `Claude Code ${sent} does not support this model; version ${required} or newer is required.`,
          details: { error_code: CLAUDE_CODE_VERSION_GATE_CODE },
        },
      }),
      { status: 400 },
    )

  /** Counts registry hits so "never consulted" is assertable, not assumed. */
  let hits: number
  beforeEach(() => {
    hits = 0
    respond = (url) => {
      hits += 1
      return new Response(`{"latest":"${FALLBACK_CLAUDE_CODE_VERSION}"}`, {
        status: url === CLAUDE_CODE_REGISTRY_URL ? 200 : 404,
      })
    }
  })

  // --- the three no-op paths, taken at 99.0.0 ------------------------------

  test('an explicit pin makes recovery a no-op — the retry would be identical', async () => {
    process.env[CLAUDE_CODE_VERSION_ENV] = '2.1.87'
    expect(
      await recoverClaudeCodeVersion(gate('2.1.87', '150.0.0'), 10_000),
    ).toBe(false)
    expect(hits).toBe(0)
  })

  test('a rejection that is not the version gate is left alone', async () => {
    const other = new Response('{"error":{"message":"bad request"}}', {
      status: 400,
    })
    expect(await recoverClaudeCodeVersion(other, 11_000)).toBe(false)
    expect(hits).toBe(0) // classified without a lookup
    expect(claudeCodeVersion()).toBe('99.0.0')
  })

  test('a body that cannot be read is not classified as the gate', async () => {
    const broken = new Response(
      new ReadableStream({
        pull: (controller) => controller.error(new Error('stream broke')),
      }),
      { status: 400 },
    )
    expect(await recoverClaudeCodeVersion(broken, 12_000)).toBe(false)
    expect(claudeCodeVersion()).toBe('99.0.0')
  })

  // --- the recovering paths, climbing 99 -> 104 ----------------------------

  test('adopts the minimum the rejection demands, and persists it', async () => {
    respond = tags('99.0.0') // registry has nothing newer to offer
    expect(
      await recoverClaudeCodeVersion(gate('99.0.0', '100.0.0'), 13_000),
    ).toBe(true)
    expect(claudeCodeVersion()).toBe('100.0.0')
    expect(JSON.parse(await Bun.file(versionCacheFilePath()).text())).toEqual({
      version: '100.0.0',
      fetchedAt: 13_000,
    })
  })

  test('prefers npm `latest` over the bare minimum the gate demanded', async () => {
    // The minimum only clears the model that just failed; `latest` is what the
    // NEXT launch will want, and asking costs one 56-byte round-trip.
    respond = tags('102.0.0')
    expect(
      await recoverClaudeCodeVersion(gate('100.0.0', '101.0.0'), 14_000),
    ).toBe(true)
    expect(claudeCodeVersion()).toBe('102.0.0')
  })

  test('a reworded message still recovers, via the registry', async () => {
    // The error CODE is structured and stable; the version lives in English
    // prose. When the prose changes the regex misses, and the awaited registry
    // lookup is the request's only remaining route forward.
    respond = tags('103.0.0')
    const reworded = new Response(
      JSON.stringify({
        error: {
          message: 'this client is too old for the requested model',
          details: { error_code: CLAUDE_CODE_VERSION_GATE_CODE },
        },
      }),
      { status: 400 },
    )
    expect(await recoverClaudeCodeVersion(reworded, 15_000)).toBe(true)
    expect(claudeCodeVersion()).toBe('103.0.0')
  })

  test('a registry miss still persists what the REJECTION taught', async () => {
    // Otherwise the next process start would relearn it by failing a live
    // request all over again.
    respond = () => new Response('null', { status: 200 })
    expect(
      await recoverClaudeCodeVersion(gate('103.0.0', '104.0.0'), 16_000),
    ).toBe(true)
    expect(claudeCodeVersion()).toBe('104.0.0')
    expect(JSON.parse(await Bun.file(versionCacheFilePath()).text())).toEqual({
      version: '104.0.0',
      fetchedAt: 16_000,
    })
  })

  test('a gate we already satisfy does not ask for a retry', async () => {
    // Nothing moved, so a retry would send the identical request and earn the
    // identical rejection.
    respond = tags('104.0.0')
    expect(
      await recoverClaudeCodeVersion(gate('104.0.0', '104.0.0'), 17_000),
    ).toBe(false)
    expect(claudeCodeVersion()).toBe('104.0.0')
  })

  test('the anthropic adapter exposes it, and the retry then SENDS the new version', async () => {
    // Without this the wiring is untested: deleting `recoverClientVersion` from
    // the adapter would leave every other test in this repo green while the
    // fetch loop silently lost the recovery. Asserting through `userAgent()`
    // also closes the loop the fetch tests stub out — a relearned version is
    // only worth anything if the next request actually carries it.
    respond = tags('105.0.0')
    expect(
      await anthropicAdapter.recoverClientVersion?.(
        gate('104.0.0', '105.0.0'),
        18_000,
      ),
    ).toBe(true)
    expect(userAgent()).toBe('claude-cli/105.0.0 (external, cli)')
    expect(usageUserAgent()).toBe('claude-code/105.0.0')
  })
})
