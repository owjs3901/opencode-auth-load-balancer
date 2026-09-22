import { readFile } from 'node:fs/promises'

import { versionCacheFilePath } from '../../pool/paths'
import { writeJsonAtomic } from '../../pool/store'
import { ignore, isPlainObject } from '../../util'
import { fetchJson } from '../usage-http'
import {
  CLAUDE_CODE_REGISTRY_URL,
  CLAUDE_CODE_REQUIRED_VERSION_RE,
  CLAUDE_CODE_VERSION_ENV,
  CLAUDE_CODE_VERSION_GATE_CODE,
  CLAUDE_CODE_VERSION_TTL_MS,
  FALLBACK_CLAUDE_CODE_VERSION,
  REGISTRY_HTTP_TIMEOUT_MS,
} from './constants'

/**
 * Which Claude Code version this plugin claims to be.
 *
 * Anthropic gates new models on the client version we report — a request for a
 * model newer than our version is rejected outright
 * (`claude_code_version_too_old`), so a hard-pinned constant guarantees a
 * breakage on every model launch. The version is therefore RESOLVED, best-first:
 *
 *   1. the `OPENCODE_AUTH_LB_ANTHROPIC_CLAUDE_CODE_VERSION` env override,
 *   2. the newest version seen from the npm registry (cached on disk),
 *   3. `FALLBACK_CLAUDE_CODE_VERSION` — the offline floor.
 *
 * Route 2 is only as fresh as its TTL, so `recoverClaudeCodeVersion` closes the
 * window from the other side: a request the gate REJECTS carries the version it
 * wanted, and adopting that beats any polling cadence — it is the one source
 * that cannot lag the gate, because it IS the gate.
 *
 * The accessor is SYNCHRONOUS and allocation-light because it runs on the
 * request hot path (`setOAuthHeaders`, `buildBillingHeaderValue`); all I/O
 * happens in `primeClaudeCodeVersion` (startup) and `recoverClaudeCodeVersion`
 * (once per gate rejection), never in `claudeCodeVersion` itself.
 */

/**
 * Strict `major.minor.patch`. Prerelease/build tails are rejected rather than
 * passed through: this string goes into the `claude-cli/<v>` UA and the
 * `cc_version=` fingerprint, where a shape real Claude Code never emits is a
 * worse outcome than staying on the last known-good version. A rejected
 * candidate simply leaves the current value in place.
 */
const VERSION_RE = /^\d+\.\d+\.\d+$/

/** Numeric semver compare. Both sides must already satisfy `VERSION_RE`. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')
  for (let i = 0; i < 3; i++) {
    const delta = Number(left[i]) - Number(right[i])
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * The resolved version, seeded with the offline floor. Only ever moves UP (see
 * `adopt`), so neither a stale cache file nor an npm `latest` that regressed
 * (a bad publish, an unpublish, a registry mirror lagging) can drag the plugin
 * back below a version already known to work. Use the env override to go down
 * deliberately.
 */
let current: string = FALLBACK_CLAUDE_CODE_VERSION

/**
 * Take `candidate` only if it is well-formed AND strictly newer. Both callers
 * (the cache reader and the registry reader) have already proven their
 * candidate is a string, so this only screens SHAPE and ORDER.
 */
function adopt(candidate: string): void {
  const trimmed = candidate.trim()
  if (!VERSION_RE.test(trimmed)) return
  if (compareVersions(trimmed, current) <= 0) return
  current = trimmed
}

/**
 * The explicit pin, or undefined when unset/malformed. An override that is not
 * a plain `x.y.z` is ignored rather than passed through — same
 * silently-fall-back contract as an invalid `ANTHROPIC_BASE_URL`.
 */
function envOverride(): string | undefined {
  const raw = process.env[CLAUDE_CODE_VERSION_ENV]?.trim()
  return raw && VERSION_RE.test(raw) ? raw : undefined
}

/**
 * The version to report right now. Reads the env override on every call (like
 * `resolveBaseUrl`/`poolFilePath` do for theirs) so a pin takes effect without
 * a restart.
 */
export function claudeCodeVersion(): string {
  return envOverride() ?? current
}

/** User-Agent for /v1/messages. */
export function userAgent(): string {
  return `claude-cli/${claudeCodeVersion()} (external, cli)`
}

/**
 * User-Agent for the /api/oauth/usage endpoint. That endpoint hard-rejects
 * (429) requests whose UA is not `claude-code/<version>` — note the different
 * product token and the absence of the ` (external, cli)` suffix.
 */
export function usageUserAgent(): string {
  return `claude-code/${claudeCodeVersion()}`
}

interface VersionCache {
  version: string
  fetchedAt: number
}

/** Last registry answer, or null when absent/unreadable/not the cache shape. */
async function readCache(): Promise<VersionCache | null> {
  let text: string
  try {
    text = await readFile(versionCacheFilePath(), 'utf8')
  } catch {
    // Absent on first run; any other fs fault is equally non-fatal here — the
    // floor still serves requests, unlike the pool file where a swallowed read
    // fault would wipe credentials (see PoolReadError).
    return null
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isPlainObject(parsed)) return null
    const { version, fetchedAt } = parsed
    if (typeof version !== 'string' || !Number.isFinite(fetchedAt)) return null
    return { version, fetchedAt: fetchedAt as number }
  } catch {
    return null
  }
}

/**
 * Ask npm for the newest Claude Code, adopt it if newer, and persist the
 * result. Best-effort throughout: a registry outage, a shape change, or an
 * unwritable data dir all leave the in-memory version untouched and simply
 * defer the next attempt to the next startup (the cache is written only on a
 * usable answer, so a failure does NOT refresh the TTL).
 */
export async function refreshClaudeCodeVersion(now: number): Promise<void> {
  const tags = await fetchJson<{ latest?: unknown }>(
    CLAUDE_CODE_REGISTRY_URL,
    { accept: 'application/json' },
    REGISTRY_HTTP_TIMEOUT_MS,
  )
  if (!isPlainObject(tags) || typeof tags.latest !== 'string') return
  adopt(tags.latest)
  await persist(now)
}

/**
 * Write the resolved version to the cache. Persists `current`, NOT whichever
 * candidate a caller just supplied: `current` is the max of everything seen,
 * so a regressed registry answer refreshes the TTL without ever writing the
 * plugin back down to it. Unwritable data dir → swallowed, exactly like every
 * other best-effort write here (the in-memory value still serves requests).
 */
async function persist(now: number): Promise<void> {
  await writeJsonAtomic(
    versionCacheFilePath(),
    JSON.stringify({ version: current, fetchedAt: now } satisfies VersionCache),
  ).catch(ignore)
}

/**
 * REACTIVE recovery, driven by the gate's own rejection.
 *
 * `primeClaudeCodeVersion` resolves once at startup and then trusts the cache
 * for `CLAUDE_CODE_VERSION_TTL_MS`. A model that launches INSIDE that window is
 * therefore rejected for as long as the TTL has left to run — up to a full day
 * of hard failures — even when npm already tags the version Anthropic is asking
 * for, and even though the rejection itself NAMES that version. No polling
 * cadence fixes this in general either: Anthropic can gate a model before npm
 * tags the release, which is why the env pin exists as a manual escape hatch.
 *
 * So learn from the rejection instead. Adopt the minimum it demands, then ask
 * npm for the real `latest` in the same breath — the minimum only clears the
 * model that just failed, whereas `latest` is what the NEXT launch will want.
 *
 * Returns whether the reported version actually MOVED, which is precisely the
 * condition under which a retry can succeed; the caller spends a second
 * round-trip on true and passes the rejection through untouched on false.
 * `res` is consumed, so callers that still need the body must pass a clone.
 */
export async function recoverClaudeCodeVersion(
  res: Response,
  now: number,
): Promise<boolean> {
  // A pin outranks anything the server could teach us and `claudeCodeVersion`
  // would keep returning it, so a retry is provably identical to the request
  // that just failed — same reason `primeClaudeCodeVersion` skips its lookup.
  if (envOverride()) return false
  let text: string
  try {
    text = await res.text()
  } catch {
    // A body that cannot be read cannot be classified as the gate; leave the
    // response to its normal pass-through.
    return false
  }
  if (!text.includes(CLAUDE_CODE_VERSION_GATE_CODE)) return false
  const before = current
  // Undefined when Anthropic rewords the message. The registry round-trip
  // below is then the ONLY route forward, which is why it is awaited rather
  // than fired into the background: this request is already failing, and a
  // bounded (REGISTRY_HTTP_TIMEOUT_MS) lookup is its one chance to recover.
  const required = CLAUDE_CODE_REQUIRED_VERSION_RE.exec(text)?.[1]
  if (required !== undefined) adopt(required)
  await refreshClaudeCodeVersion(now).catch(ignore)
  if (current === before) return false
  // `refreshClaudeCodeVersion` persists only when the registry ANSWERED. A
  // registry miss must still write what the rejection taught us, or the next
  // process start would relearn it by failing a live request all over again.
  await persist(now)
  return true
}

/**
 * Startup hook. Awaits only the LOCAL cache read — cheap, and enough to have
 * the right version in hand before the loader returns the fetch — then leaves
 * any registry round-trip running in the background so neither opencode's
 * startup nor the first request ever blocks on npm.
 */
export async function primeClaudeCodeVersion(now: number): Promise<void> {
  // An explicit pin outranks anything the registry could report, so skip the
  // cache read AND the round-trip entirely — asking npm for a value that can
  // no longer be used is pure waste (and, for a pinned deployment, unwanted
  // egress).
  if (envOverride()) return
  const cached = await readCache()
  if (cached) {
    adopt(cached.version)
    if (now - cached.fetchedAt < CLAUDE_CODE_VERSION_TTL_MS) return
  }
  void refreshClaudeCodeVersion(now).catch(ignore)
}
