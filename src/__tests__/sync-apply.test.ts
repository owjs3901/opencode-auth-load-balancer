import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { placeTokens } from '../accounts'
import { poolFilePath } from '../pool/paths'
import { mutatePool, readPool } from '../pool/store'
import { applyPlan, land } from '../sync/apply'
import { fingerprint } from '../sync/crypto'
import { type ImportJob, type MergeMemory, planMerge } from '../sync/merge'
import { entryKey, type SyncEntry } from '../sync/payload'
import { newRefs } from '../sync/state'
import {
  emptyUsage,
  MANUAL_DISABLED_REASON,
  type PoolAccount,
  type PoolFile,
  STATIC_CREDENTIAL_EXPIRES,
  type TokenSet,
} from '../types'
import { testAccount } from './fixtures/account'
import { fakeAdapter } from './fixtures/adapter'
import { CLAUDE_TOKEN, CLAUDE_TOKEN_2, KIMI_KEY } from './fixtures/sync'
import { claudeSyncAdapter, orgOf } from './fixtures/sync-adapters'

const ORIGIN = 'c'.repeat(32)
const DIR = mkdtempSync(join(tmpdir(), 'auth-lb-sync-apply-'))

beforeEach(() => {
  process.env.OPENCODE_AUTH_LB_DIR = DIR
})
afterEach(() => {
  delete process.env.OPENCODE_AUTH_LB_DIR
})

const pool = (...accounts: PoolAccount[]): PoolFile => ({
  version: 1,
  accounts,
  lastSelected: {},
  sessions: {},
})

const entry = (
  id: string,
  secret: string,
  provider = 'anthropic',
): SyncEntry => ({
  origin: ORIGIN,
  id,
  providerID: provider,
  label: id,
  secret,
})
const claudeTokens = (token: string): TokenSet => ({
  access: token,
  refresh: '',
  expires: STATIC_CREDENTIAL_EXPIRES,
  inferenceOnly: true,
  usage: emptyUsage(),
})
const kimiTokens = (key: string, accountId: string): TokenSet => ({
  access: key,
  refresh: '',
  expires: STATIC_CREDENTIAL_EXPIRES,
  accountId,
})
const held = (id: string, token: string, over: Partial<PoolAccount> = {}) =>
  testAccount({
    id,
    label: id,
    refresh: '',
    access: token,
    inferenceToken: token,
    expires: STATIC_CREDENTIAL_EXPIRES,
    ...over,
  })
const ref = (accountId: string, secret: string) => ({
  accountId,
  fingerprint: fingerprint(secret),
})
const job = (e: SyncEntry, previous?: ReturnType<typeof ref>): ImportJob => ({
  entry: e,
  ...(previous ? { previous } : {}),
})

describe('landing one credential under the pool lock', () => {
  test('a new credential becomes a row with a pool-unique label', () => {
    const p = pool(held('x', CLAUDE_TOKEN_2, { label: 'work', orgId: 'o' }))
    const landing = land(
      p,
      job(entry('e1', CLAUDE_TOKEN)),
      claudeTokens(CLAUDE_TOKEN),
    )
    expect(landing.kind).toBe('placed')
    expect(p.accounts).toHaveLength(2)
    const labels = p.accounts.map((a) => a.label)
    const again = land(
      p,
      job({ ...entry('e2', `${CLAUDE_TOKEN}2`), label: 'work' }),
      claudeTokens(`${CLAUDE_TOKEN}2`),
    )
    expect(again.kind).toBe('placed')
    expect(p.accounts.map((a) => a.label)).toEqual([...labels, 'work (2)'])
  })

  test('a rotation replaces the credential in the row that still holds the old one', () => {
    const own = held('imported', CLAUDE_TOKEN)
    const p = pool(own)
    const landing = land(
      p,
      job(entry('e1', CLAUDE_TOKEN_2), ref('imported', CLAUDE_TOKEN)),
      claudeTokens(CLAUDE_TOKEN_2),
    )
    expect(landing).toMatchObject({ kind: 'placed', row: { id: 'imported' } })
    expect(p.accounts).toHaveLength(1)
    expect(own.inferenceToken).toBe(CLAUDE_TOKEN_2)
  })

  test('a user row that came to hold the new secret since the plan is never claimed, and the old secret is taken back', () => {
    const imported = held('imported', CLAUDE_TOKEN, { orgId: 'a' })
    const mine = held('mine', CLAUDE_TOKEN_2, { orgId: 'b' })
    const p = pool(imported, mine)
    const landing = land(
      p,
      job(entry('e1', CLAUDE_TOKEN_2), ref('imported', CLAUDE_TOKEN)),
      claudeTokens(CLAUDE_TOKEN_2),
    )
    expect(landing).toMatchObject({ kind: 'skipped' })
    expect(p.accounts.map((a) => a.id)).toEqual(['mine'])
    expect(mine.inferenceToken).toBe(CLAUDE_TOKEN_2)
  })

  test("the previous row was replaced locally: the entry lands as new and the user's row is untouched", () => {
    const repointed = held('imported', 'sk-ant-oat01-USER-own-1')
    const p = pool(repointed)
    const landing = land(
      p,
      job(entry('e1', CLAUDE_TOKEN_2), ref('imported', CLAUDE_TOKEN)),
      claudeTokens(CLAUDE_TOKEN_2),
    )
    expect(landing.kind).toBe('placed')
    expect(repointed.inferenceToken).toBe('sk-ant-oat01-USER-own-1')
    expect(p.accounts).toHaveLength(2)
  })

  test('a key never lands on an OAuth login of the same account', () => {
    const oauth = testAccount({
      id: 'oauth',
      providerID: 'kimi-code-plan-cn',
      access: 'OAUTH-ACCESS',
      refresh: 'OAUTH-REFRESH',
      accountId: 'kimi-user-1',
    })
    const p = pool(oauth)
    const landing = land(
      p,
      job(entry('k', KIMI_KEY, 'kimi-code-plan-cn')),
      kimiTokens(KIMI_KEY, 'kimi-user-1'),
    )
    expect(landing).toMatchObject({ kind: 'skipped' })
    expect(oauth).toMatchObject({
      access: 'OAUTH-ACCESS',
      refresh: 'OAUTH-REFRESH',
    })
    expect(p.accounts).toHaveLength(1)
  })

  test("a key of an account the user already keeps a key for is the user's, not overwritten", () => {
    const mine = testAccount({
      id: 'mine',
      providerID: 'kimi-code-plan-cn',
      access: 'user-own-key-0123456789',
      refresh: '',
      expires: STATIC_CREDENTIAL_EXPIRES,
      accountId: 'kimi-user-1',
    })
    const p = pool(mine)
    expect(
      land(
        p,
        job(entry('k', KIMI_KEY, 'kimi-code-plan-cn')),
        kimiTokens(KIMI_KEY, 'kimi-user-1'),
      ),
    ).toMatchObject({ kind: 'skipped' })
    expect(mine.access).toBe('user-own-key-0123456789')
  })

  test("an entry that changed provider takes the old credential out of the other provider's row and never writes onto it", () => {
    const oauth = testAccount({
      id: 'mine',
      label: 'mine',
      access: 'MY-ACCESS',
      refresh: 'MY-REFRESH',
      expires: 12345,
      accountId: 'acct',
      inferenceToken: CLAUDE_TOKEN,
      inferenceExpires: 99,
      orgId: 'org-1',
    })
    const p = pool(oauth)
    const landing = land(
      p,
      job(
        entry('p1', KIMI_KEY, 'kimi-code-plan-cn'),
        ref('mine', CLAUDE_TOKEN),
      ),
      kimiTokens(KIMI_KEY, 'kimi-user-1'),
    )
    expect(landing.kind).toBe('placed')
    expect(oauth).toMatchObject({
      access: 'MY-ACCESS',
      refresh: 'MY-REFRESH',
      expires: 12345,
      accountId: 'acct',
      orgId: 'org-1',
    })
    expect(oauth).not.toHaveProperty('inferenceToken')
    expect(oauth).not.toHaveProperty('inferenceExpires')
    expect(p.accounts).toHaveLength(2)
    expect(p.accounts[1]).toMatchObject({
      providerID: 'kimi-code-plan-cn',
      access: KIMI_KEY,
      refresh: '',
    })
  })
})

describe('sync never takes the place of a token the account already has', () => {
  const oauth = (id: string, over: Partial<PoolAccount> = {}) =>
    testAccount({
      id,
      label: id,
      access: `ACCESS-${id}`,
      refresh: `REFRESH-${id}`,
      orgId: 'org-1',
      ...over,
    })
  const withOrg = (token: string, orgId: string | undefined): TokenSet => ({
    ...claudeTokens(token),
    ...(orgId ? { orgId } : {}),
  })

  test("an account whose own OAuth row already has a token (minted or pasted) keeps it, and the other machine's token is skipped", () => {
    const mine = oauth('mine', { inferenceToken: CLAUDE_TOKEN })
    const p = pool(mine)
    const landing = land(
      p,
      job(entry('theirs', CLAUDE_TOKEN_2)),
      withOrg(CLAUDE_TOKEN_2, 'org-1'),
    )
    expect(landing).toEqual({
      kind: 'skipped',
      blocker: 'mine',
      holds: fingerprint(CLAUDE_TOKEN),
    })
    expect(mine.inferenceToken).toBe(CLAUDE_TOKEN)
    expect(p.accounts).toHaveLength(1)
  })

  test('a token imported earlier from another entry is not replaced by a second entry for the same account', () => {
    const first = land(
      pool(),
      job(entry('one', CLAUDE_TOKEN)),
      withOrg(CLAUDE_TOKEN, 'org-1'),
    )
    expect(first.kind).toBe('placed')
    const p = pool(held('imported', CLAUDE_TOKEN, { orgId: 'org-1' }))
    const second = land(
      p,
      job(entry('two', CLAUDE_TOKEN_2)),
      withOrg(CLAUDE_TOKEN_2, 'org-1'),
    )
    expect(second).toMatchObject({ kind: 'skipped', blocker: 'imported' })
    expect(p.accounts).toHaveLength(1)
    expect(p.accounts[0]?.inferenceToken).toBe(CLAUDE_TOKEN)
  })

  test('an account with no token gets one on its own OAuth row; one whose token was given up on is replaced', () => {
    const bare = oauth('bare')
    const p = pool(bare)
    expect(
      land(p, job(entry('e', CLAUDE_TOKEN)), withOrg(CLAUDE_TOKEN, 'org-1')),
    ).toMatchObject({ kind: 'placed', row: { id: 'bare' } })
    expect(bare.inferenceToken).toBe(CLAUDE_TOKEN)

    const dead = oauth('dead', {
      inferenceToken: CLAUDE_TOKEN,
      disabledReason: '401 token revoked',
    })
    const q = pool(dead)
    expect(
      land(
        q,
        job(entry('e', CLAUDE_TOKEN_2)),
        withOrg(CLAUDE_TOKEN_2, 'org-1'),
      ),
    ).toMatchObject({ kind: 'placed', row: { id: 'dead' } })
    expect(dead.inferenceToken).toBe(CLAUDE_TOKEN_2)
  })

  test('a token the user disabled on purpose is still theirs and is not replaced', () => {
    const off = oauth('off', {
      inferenceToken: CLAUDE_TOKEN,
      disabledReason: MANUAL_DISABLED_REASON,
    })
    expect(
      land(
        pool(off),
        job(entry('e', CLAUDE_TOKEN_2)),
        withOrg(CLAUDE_TOKEN_2, 'org-1'),
      ).kind,
    ).toBe('skipped')
    expect(off.inferenceToken).toBe(CLAUDE_TOKEN)
  })

  test('a token for another organization, or whose organization is unknown, or that two rows could claim, gets a row of its own', () => {
    const mine = oauth('mine', { inferenceToken: CLAUDE_TOKEN })
    for (const [rows, org] of [
      [[mine], 'org-2'],
      [[mine], undefined],
      [[mine, oauth('twin', { inferenceToken: CLAUDE_TOKEN })], 'org-1'],
    ] as const) {
      const p = pool(...rows)
      expect(
        land(p, job(entry('e', CLAUDE_TOKEN_2)), withOrg(CLAUDE_TOKEN_2, org))
          .kind,
      ).toBe('placed')
      expect(p.accounts).toHaveLength(rows.length + 1)
      expect(mine.inferenceToken).toBe(CLAUDE_TOKEN)
    }
  })

  test('a rotation of an entry still replaces the token it was imported as, in place', () => {
    const imported = held('imported', CLAUDE_TOKEN, { orgId: 'org-1' })
    const p = pool(imported)
    expect(
      land(
        p,
        job(entry('e', CLAUDE_TOKEN_2), ref('imported', CLAUDE_TOKEN)),
        withOrg(CLAUDE_TOKEN_2, 'org-1'),
      ),
    ).toMatchObject({ kind: 'placed', row: { id: 'imported' } })
    expect(imported.inferenceToken).toBe(CLAUDE_TOKEN_2)
  })

  test('the pasted-token pairing outside sync keeps its behavior: a confirmed renewal still replaces', () => {
    const mine = oauth('mine', {
      inferenceToken: CLAUDE_TOKEN,
      usage: {
        hourly: null,
        weekly: { utilization: 0.1, resetAt: Date.now() + 86_400_000 },
        capturedAt: Date.now(),
      },
    })
    const p = pool(mine)
    placeTokens(
      p,
      'anthropic',
      {
        ...withOrg(CLAUDE_TOKEN_2, 'org-1'),
        usage: {
          hourly: null,
          weekly: { utilization: 0.1, resetAt: Date.now() + 86_400_000 },
          capturedAt: Date.now(),
        },
      },
      'pasted',
      undefined,
    )
    expect(mine.inferenceToken).toBe(CLAUDE_TOKEN_2)
    expect(p.accounts).toHaveLength(1)
  })
})
describe('applying a plan', () => {
  /** Make every pool write fail fast (the pool file becomes a directory); returns the undo. */
  async function breakPool(): Promise<() => Promise<void>> {
    const path = poolFilePath()
    const text = await readFile(path, 'utf8').catch(() => null)
    await rm(path, { force: true })
    await mkdir(path)
    return async () => {
      await rm(path, { recursive: true, force: true })
      if (text !== null) await writeFile(path, text)
    }
  }

  /** A Claude probe that breaks the pool the moment `trip` is verified. */
  function tripping(trip: string, undo: { run?: () => Promise<void> }) {
    const probe = claudeSyncAdapter().tokenLogin
    return fakeAdapter({
      id: 'anthropic',
      tokenLogin: {
        label: 'setup-token',
        url: '',
        instructions: '',
        exchange: async (token) => {
          const tokens = (await probe?.exchange(token)) ?? null
          if (token === trip) undo.run = await breakPool()
          return tokens
        },
      },
    })
  }

  const key = (id: string) => `${ORIGIN}/${id}`
  const memory = (over: Partial<MergeMemory> = {}): MergeMemory => ({
    origin: 'd'.repeat(32),
    imported: newRefs(),
    skipped: {},
    ...over,
  })

  test('a write that fails after another landed keeps the first on record and defers the second; a retry finishes it', async () => {
    const undo: { run?: () => Promise<void> } = {}
    const entries = [entry('e1', CLAUDE_TOKEN), entry('e2', CLAUDE_TOKEN_2)]
    const snapshot = { entries, listed: new Set(entries.map(entryKey)) }
    const first = await applyPlan(planMerge([], snapshot, memory()), memory(), [
      tripping(CLAUDE_TOKEN_2, undo),
    ])
    await undo.run?.()
    expect(first).toMatchObject({ added: 1, deferred: 1 })
    expect(Object.keys(first.imported)).toEqual([key('e1')])
    expect((await readPool()).accounts).toHaveLength(1)

    const plan = planMerge(
      (await readPool()).accounts,
      snapshot,
      memory({ imported: first.imported }),
    )
    expect(plan.imports.map((j) => j.entry.id)).toEqual(['e2'])
    const second = await applyPlan(plan, first, [claudeSyncAdapter(orgOf)])
    expect(second).toMatchObject({ added: 1, deferred: 0 })
    expect(Object.keys(second.imported).sort()).toEqual([key('e1'), key('e2')])
    expect((await readPool()).accounts).toHaveLength(2)
  })

  test('a removal that cannot be written keeps its reference for the next try', async () => {
    const gone = ref('row', CLAUDE_TOKEN)
    const imported = newRefs({ gone })
    const undo = await breakPool()
    const result = await applyPlan(
      { imports: [], drops: [['gone', gone]], forgets: [] },
      { imported, skipped: {} },
      [],
    )
    await undo()
    expect(result).toMatchObject({ removed: 0, deferred: 1 })
    expect(Object.keys(result.imported)).toEqual(['gone'])
  })

  test('a credential the user already holds is neither counted nor tracked, and is remembered as skipped', async () => {
    await mutatePool((p) => {
      p.accounts = [held('mine', CLAUDE_TOKEN_2)]
    })
    const plan = {
      imports: [job(entry('e1', CLAUDE_TOKEN_2))],
      drops: [],
      forgets: [],
    }
    const result = await applyPlan(plan, memory(), [claudeSyncAdapter()])
    expect(result).toMatchObject({ added: 0, updated: 0, deferred: 0 })
    expect(Object.keys(result.imported)).toEqual([])
    expect(result.skipped[key('e1')]).toEqual({
      fingerprint: fingerprint(CLAUDE_TOKEN_2),
      blocker: 'mine',
      holds: fingerprint(CLAUDE_TOKEN_2),
    })
  })
})
