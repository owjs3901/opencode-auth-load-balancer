import { acquireLock, type LockHandle, type LockOptions } from '../pool/lock'
import { pendingFilePath } from '../pool/paths'

const DEFAULT_PENDING_LEASE: LockOptions = {
  staleMs: 30_000,
  timeoutMs: 0,
  retryMs: 25,
  heartbeatMs: 5_000,
}

export function pendingLeasePath(key: string): string {
  return `${pendingFilePath()}.${key}.lease`
}

export function acquirePendingLease(
  key: string,
  options: LockOptions = DEFAULT_PENDING_LEASE,
): Promise<LockHandle> {
  return acquireLock(pendingLeasePath(key), options)
}
