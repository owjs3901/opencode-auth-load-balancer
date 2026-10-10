export type SyncErrorCode =
  | 'bad-link'
  | 'not-set-up'
  | 'bad-blob'
  | 'bad-version'
  | 'decrypt'
  | 'rolled-back'
  | 'too-large'
  | 'rate-limited'
  | 'not-found'
  | 'network'
  | 'no-auth'
  | 'http'
  | 'write-denied'

/** What each failure tells the user. Short, and never carries the link, the key, or a response body. */
const MESSAGES: Record<SyncErrorCode, string> = {
  'bad-link':
    'That is not a gist link with a key (https://gist.github.com/<user>/<id>#<key>).',
  'not-set-up': 'Sync is not set up on this machine.',
  'bad-blob': 'The gist does not hold a sync file.',
  'bad-version': 'The gist was written by a newer version; update this plugin.',
  'rolled-back':
    'The gist holds an older snapshot than one already applied; ignoring it.',
  decrypt:
    'The gist could not be decrypted: the link key is wrong or the gist was changed.',
  'too-large': 'The gist is larger than a sync file can be.',
  'rate-limited': 'GitHub is rate limiting this machine; trying again later.',
  'not-found': 'The gist no longer exists.',
  network: 'GitHub could not be reached.',
  'no-auth':
    'Uploading needs GITHUB_TOKEN or GH_TOKEN (gist scope), or a logged-in gh CLI.',
  http: 'GitHub refused the request.',
  'write-denied':
    'This GitHub account cannot update the gist; downloading only.',
}

/** A sync failure with a fixed, non-leaky message; `retryAfterMs` accompanies `rate-limited`. */
export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(MESSAGES[code])
    this.name = 'SyncError'
  }
}

/** The user-facing line for any thrown value: a sync error's own text, else a generic one. */
export function describeSyncError(error: unknown): string {
  return error instanceof SyncError ? error.message : 'Sync failed.'
}
