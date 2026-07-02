import { mkdtempSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, test } from 'bun:test'

const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-stateful-'))
const POOL = join(DIR, 'auth-load-balancer.json')

import { addAccount, bootstrapFromOpencodeAuth } from '../accounts'
import {
  findAccount,
  type FsOps,
  mutatePool,
  PoolWriteError,
  readPool,
  writeJsonAtomic,
} from '../pool/store'
import { anthropicAdapter } from '../providers/anthropic/adapter'
import { openaiAdapter } from '../providers/openai/adapter'
import type { ProviderAdapter } from '../providers/types'
import { ensureAccessToken, needsRefresh } from '../refresh'
import type { PoolAccount, TokenSet, UsageSnapshot } from '../types'
import { refreshUsageInBackground } from '../usage-refresh'

beforeEach(async () => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
  await rm(POOL, { force: true })
})

let seq = 0
function account(over: Partial<PoolAccount> = {}): PoolAccount {
  seq += 1
  return {
    id: `acc-${seq}`,
    providerID: 'anthropic',
    label: `acc-${seq}`,
    access: 'tok',
    refresh: 'ref',
    expires: Date.now() + 60 * 60 * 1000,
    accountId: null,
    usage: { hourly: null, weekly: null, status: null, capturedAt: Date.now() },
    cooldownUntil: 0,
    disabledReason: null,
    createdAt: Date.now(),
    ...over,
  }
}

function fakeAdapter(over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: 'anthropic',
    authorize: async () => ({
      url: '',
      verifier: '',
      state: '',
      redirectUri: '',
    }),
    exchange: async () => null,
    refresh: async () => ({
      access: 'new',
      refresh: 'newref',
      expires: Date.now() + 3_600_000,
    }),
    applyAuth: () => undefined,
    transformUrl: (i) => i,
    transformBody: (b) => b,
    transformResponse: (r) => r,
    parseUsageHeaders: () => null,
    fetchUsage: async () => null,
    classifyError: () => 'ok',
    ...over,
  }
}

describe('pool store', () => {
  test('readPool returns empty on a corrupt/unknown-version file', async () => {
    await writeFile(POOL, JSON.stringify({ version: 2, accounts: [] }))
    expect((await readPool()).accounts).toHaveLength(0)
  })

  test('mutatePool persists, readPool reflects, findAccount locates', async () => {
    const a = account()
    await mutatePool((pool) => {
      pool.accounts.push(a)
    })
    const pool = await readPool()
    expect(pool.accounts).toHaveLength(1)
    expect(findAccount(pool, a.id)?.id).toBe(a.id)
    expect(findAccount(pool, 'missing')).toBeUndefined()
  })

  test('writeJsonAtomic retries the rename, then throws PoolWriteError and cleans up the temp file', async () => {
    // Post-fix: the old code fell back to a NON-atomic direct overwrite on rename
    // failure, which could shred a concurrent writer's update. Now it retries the
    // rename a bounded number of times and, on sustained failure, removes the temp
    // file and throws — never overwriting the target directly.
    const writes: string[] = []
    let renames = 0
    let unlinked = 0
    const ops: FsOps = {
      mkdir: async () => undefined,
      writeFile: async (path) => {
        writes.push(path)
      },
      rename: async () => {
        renames += 1
        throw new Error('EPERM')
      },
      unlink: async () => {
        unlinked += 1
        throw new Error('gone') // rejects -> exercises the shared `ignore`
      },
    }
    await expect(writeJsonAtomic('/data/pool.json', '{}', ops)).rejects.toThrow(
      PoolWriteError,
    )
    // Only the tmp file was ever written — never a direct, non-atomic target overwrite.
    expect(writes).toHaveLength(1)
    expect(writes[0]).not.toBe('/data/pool.json')
    expect(renames).toBe(5) // RENAME_RETRIES
    expect(unlinked).toBe(1) // tmp cleanup attempted
  })

  test('writeJsonAtomic wraps a mkdir failure in PoolWriteError', async () => {
    // Symmetric to the rename-failure test above: the same Windows EPERM/EACCES
    // family (virus scanner / locked dir / EROFS) can hit mkdir too. `bestEffort`
    // only swallows LockTimeoutError | PoolWriteError, so a raw fs error escaping
    // here would kill an already-served request — exactly the failure mode
    // bestEffort exists to prevent. Lock the wrapping so a regression that drops
    // the try/catch is caught immediately.
    let writes = 0
    let renames = 0
    let unlinked = 0
    const ops: FsOps = {
      mkdir: async () => {
        throw new Error('EACCES')
      },
      writeFile: async () => {
        writes += 1
      },
      rename: async () => {
        renames += 1
      },
      unlink: async () => {
        unlinked += 1
      },
    }
    await expect(writeJsonAtomic('/data/pool.json', '{}', ops)).rejects.toThrow(
      PoolWriteError,
    )
    // mkdir failed before any write/rename was attempted, so no tmp file exists
    // and no cleanup is required on this branch.
    expect(writes).toBe(0)
    expect(renames).toBe(0)
    expect(unlinked).toBe(0)
  })

  test('writeJsonAtomic wraps a writeFile failure in PoolWriteError and attempts tmp cleanup', async () => {
    // Symmetric to the rename-failure test: ENOSPC / EROFS / Windows EPERM on
    // writeFile must also surface as PoolWriteError so bestEffort swallows it.
    // The cleanup-count assertion mirrors the rename branch and locks the
    // invariant that a failed writeFile still attempts to remove any partial tmp.
    let renames = 0
    let unlinked = 0
    const ops: FsOps = {
      mkdir: async () => undefined,
      writeFile: async () => {
        throw new Error('ENOSPC')
      },
      rename: async () => {
        renames += 1
      },
      unlink: async () => {
        unlinked += 1
      },
    }
    await expect(writeJsonAtomic('/data/pool.json', '{}', ops)).rejects.toThrow(
      PoolWriteError,
    )
    // writeFile failed, so rename was never attempted; tmp cleanup was attempted.
    expect(renames).toBe(0)
    expect(unlinked).toBe(1)
  })
})

describe('refresh', () => {
  test('needsRefresh reflects expiry and missing token', () => {
    expect(
      needsRefresh(
        account({ expires: Date.now() + 60 * 60 * 1000 }),
        Date.now(),
      ),
    ).toBe(false)
    expect(needsRefresh(account({ expires: Date.now() - 1 }), Date.now())).toBe(
      true,
    )
    expect(needsRefresh(account({ access: '' }), Date.now())).toBe(true)
  })

  test('returns the current token when no refresh is needed', async () => {
    const a = account({
      access: 'current',
      expires: Date.now() + 60 * 60 * 1000,
    })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        return { access: 'x', refresh: 'y', expires: 0 }
      },
    })
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe('current')
    expect(called).toBe(0)
  })

  test('refreshes, persists the rotated token, and updates the account in place', async () => {
    const a = account({ access: 'old', expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const tokens: TokenSet = {
      access: 'fresh',
      refresh: 'rotated',
      expires: Date.now() + 3_600_000,
      accountId: 'acc_x',
    }
    const adapter = fakeAdapter({ refresh: async () => tokens })
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe('fresh')
    expect(a.access).toBe('fresh')
    expect(a.accountId).toBe('acc_x')
    expect(findAccount(await readPool(), a.id)?.refresh).toBe('rotated')
  })

  test('disables the account on invalid_grant and rethrows', async () => {
    const a = account({ expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error('invalid_grant')
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      'invalid_grant',
    )
    expect(a.disabledReason).toContain('invalid_grant')
    expect(findAccount(await readPool(), a.id)?.disabledReason).toContain(
      'invalid_grant',
    )
  })

  test('does NOT disable an account when a 5xx body coincidentally contains "400"', async () => {
    // Regression: pre-fix, /\b400\b|\b401\b/ matched the FULL error message,
    // which includes the upstream response body. A 502 whose body mentions
    // "HTTP 400" anywhere would permanently mark a working account as needing
    // re-login. The fix anchors the status check to the "Token refresh failed:
    // <status>" prefix that both OAuth refresh paths actually throw.
    const a = account({ expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error(
          'Token refresh failed: 502 — Bad Gateway. See status page: HTTP 400 fallback active.',
        )
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      '502',
    )
    expect(a.disabledReason).toBeNull()
    expect(
      findAccount(await readPool(), a.id)?.disabledReason ?? null,
    ).toBeNull()
  })

  test('does NOT disable an account when a 5xx body coincidentally contains "invalid_grant"', async () => {
    // Symmetric to the "HTTP 400 in a 5xx body" regression above: when a 502
    // body happens to mention "invalid_grant" (e.g. a Cloudflare error page,
    // a proxy debug line, or an operations log snippet), the account must NOT
    // be permanently disabled. The RFC 6749 §5.2 invalid_grant signal is the
    // STATUS being 400/401 — body text alone, without that status, must not
    // flip a working credential to `re-login required`. Pre-fix the leading
    // /invalid_grant/.test(message) gate matched any body text and disabled
    // the account regardless of status.
    const a = account({ expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error(
          'Token refresh failed: 502 — Bad Gateway. Past log line: invalid_grant cleared at 12:30.',
        )
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      '502',
    )
    expect(a.disabledReason).toBeNull()
    expect(
      findAccount(await readPool(), a.id)?.disabledReason ?? null,
    ).toBeNull()
  })

  test('still disables on a real 400 invalid_grant from the OAuth server', async () => {
    // The status-anchored prefix path (status === 400/401) must keep working
    // even when the body does NOT carry the literal "invalid_grant" substring.
    const a = account({ expires: Date.now() - 1 })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error(
          'Token refresh failed: 400 — {"error":"unauthorized_client"}',
        )
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      '400',
    )
    expect(a.disabledReason).toContain('invalid_grant')
    expect(findAccount(await readPool(), a.id)?.disabledReason).toContain(
      'invalid_grant',
    )
  })

  test('collapses concurrent refreshes (singleflight)', async () => {
    const a = account({ expires: Date.now() - 1 })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 10))
        return {
          access: 'fresh',
          refresh: 'r2',
          expires: Date.now() + 3_600_000,
        }
      },
    })
    await Promise.all([
      ensureAccessToken(adapter, a, Date.now()),
      ensureAccessToken(adapter, a, Date.now()),
    ])
    expect(called).toBe(1)
  })

  test("singleflight updates EVERY concurrent caller's account, not just the one that started the refresh", async () => {
    // Production fan-out: two parallel requests each call readPool() and
    // therefore hold DIFFERENT PoolAccount objects with the same id. The
    // singleflight short-circuit must mutate both — otherwise the reuser
    // sends the OLD token and the upstream 401's a perfectly fresh account.
    const a1 = account({
      id: 'shared',
      access: 'old',
      refresh: 'r-old',
      expires: Date.now() - 1,
    })
    const a2 = { ...a1 } // distinct object, same id, same stale token
    await mutatePool((pool) => {
      pool.accounts.push({ ...a1 })
    })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 10))
        return {
          access: 'fresh',
          refresh: 'r-new',
          expires: Date.now() + 3_600_000,
          accountId: 'acc_x',
        }
      },
    })
    const [t1, t2] = await Promise.all([
      ensureAccessToken(adapter, a1, Date.now()),
      ensureAccessToken(adapter, a2, Date.now()),
    ])
    expect(called).toBe(1)
    expect(t1).toBe('fresh')
    expect(t2).toBe('fresh')
    expect(a1.access).toBe('fresh')
    expect(a2.access).toBe('fresh') // would be 'old' against pre-fix code
    expect(a1.refresh).toBe('r-new')
    expect(a2.refresh).toBe('r-new')
    expect(a1.accountId).toBe('acc_x')
    expect(a2.accountId).toBe('acc_x')
  })

  test("singleflight propagates invalid_grant disabledReason to EVERY concurrent caller's account, not just the one that started the refresh", async () => {
    // Symmetric to the success-path test above: the IIFE's catch sets the
    // local disabledReason only on the job-creator. A concurrent caller
    // rejoining via `inflight` must ALSO see disabledReason on its OWN
    // local PoolAccount — otherwise fetch.ts's `if (!account.disabledReason)`
    // gate wastes an AUTH cooldown write on an already-disabled credential.
    const a1 = account({
      id: 'shared-igrant',
      access: 'old',
      refresh: 'r-igrant',
      expires: Date.now() - 1,
    })
    const a2 = { ...a1 } // distinct object, same id, same stale state
    await mutatePool((pool) => {
      pool.accounts.push({ ...a1 })
    })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 10))
        throw new Error('invalid_grant')
      },
    })
    const results = await Promise.allSettled([
      ensureAccessToken(adapter, a1, Date.now()),
      ensureAccessToken(adapter, a2, Date.now()),
    ])
    expect(called).toBe(1)
    expect(results[0]?.status).toBe('rejected')
    expect(results[1]?.status).toBe('rejected')
    expect(a1.disabledReason).toContain('invalid_grant')
    expect(a2.disabledReason).toContain('invalid_grant') // null pre-fix
    expect(findAccount(await readPool(), a1.id)?.disabledReason).toContain(
      'invalid_grant',
    )
  })

  test('singleflight: a non-invalid_grant refresh error leaves disabledReason null on EVERY concurrent caller', async () => {
    // Symmetric FALSE-branch lock for the TRUE-branch test above
    // ("singleflight propagates invalid_grant disabledReason to EVERY
    // concurrent caller's account, not just the one that started the
    // refresh"). That test pins the TRUE arm of
    // `if (isInvalidGrant(error))` in BOTH the creator's catch
    // (refresh.ts:218) AND the reuser's catch (refresh.ts:186); this
    // pins the FALSE arm on BOTH — when the in-flight refresh rejects
    // with a non-invalid_grant error (refresh lock timeout, AbortError
    // from OAUTH_HTTP_TIMEOUT_MS, transient 5xx, DNS blip), NEITHER
    // caller may permanently disable the account. A regression that
    // flips the condition to `if (!isInvalidGrant(error))` would brick
    // a healthy account on every transient blip — exactly the
    // "re-login required" failure mode the status-anchored
    // isInvalidGrant check exists to prevent (already locked for the
    // creator path by the "HTTP 400 in a 5xx body" / "invalid_grant in
    // a 5xx body" tests; this is the missing reuser counterpart).
    const a1 = account({
      id: 'shared-5xx',
      access: 'old',
      refresh: 'r-5xx',
      expires: Date.now() - 1,
    })
    const a2 = { ...a1 } // distinct object, same id, same stale state
    await mutatePool((pool) => {
      pool.accounts.push({ ...a1 })
    })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        await new Promise((r) => setTimeout(r, 10))
        // Status-anchored 503: isInvalidGrant returns false (not 400/401)
        // even though the body coincidentally contains "invalid_grant" —
        // mirrors the existing "5xx body coincidentally contains" tests
        // for full symmetry with the creator's FALSE-branch coverage.
        throw new Error(
          'Token refresh failed: 503 — Bad Gateway. Past log line: invalid_grant cleared at 12:30.',
        )
      },
    })
    const results = await Promise.allSettled([
      ensureAccessToken(adapter, a1, Date.now()),
      ensureAccessToken(adapter, a2, Date.now()),
    ])
    expect(called).toBe(1) // singleflight collapsed both callers
    expect(results[0]?.status).toBe('rejected')
    expect(results[1]?.status).toBe('rejected')
    // KEY ASSERTIONS — these break if `if (isInvalidGrant(error))` is
    // flipped in EITHER the creator's catch (refresh.ts:218) or the
    // reuser's catch (refresh.ts:186).
    expect(a1.disabledReason).toBeNull() // creator path
    expect(a2.disabledReason).toBeNull() // reuser path — previously unbound
    expect(
      findAccount(await readPool(), a1.id)?.disabledReason ?? null,
    ).toBeNull()
  })

  test('reload-before-refresh adopts a token another process already rotated (no second spend)', async () => {
    // Given: our local account is stale, but the pool on disk already holds a FRESH
    // token (a concurrent process won the refresh race and persisted it). We must
    // adopt that token, NOT spend our now-stale single-use refresh token again.
    const a = account({
      id: 'preempt',
      access: 'stale',
      refresh: 'r0',
      expires: Date.now() - 1,
      tokenGen: 0,
    })
    await mutatePool((pool) => {
      pool.accounts.push({
        ...a,
        access: 'fresh-on-disk',
        refresh: 'r1',
        expires: Date.now() + 3_600_000,
        tokenGen: 1,
      })
    })
    let called = 0
    const adapter = fakeAdapter({
      refresh: async () => {
        called += 1
        return { access: 'x', refresh: 'y', expires: 0 }
      },
    })
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe(
      'fresh-on-disk',
    )
    expect(called).toBe(0) // never spent our stale token
    expect(a.access).toBe('fresh-on-disk')
    expect(a.refresh).toBe('r1')
  })

  test('a refresh superseded mid-flight adopts the winner instead of clobbering it', async () => {
    // Given: while OUR refresh is in flight, a concurrent process rotates + persists
    // a newer token (bumping tokenGen). Our commit must NOT overwrite the winner.
    const a = account({
      id: 'race',
      refresh: 'r0',
      expires: Date.now() - 1,
      tokenGen: 0,
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        await mutatePool((pool) => {
          const s = findAccount(pool, 'race')
          if (s) {
            s.access = 'winner'
            s.refresh = 'r-winner'
            s.expires = Date.now() + 3_600_000
            s.tokenGen = 1
          }
        })
        return {
          access: 'mine',
          refresh: 'r-mine',
          expires: Date.now() + 3_600_000,
        }
      },
    })
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe('winner')
    expect(a.access).toBe('winner')
    const stored = findAccount(await readPool(), 'race')
    expect(stored?.refresh).toBe('r-winner') // our 'r-mine' did NOT win
    expect(stored?.tokenGen).toBe(1)
  })

  test('invalid_grant on a token superseded by a concurrent refresh ADOPTS, never disables', async () => {
    // The core race fix: the LOSER of a single-use-token race gets invalid_grant, but
    // the on-disk token has already advanced — so it adopts the winner rather than
    // permanently disabling a perfectly valid account (the "re-login required" bug).
    const a = account({
      id: 'race-ig',
      refresh: 'r0',
      expires: Date.now() - 1,
      tokenGen: 0,
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        await mutatePool((pool) => {
          const s = findAccount(pool, 'race-ig')
          if (s) {
            s.access = 'winner'
            s.refresh = 'r-winner'
            s.expires = Date.now() + 3_600_000
            s.tokenGen = 1
          }
        })
        throw new Error('invalid_grant')
      },
    })
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe('winner')
    expect(a.disabledReason).toBeNull()
    expect(
      findAccount(await readPool(), 'race-ig')?.disabledReason ?? null,
    ).toBeNull()
  })

  test('invalid_grant for an account not in the pool still rethrows and marks the local object', async () => {
    const a = account({ id: 'lonely', expires: Date.now() - 1 }) // never pushed
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error('invalid_grant')
      },
    })
    await expect(ensureAccessToken(adapter, a, Date.now())).rejects.toThrow(
      'invalid_grant',
    )
    expect(a.disabledReason).toContain('invalid_grant')
  })

  test('successful refresh against an account deleted from the pool mid-refresh: in-memory tokens are used, no crash, no pool resurrection', async () => {
    // Race scenario: while OUR OAuth refresh is in flight, a concurrent
    // process (or the TUI's deleteFromPool dialog in
    // tui/auth-load-balancer-tui.view.tsx) removes the account from the pool.
    // commitRefresh must (a) NOT crash on the missing `stored` (subsequent
    // `stored.access = next.access` on undefined would throw), (b) return the
    // freshly-rotated tokens so the in-flight request can still finish using
    // them, (c) NOT mark the account disabled (it's gone — re-login state
    // would be misleading), and (d) NOT resurrect the deleted account on disk.
    //
    // Symmetric with "invalid_grant for an account not in the pool still
    // rethrows and marks the local object" — that pins resolveInvalidGrant's
    // missing-account branch (refresh.ts:131-132); this pins commitRefresh's
    // (refresh.ts:106-107). Without it, a regression (e.g. removing the
    // `if (!stored) return next` guard so `stored.access = ...` blew up on
    // undefined, or replacing it with `throw new Error('gone')`) would slip
    // past the 100% coverage gate — the LINE is "covered" by the condition
    // check alone, even when the fallback `return next` path never actually
    // executes.
    const a = account({
      id: 'race-delete',
      expires: Date.now() - 1,
      tokenGen: 0,
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        // Mid-refresh: a concurrent process / the TUI delete dialog removes
        // the account between when runRefresh.readPoolAccount() loaded it and
        // when commitRefresh re-reads it under the pool write lock.
        await mutatePool((pool) => {
          pool.accounts = pool.accounts.filter((p) => p.id !== 'race-delete')
        })
        return {
          access: 'fresh',
          refresh: 'r-fresh',
          expires: Date.now() + 3_600_000,
        }
      },
    })
    // (b) returns the freshly-rotated token so the in-flight request can finish
    expect(await ensureAccessToken(adapter, a, Date.now())).toBe('fresh')
    // (b) local account object updated with the new tokens (in-process use)
    expect(a.access).toBe('fresh')
    expect(a.refresh).toBe('r-fresh')
    // (c) NOT disabled — the account is gone, not revoked
    expect(a.disabledReason).toBeNull()
    // (d) pool stays deleted — no resurrection of a user-removed account
    expect((await readPool()).accounts).toHaveLength(0)
  })
})

describe('accounts', () => {
  test('addAccount appends and de-dupes by refresh token', async () => {
    const tokens: TokenSet = { access: 'a', refresh: 'shared', expires: 1 }
    const first = await addAccount('anthropic', tokens, 'first')
    const again = await addAccount(
      'anthropic',
      { ...tokens, access: 'a2' },
      'second',
    )
    expect(again.id).toBe(first.id) // same refresh -> same account, refreshed
    expect(again.access).toBe('a2')
    const pool = await readPool()
    expect(
      pool.accounts.filter((x) => x.providerID === 'anthropic'),
    ).toHaveLength(1)
    await addAccount('anthropic', { access: 'b', refresh: 'other', expires: 1 })
    expect((await readPool()).accounts).toHaveLength(2)
  })

  test('addAccount dedup branch propagates a fresh accountId onto the existing row', async () => {
    // Regression: the re-auth dedup branch updated access/refresh/expires but
    // dropped tokens.accountId. An OpenAI re-login whose exchange decoded a
    // fresh chatgpt_account_id from the id_token silently lost it, so a row
    // stored with accountId: null kept falling back to the per-request JWT
    // decode forever.
    const first = await addAccount('openai', {
      access: 'o1',
      refresh: 'r-openai',
      expires: 1,
    })
    expect(first.accountId).toBeNull()
    const again = await addAccount('openai', {
      access: 'o2',
      refresh: 'r-openai',
      expires: 1,
      accountId: 'acct-fresh',
    })
    expect(again.id).toBe(first.id) // still the dedup path, no new row
    expect(again.accountId).toBe('acct-fresh')
    const stored = (await readPool()).accounts.find((a) => a.id === first.id)
    expect(stored?.accountId).toBe('acct-fresh')
    // A later re-login WITHOUT an id_token must not clear the stored id.
    const third = await addAccount('openai', {
      access: 'o3',
      refresh: 'r-openai',
      expires: 1,
    })
    expect(third.accountId).toBe('acct-fresh')
  })

  test('addAccount default label avoids colliding with a surviving label after a middle-of-list delete', async () => {
    // Regression: the TUI sidebar's "Delete — remove from pool" option
    // (tui/auth-load-balancer-tui.view.tsx:115 deleteFromPool) lets the user
    // remove ANY account row, not just the last one. Pre-fix, addAccount
    // derived its default label from `pool.accounts.filter(...).length + 1`,
    // so after deleting a non-last row the next default-label add would
    // collide with a surviving label (e.g. delete anthropic-2 from
    // {-1, -2, -3} -> next add becomes anthropic-3, duplicating the existing
    // anthropic-3). Two same-labeled rows then break auth_lb_rename
    // (Array.find picks the first match silently) and the switch toast
    // (src/notify.ts shows the same label for either row).
    const a1 = await addAccount('anthropic', {
      access: 'a1',
      refresh: 'r1',
      expires: 1,
    })
    await addAccount('anthropic', {
      access: 'a2',
      refresh: 'r2',
      expires: 1,
    })
    const a3 = await addAccount('anthropic', {
      access: 'a3',
      refresh: 'r3',
      expires: 1,
    })
    expect(a1.label).toBe('anthropic-1')
    expect(a3.label).toBe('anthropic-3')
    // Mimic the TUI's deleteFromPool removing anthropic-2 (the middle row).
    await mutatePool((pool) => {
      pool.accounts = pool.accounts.filter((a) => a.label !== 'anthropic-2')
    })
    // The next default-label add must NOT collide with the surviving
    // anthropic-3; it must reuse the lowest unused suffix.
    const fresh = await addAccount('anthropic', {
      access: 'a4',
      refresh: 'r4',
      expires: 1,
    })
    expect(fresh.label).toBe('anthropic-2')
    const labels = (await readPool()).accounts
      .filter((a) => a.providerID === 'anthropic')
      .map((a) => a.label)
    expect(new Set(labels).size).toBe(labels.length) // no duplicate labels
  })

  test('addAccount does NOT dedup two empty-refresh exchanges into the same row', async () => {
    // Regression: the dedup match was `a.providerID === providerID && a.refresh
    // === tokens.refresh`, treating two empty-refresh exchanges as the SAME
    // account. RFC 6749 §5.1 lets the OAuth server omit `refresh_token` at
    // exchange time, and BOTH adapters commit to writing `''` in that case
    // (anthropic/oauth.ts: `refresh: json.refresh_token || ''`; openai/oauth.ts:
    // `toTokenSet(json, '')`). Pre-fix, the second empty-refresh add silently
    // overwrote the first pool row's tokens onto the same id/label, and the
    // user lost one of the two accounts they thought they just registered. Post-
    // fix, an empty refresh is never a dedup match (it is the OPPOSITE of a
    // stable identifier) and the two adds produce two distinct pool entries
    // with distinct ids AND distinct default labels. The providerID branch in
    // the new gate is covered by adding one entry per provider — anthropic and
    // openai — so a future regression that drops `tokens.refresh ?` for ONE
    // provider can't slip past.
    const a1 = await addAccount('anthropic', {
      access: 'a1',
      refresh: '',
      expires: 1,
    })
    const a2 = await addAccount('anthropic', {
      access: 'a2',
      refresh: '',
      expires: 1,
    })
    expect(a2.id).not.toBe(a1.id) // distinct accounts, not a silent overwrite
    expect(a2.label).not.toBe(a1.label)
    expect(a1.label).toBe('anthropic-1')
    expect(a2.label).toBe('anthropic-2')
    // Symmetric for the openai providerID branch — same provider gate, same fix.
    const o1 = await addAccount('openai', {
      access: 'o1',
      refresh: '',
      expires: 1,
    })
    const o2 = await addAccount('openai', {
      access: 'o2',
      refresh: '',
      expires: 1,
    })
    expect(o2.id).not.toBe(o1.id)
    expect(o2.label).not.toBe(o1.label)
    const pool = await readPool()
    expect(pool.accounts).toHaveLength(4)
    // Existing dedup behavior for NON-empty refresh tokens must still hold —
    // a follow-up exchange with a real refresh token still folds onto the
    // matching row (covered explicitly by the sibling 'addAccount appends and
    // de-dupes by refresh token' test, plus this positive assertion).
    const again = await addAccount('anthropic', {
      access: 'a1-rotated',
      refresh: 'r-real',
      expires: 1,
    })
    expect((await readPool()).accounts).toHaveLength(5) // first real-refresh add
    const folded = await addAccount('anthropic', {
      access: 'a1-rotated-2',
      refresh: 'r-real',
      expires: 1,
    })
    expect(folded.id).toBe(again.id) // dedup still works for real refresh tokens
    expect((await readPool()).accounts).toHaveLength(5) // no new row added
  })

  test('bootstrap imports an existing opencode oauth credential once', async () => {
    await bootstrapFromOpencodeAuth('anthropic', async () => ({
      type: 'oauth',
      access: 'imp',
      refresh: 'impref',
      expires: 123,
    }))
    expect((await readPool()).accounts).toHaveLength(1)
    // second call is a no-op (already has an account)
    await bootstrapFromOpencodeAuth('anthropic', async () => ({
      type: 'oauth',
      access: 'x',
      refresh: 'y',
      expires: 1,
    }))
    expect((await readPool()).accounts).toHaveLength(1)
  })

  test('bootstrap skips non-oauth auth and swallows a throwing getAuth', async () => {
    await bootstrapFromOpencodeAuth('anthropic', async () => ({ type: 'api' }))
    expect((await readPool()).accounts).toHaveLength(0)
    await bootstrapFromOpencodeAuth('anthropic', async () => {
      throw new Error('no auth')
    })
    expect((await readPool()).accounts).toHaveLength(0)
  })
})

describe('usage-refresh', () => {
  test('seeds usage for a stale account via the usage endpoint', async () => {
    const a = account({
      usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const snapshot: UsageSnapshot = {
      hourly: { utilization: 0.1, resetAt: 0 },
      weekly: { utilization: 0.4, resetAt: 0 },
      status: null,
      capturedAt: Date.now(),
    }
    let fetched = 0
    const adapter = fakeAdapter({
      fetchUsage: async () => {
        fetched += 1
        return snapshot
      },
    })
    await refreshUsageInBackground(adapter, Date.now())
    expect(fetched).toBe(1)
    expect(
      findAccount(await readPool(), a.id)?.usage.weekly?.utilization,
    ).toBeCloseTo(0.4, 5)
  })

  test('skips fresh accounts and a null usage result', async () => {
    const fresh = account({
      usage: {
        hourly: null,
        weekly: null,
        status: null,
        capturedAt: Date.now(),
      },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...fresh })
    })
    let fetched = 0
    const adapter = fakeAdapter({
      fetchUsage: async () => {
        fetched += 1
        return null
      },
    })
    await refreshUsageInBackground(adapter, Date.now())
    expect(fetched).toBe(0) // fresh -> not polled
  })

  test('does NOT overwrite stored usage when fetchUsage returns null on a stale account', async () => {
    // Regression lock for the `if (snapshot)` guard in usage-refresh.ts. The
    // sibling 'skips fresh accounts and a null usage result' test sets
    // capturedAt = Date.now() on the seeded account, so the stale gate
    // (capturedAt === 0 || now - capturedAt > SEED_TTL_MS) is FALSE and the
    // loop `continue`s BEFORE reaching fetchUsage — `fetched === 0` there is
    // achieved by SKIP, not by null-result handling. Line coverage on the
    // `if (snapshot) {` line still hits 100% via the sibling 'seeds usage for
    // a stale account' test (where snapshot is non-null), but the FALSE
    // branch — "do not overwrite stored usage when fetchUsage returns null
    // for a STALE account" — is otherwise unbound. A regression that
    // simplified `if (snapshot) { ...stored.usage = snapshot... }` to
    // `stored.usage = snapshot` would silently zero hourly/weekly/status on
    // every transient null (Codex endpoint missing rate_limit, Anthropic
    // endpoint JSON parse failure, network blip → fetchUsage returns null),
    // demoting the account in weeklyUrgency until the next real response
    // re-seeds it via parseUsageHeaders.
    const stored: UsageSnapshot = {
      hourly: { utilization: 0.42, resetAt: Date.now() + 2 * 60 * 60 * 1000 },
      weekly: { utilization: 0.71, resetAt: Date.now() + 30 * 60 * 60 * 1000 },
      status: 'warning',
      capturedAt: 0, // STALE -> NOT skipped by the fresh gate
    }
    const a = account({ usage: stored })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    let fetched = 0
    const adapter = fakeAdapter({
      fetchUsage: async () => {
        fetched += 1
        return null
      },
    })
    await refreshUsageInBackground(adapter, Date.now())
    // Distinguishes this test from the fresh-skip sibling: fetchUsage WAS
    // actually called (we passed the stale gate), and the existing stored
    // snapshot is still intact — the null guard absorbed the transient null.
    expect(fetched).toBe(1)
    const reread = findAccount(await readPool(), a.id)
    expect(reread?.usage.hourly?.utilization).toBeCloseTo(0.42, 5)
    expect(reread?.usage.weekly?.utilization).toBeCloseTo(0.71, 5)
    expect(reread?.usage.status).toBe('warning')
    expect(reread?.usage.capturedAt).toBe(0)
  })

  test('an endpoint snapshot that lost the weekly reset keeps the stored anchor, rolled forward past now', async () => {
    // Out-of-band quota reset: the endpoint reports utilization 0 with
    // resets_at null. The account's FIXED weekly anchor (here: already
    // elapsed) must survive the merge, advanced by one week — not collapse to
    // "unknown" (which would demote the account to a full-window assumption).
    const WEEK = 7 * 24 * 60 * 60 * 1000
    const now = Date.now()
    const pastAnchor = now - 60_000
    const a = account({
      usage: {
        hourly: null,
        weekly: { utilization: 1, resetAt: pastAnchor },
        status: null,
        capturedAt: 0, // stale -> polled
      },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      fetchUsage: async () => ({
        hourly: { utilization: 0, resetAt: 0 },
        weekly: { utilization: 0, resetAt: 0 },
        status: null,
        capturedAt: now,
      }),
    })
    await refreshUsageInBackground(adapter, now)
    const reread = findAccount(await readPool(), a.id)
    expect(reread?.usage.weekly).toEqual({
      utilization: 0,
      resetAt: pastAnchor + WEEK,
    })
    // hourly windows are ROLLING (no fixed anchor) — never synthesized.
    expect(reread?.usage.hourly).toEqual({ utilization: 0, resetAt: 0 })
  })

  test('swallows errors from the refresh/usage path', async () => {
    const a = account({
      expires: Date.now() - 1,
      usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    const adapter = fakeAdapter({
      refresh: async () => {
        throw new Error('boom')
      },
    })
    await expect(
      refreshUsageInBackground(adapter, Date.now()),
    ).resolves.toBeUndefined()
  })

  test('lastPoll throttle holds across a multi-provider pool', async () => {
    // Regression: the prune gate compares lastPoll.size against
    // pool.accounts.length (the historical alive-account upper bound), NOT
    // the per-provider filtered subset. In a 2-anthropic + 1-openai pool the
    // per-provider `accounts.length` is 2 but `lastPoll` grows to size 3
    // once both providers have ever been polled — the pre-fix gate
    // `lastPoll.size > accounts.length` (3 > 2) fired on every call and ran
    // the idempotent prune loop pointlessly; the post-fix gate
    // `lastPoll.size > pool.accounts.length` (3 > 3) skips the prune as
    // designed. The user-visible behavior this fix preserves is the throttle:
    // a re-entrant call within `SEED_TTL_MS` must short-circuit via
    // `polledRecently` and NOT re-poll fetchUsage.
    const a1 = account({
      providerID: 'anthropic',
      usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    })
    const a2 = account({
      providerID: 'anthropic',
      usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    })
    const o1 = account({
      providerID: 'openai',
      usage: { hourly: null, weekly: null, status: null, capturedAt: 0 },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a1 }, { ...a2 }, { ...o1 })
    })
    let fetched = 0
    const adapter = fakeAdapter({
      fetchUsage: async () => {
        fetched += 1
        return {
          hourly: null,
          weekly: null,
          status: null,
          capturedAt: Date.now(),
        }
      },
    })
    const t = Date.now()
    await refreshUsageInBackground(adapter, t)
    // 2 anthropic accounts polled once each; the openai row is filtered out.
    expect(fetched).toBe(2)
    await refreshUsageInBackground(adapter, t)
    await refreshUsageInBackground(adapter, t)
    // 2nd + 3rd same-`t` calls short-circuit via polledRecently — throttle intact.
    expect(fetched).toBe(2)
  })

  test('uses a passed pool snapshot instead of re-reading the pool file', async () => {
    // The request hot path (fetch.ts) hands over the pool it JUST read for
    // account selection so seeding adds no second file read per request. To
    // prove the snapshot is what's consulted: the ON-DISK pool row is FRESH
    // (would be skipped), while the passed snapshot's copy is STALE — a
    // re-read would skip fetchUsage, the snapshot path must poll it.
    const now = Date.now()
    const a = account({
      usage: { hourly: null, weekly: null, status: null, capturedAt: now },
    })
    await mutatePool((pool) => {
      pool.accounts.push({ ...a })
    })
    let fetched = 0
    const adapter = fakeAdapter({
      fetchUsage: async () => {
        fetched += 1
        return { hourly: null, weekly: null, status: null, capturedAt: now }
      },
    })
    const snapshot = {
      version: 1 as const,
      accounts: [{ ...a, usage: { ...a.usage, capturedAt: 0 } }],
      lastSelected: {},
      sessions: {},
    }
    await refreshUsageInBackground(adapter, now, snapshot)
    expect(fetched).toBe(1) // snapshot's STALE view won — no silent re-read
    // Omitting the snapshot still reads the disk pool: by now+6min the disk
    // row (capturedAt stamped by the write above) is past SEED_TTL_MS and the
    // lastPoll throttle has lapsed, so the readPool path polls it again.
    await refreshUsageInBackground(adapter, now + 6 * 60 * 1000)
    expect(fetched).toBe(2)
  })
})

describe('adapter delegation', () => {
  test('anthropic adapter wires transforms, usage, and error classification', async () => {
    expect((await anthropicAdapter.authorize()).url).toContain('claude.ai')
    const h = new Headers()
    anthropicAdapter.applyAuth(h, account({ access: 'tokA' }))
    expect(h.get('authorization')).toBe('Bearer tokA')
    expect(
      anthropicAdapter
        .transformUrl('https://api.anthropic.com/v1/messages')
        .toString(),
    ).toContain('beta=true')
    expect(
      anthropicAdapter.transformBody(JSON.stringify({ messages: [] })),
    ).toContain('Claude Agent SDK')
    expect(
      anthropicAdapter.transformResponse(new Response('{"name":"mcp_Bash"}')),
    ).toBeInstanceOf(Response)
    expect(anthropicAdapter.parseUsageHeaders(new Headers(), 0)).toBeNull()
    expect(anthropicAdapter.classifyError(429)).toBe('account')
    expect(anthropicAdapter.classifyError(402)).toBe('account')
    expect(anthropicAdapter.classifyError(401)).toBe('auth')
    expect(anthropicAdapter.classifyError(403)).toBe('auth')
    expect(anthropicAdapter.classifyError(503)).toBe('service')
    expect(anthropicAdapter.classifyError(200)).toBe('ok')
  })

  test('openai adapter wires transforms, usage, and error classification', async () => {
    expect((await openaiAdapter.authorize()).url).toContain('auth.openai.com')
    const h = new Headers()
    openaiAdapter.applyAuth(
      h,
      account({ providerID: 'openai', access: 'tokO', accountId: 'acc' }),
    )
    expect(h.get('authorization')).toBe('Bearer tokO')
    expect(
      openaiAdapter
        .transformUrl('https://api.openai.com/v1/responses')
        .toString(),
    ).toContain('codex/responses')
    expect(
      JSON.parse(openaiAdapter.transformBody(JSON.stringify({}))).store,
    ).toBe(false)
    expect(openaiAdapter.transformResponse(new Response('x'))).toBeInstanceOf(
      Response,
    )
    expect(openaiAdapter.parseUsageHeaders(new Headers(), 0)).toBeNull()
    expect(openaiAdapter.classifyError(429)).toBe('account')
    expect(openaiAdapter.classifyError(401)).toBe('auth')
    expect(openaiAdapter.classifyError(500)).toBe('service')
    expect(openaiAdapter.classifyError(200)).toBe('ok')
  })

  test('adapter exchange/refresh/fetchUsage delegate to the network layer', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 1,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch
    try {
      expect(
        await anthropicAdapter.exchange(
          'https://cb?code=C&state=S',
          'v',
          'https://cb',
          'S',
        ),
      ).not.toBeNull()
      expect((await anthropicAdapter.refresh('r')).access).toBe('a')
      // body parses but carries NEITHER window key -> not the usage shape ->
      // discard the poll entirely (keep last-known) instead of zeroing windows
      expect(await anthropicAdapter.fetchUsage(account(), 0)).toBeNull()
      expect(
        await openaiAdapter.exchange(
          'https://cb?code=C&state=S',
          'v',
          'https://cb',
          'S',
        ),
      ).not.toBeNull()
      expect((await openaiAdapter.refresh('r')).access).toBe('a')
      // no rateLimits in body -> null
      expect(
        await openaiAdapter.fetchUsage(account({ providerID: 'openai' }), 0),
      ).toBeNull()
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
