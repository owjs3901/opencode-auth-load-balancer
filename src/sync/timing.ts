/** A subscriber asks GitHub at most this often; the due time is persisted, so every window shares it. */
export const POLL_MS = 15 * 60_000
/** After a failed upload the publisher waits this long (or as long as GitHub asked) before the next try. */
export const PUBLISH_RETRY_MS = 5 * 60_000
