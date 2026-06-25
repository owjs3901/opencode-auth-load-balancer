/**
 * Subprocess worker for the two-process refresh-race test (two-process.test.ts).
 *
 * NOT a test file — it is spawned via `bun` so a GENUINELY separate OS process
 * exercises the cross-process refresh lock + tokenGen guard against a SHARED pool
 * file. It refreshes one account against a single-use token server (passed via env)
 * and prints a single `RESULT:` line the parent test parses.
 */
import { readPoolAccount } from '../../pool/store'
import type { ProviderAdapter } from '../../providers/types'
import { ensureAccessToken } from '../../refresh'
import type { TokenSet } from '../../types'

const tokenUrl = process.env.RACE_TOKEN_URL
const accountId = process.env.RACE_ACCOUNT_ID

function makeAdapter(url: string): ProviderAdapter {
  return {
    id: 'anthropic',
    authorize: async () => ({
      url: '',
      verifier: '',
      state: '',
      redirectUri: '',
    }),
    exchange: async () => null,
    refresh: async (refreshToken: string): Promise<TokenSet> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`Token refresh failed: ${res.status} — ${text}`)
      }
      const json = (await res.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
      }
      return {
        access: json.access_token,
        refresh: json.refresh_token,
        expires: Date.now() + json.expires_in * 1000,
      }
    },
    applyAuth: () => undefined,
    transformUrl: (i) => i,
    transformBody: (b) => b,
    transformResponse: (r) => r,
    parseUsageHeaders: () => null,
    fetchUsage: async () => null,
    classifyError: () => 'ok',
  }
}

async function main(): Promise<void> {
  if (!tokenUrl || !accountId) {
    console.info('RESULT:ERROR:missing env')
    return
  }
  const account = await readPoolAccount(accountId)
  if (!account) {
    console.info('RESULT:ERROR:no account')
    return
  }
  try {
    const token = await ensureAccessToken(
      makeAdapter(tokenUrl),
      account,
      Date.now(),
    )
    const after = await readPoolAccount(accountId)
    if (after?.disabledReason) {
      console.info(`RESULT:DISABLED:${after.disabledReason}`)
    } else {
      console.info(`RESULT:OK:${token}`)
    }
  } catch (error) {
    console.info(
      `RESULT:ERROR:${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

await main()
