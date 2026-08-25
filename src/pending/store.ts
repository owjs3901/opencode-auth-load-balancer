import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { type LockOptions, withLock as withFileLock } from '../pool/lock'
import { pendingFilePath } from '../pool/paths'
import { writeJsonAtomic } from '../pool/store'
import { ignore, isPlainObject } from '../util'
import type {
  PendingFile,
  PendingRef,
  PendingSchedule,
  PendingTurn,
} from './types'

const PENDING_WRITE_LOCK: LockOptions = {
  staleMs: 30_000,
  timeoutMs: 30_000,
  retryMs: 25,
  heartbeatMs: 5_000,
}

function emptyPending(): PendingFile {
  return { version: 1, turns: [] }
}

export class PendingReadError extends Error {
  constructor(
    readonly path: string,
    readonly reason: unknown,
  ) {
    super(`Failed to read pending-turn file: ${path}`)
    this.name = 'PendingReadError'
  }
}

export function pendingKey(ref: PendingRef): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ref.workspace,
        ref.providerID,
        ref.sessionID,
        ref.messageID,
      ]),
    )
    .digest('hex')
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function normalizeTurn(value: unknown): PendingTurn | null {
  if (!isPlainObject(value)) return null
  const row = value as Partial<PendingTurn>
  if (
    typeof row.workspace !== 'string' ||
    typeof row.providerID !== 'string' ||
    typeof row.sessionID !== 'string' ||
    typeof row.messageID !== 'string' ||
    !finiteNonNegative(row.createdAt) ||
    !finiteNonNegative(row.updatedAt) ||
    !finiteNonNegative(row.nextCheckAt) ||
    (row.resumeAt !== null && !finiteNonNegative(row.resumeAt))
  )
    return null
  const ref: PendingRef = {
    workspace: row.workspace,
    providerID: row.providerID,
    sessionID: row.sessionID,
    messageID: row.messageID,
  }
  return {
    ...ref,
    key: pendingKey(ref),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    nextCheckAt: row.nextCheckAt,
    resumeAt: row.resumeAt,
  }
}

async function readRaw(): Promise<PendingFile> {
  let text: string
  try {
    text = await readFile(pendingFilePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return emptyPending()
    throw new PendingReadError(pendingFilePath(), error)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      !isPlainObject(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.turns)
    )
      return emptyPending()
    const turns: PendingTurn[] = []
    const positions = new Map<string, number>()
    for (const value of parsed.turns) {
      const turn = normalizeTurn(value)
      if (!turn) continue
      const position = positions.get(turn.key)
      if (position === undefined) {
        positions.set(turn.key, turns.length)
        turns.push(turn)
        continue
      }
      const existing = turns[position]
      if (!existing) continue
      const createdAt = Math.min(existing.createdAt, turn.createdAt)
      if (turn.updatedAt > existing.updatedAt)
        turns[position] = { ...turn, createdAt }
      else existing.createdAt = createdAt
    }
    return { version: 1, turns }
  } catch {
    return emptyPending()
  }
}

async function writeRaw(file: PendingFile): Promise<void> {
  await writeJsonAtomic(pendingFilePath(), JSON.stringify(file, null, 2))
}

let chain: Promise<unknown> = Promise.resolve()
function withProcessLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(ignore, ignore)
  return run
}

function pendingLockDir(): string {
  return `${pendingFilePath()}.lock`
}

export async function readPending(): Promise<PendingFile> {
  return withProcessLock(readRaw)
}

async function mutatePending<T>(
  fn: (file: PendingFile) => T | Promise<T>,
): Promise<T> {
  return withProcessLock(() =>
    withFileLock(pendingLockDir(), PENDING_WRITE_LOCK, async () => {
      const file = await readRaw()
      const result = await fn(file)
      await writeRaw(file)
      return result
    }),
  )
}

export async function upsertPending(
  ref: PendingRef,
  schedule: PendingSchedule,
): Promise<PendingTurn> {
  return mutatePending((file) => {
    const key = pendingKey(ref)
    const existing = file.turns.find((turn) => turn.key === key)
    const turn: PendingTurn = {
      ...ref,
      key,
      createdAt: existing?.createdAt ?? schedule.now,
      updatedAt: schedule.now,
      nextCheckAt: schedule.nextCheckAt,
      resumeAt: schedule.resumeAt,
    }
    if (existing) Object.assign(existing, turn)
    else file.turns.push(turn)
    return existing ?? turn
  })
}

export async function removePending(
  refOrKey: PendingRef | string,
): Promise<boolean> {
  const key = typeof refOrKey === 'string' ? refOrKey : pendingKey(refOrKey)
  return mutatePending((file) => {
    const before = file.turns.length
    file.turns = file.turns.filter((turn) => turn.key !== key)
    return file.turns.length !== before
  })
}

export async function removePendingSession(
  workspace: string,
  sessionID: string,
): Promise<number> {
  return mutatePending((file) => {
    const before = file.turns.length
    file.turns = file.turns.filter(
      (turn) => turn.workspace !== workspace || turn.sessionID !== sessionID,
    )
    return before - file.turns.length
  })
}

export async function listPendingForWorkspace(
  workspace: string,
  providerID?: string,
): Promise<PendingTurn[]> {
  const file = await readPending()
  return file.turns.filter(
    (turn) =>
      turn.workspace === workspace &&
      (providerID === undefined || turn.providerID === providerID),
  )
}
