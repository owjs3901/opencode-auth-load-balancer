import { createHash } from 'node:crypto'
import { arch, homedir, hostname, release, type } from 'node:os'

import type { TokenSet } from '../../types'
import { ignore, isPlainObject, sleep } from '../../util'
import {
  readRefreshResponse,
  readTokenResponse,
  toTokenSet,
} from '../oauth-callback'
import type { DeviceLogin } from '../types'
import {
  DEVICE_LOGIN_TIMEOUT_MS,
  KIMI_DEVICE_PLATFORM,
  KIMI_DEVICE_VERSION,
  KIMI_OAUTH_CLIENT_ID,
  type KimiDeployment,
  OAUTH_HTTP_TIMEOUT_MS,
} from './constants'
import { fetchProfile } from './profile'

/** Header values must be printable ASCII. */
function ascii(value: string): string {
  return value.replaceAll(/[^\x20-\x7E]/g, '').trim() || 'unknown'
}

/**
 * The `X-Msh-*` device identity Kimi's OAuth host expects on every call. The
 * device id hashes this machine and home directory: stable across restarts
 * with no file to persist, and meaningless anywhere else.
 */
function deviceHeaders(): Record<string, string> {
  const os = type()
  const name = os === 'Darwin' ? 'macOS' : os === 'Windows_NT' ? 'Windows' : os
  const id = createHash('sha256').update(`${hostname()}\n${homedir()}`)
  return {
    'X-Msh-Platform': KIMI_DEVICE_PLATFORM,
    'X-Msh-Version': KIMI_DEVICE_VERSION,
    'X-Msh-Device-Name': ascii(hostname()),
    'X-Msh-Device-Model': ascii(`${name} ${release()} ${arch()}`),
    'X-Msh-Os-Version': ascii(release()),
    'X-Msh-Device-Id': id.digest('hex').slice(0, 32),
  }
}

/** POST a form to the deployment's OAuth host, as Kimi's own clients do. */
function postForm(
  deployment: KimiDeployment,
  path: string,
  params: Record<string, string>,
): Promise<Response> {
  return fetch(`${deployment.oauthHost}${path}`, {
    method: 'POST',
    headers: {
      ...deviceHeaders(),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({ client_id: KIMI_OAUTH_CLIENT_ID, ...params }),
    signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
  })
}

/** A non-empty string field, or null. */
function text(json: Record<string, unknown>, key: string): string | null {
  const value = json[key]
  return typeof value === 'string' && value !== '' ? value : null
}

interface DeviceAuthorization {
  readonly deviceCode: string
  readonly userCode: string
  readonly url: string
  readonly intervalMs: number
  /** epoch ms after which the login is abandoned. */
  readonly deadline: number
}

/** The poll loop's clock — a seam so tests need not wait out real intervals. */
export interface PollClock {
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

const REAL_CLOCK: PollClock = { now: () => Date.now(), sleep }

async function authorizeDevice(
  deployment: KimiDeployment,
  now: number,
): Promise<DeviceAuthorization> {
  const res = await postForm(deployment, '/api/oauth/device_authorization', {})
  const json: unknown = await res.json().catch(() => null)
  const body = isPlainObject(json) ? json : {}
  const deviceCode = text(body, 'device_code')
  const userCode = text(body, 'user_code')
  const url = text(body, 'verification_uri_complete')
  if (!res.ok || !deviceCode || !userCode || !url)
    throw new Error(
      `Kimi Code device authorization failed (HTTP ${res.status})`,
    )
  const expiresInMs = Number(body.expires_in) * 1000
  return {
    deviceCode,
    userCode,
    url,
    intervalMs: Math.max(Number(body.interval) || 5, 1) * 1000,
    deadline:
      now +
      (expiresInMs > 0
        ? Math.min(expiresInMs, DEVICE_LOGIN_TIMEOUT_MS)
        : DEVICE_LOGIN_TIMEOUT_MS),
  }
}

/**
 * Poll until the user approves (RFC 8628 §3.4–3.5): `interval` apart, 5 s
 * longer after every `slow_down`. Null once the user denies, the code
 * expires, the server answers anything else, or the next poll would land past
 * the deadline.
 */
async function pollDevice(
  deployment: KimiDeployment,
  device: DeviceAuthorization,
  clock: PollClock,
): Promise<TokenSet | null> {
  let intervalMs = device.intervalMs
  for (;;) {
    const res = await postForm(deployment, '/api/oauth/token', {
      device_code: device.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (res.ok) {
      const json = await readTokenResponse(res)
      return json ? toTokenSet(json, '') : null
    }
    const json: unknown = await res.json().catch(() => null)
    const error = isPlainObject(json) ? json.error : undefined
    if (error === 'slow_down') intervalMs += 5000
    else if (error !== 'authorization_pending') return null
    if (clock.now() + intervalMs >= device.deadline) return null
    await clock.sleep(intervalMs)
  }
}

/**
 * Start a device-code login: the URL (user code embedded) to approve in a
 * browser, and `complete` — the wait for that approval. The approved login is
 * keyed by the Kimi account behind it (`GET /me`), like a key login, so one
 * subscription stays one pool row however it signs in.
 */
export async function startDeviceLogin(
  deployment: KimiDeployment,
  clock: PollClock = REAL_CLOCK,
): Promise<DeviceLogin> {
  const device = await authorizeDevice(deployment, clock.now())
  return {
    url: device.url,
    instructions: `Approve the sign-in in your browser (code ${device.userCode}).`,
    complete: async () => {
      const tokens = await pollDevice(deployment, device, clock)
      if (!tokens) return null
      const profile = await fetchProfile(deployment.baseUrl, tokens.access)
      return profile?.userId ? { ...tokens, accountId: profile.userId } : tokens
    },
  }
}

/**
 * Refresh a Kimi Code OAuth row. Kimi answers a revoked grant with 400
 * `invalid_grant`, 401 or 403, and each means re-login: 400/401 already carry
 * the status refresh.ts parks rows on, so only 403 is spelled out as
 * `invalid_grant`. A key row has no refresh token to spend at all.
 */
export async function refreshOAuth(
  deployment: KimiDeployment,
  refreshToken: string,
): Promise<TokenSet> {
  if (!refreshToken)
    throw new Error('invalid_grant: a Kimi Code API key cannot be refreshed')
  const res = await postForm(deployment, '/api/oauth/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  if (res.status === 403) {
    await res.body?.cancel().catch(ignore)
    throw new Error(
      'invalid_grant: Kimi Code rejected the refresh token (HTTP 403)',
    )
  }
  return toTokenSet(await readRefreshResponse(res), refreshToken)
}
