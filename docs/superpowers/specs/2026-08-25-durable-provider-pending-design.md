# Durable Provider-Quota Pending Design

**Date:** 2026-08-25

**Status:** Approved in chat; awaiting written-spec review

**Scope:** `opencode-auth-load-balancer` stable plugin API (`@opencode-ai/plugin >=1.17.18`)

## Goal

When every account for a provider is blocked by account-wide quota, keep each OpenCode session's turn pending instead of sending a request that is already known to fail with `429`. Send the turn when quota becomes available, preserve it across an OpenCode restart, and delete it when the user cancels it.

## Non-goals

- Do not replace or delay the existing Anthropic model-tier fallback ladder.
- Do not serialize sessions through a provider-wide FIFO or rate-limited worker.
- Do not run a daemon or send anything while OpenCode is not running.
- Do not persist prompt text, conversation bodies, attachments, OAuth tokens, or provider response bodies in the pending store.
- Do not change the standalone TUI layout in this release.
- Do not turn missing credentials, disabled accounts, auth failures, or ordinary network errors into quota waits.

## Required Behavior

The request order remains:

1. Use the requested model tier on any account with tier headroom.
2. Rotate across accounts.
3. Apply the existing model-family fallback ladder when the requested tier is pool-wide limited.
4. Enter durable pending only when no account can serve any model because of account-wide quota.
5. Recheck usage at the earliest possible recovery point and resume the session independently of every other session.

Known provider-wide exhaustion must be detected before the upstream provider call, avoiding a guaranteed `429`. A reactive round in which every account returns an account-class `429` or `402` must enter the same pending state after the fallback and rotation paths are exhausted.

All pending sessions resume concurrently when they become eligible. Each resumed fetch still performs its own normal account selection, rotation, fallback, and renewed `429` handling.

## Compatibility Basis

The current minimum plugin contract exposes the persisted `UserMessage` on `chat.headers`, including `message.id`. The plugin will pass that id through a second internal routing header alongside the existing session header. Both internal headers are removed before an upstream request.

OpenCode persists the user message before starting the model loop. Reissuing `session.prompt` with the same `messageID` upserts that message, and a shutdown-interrupted assistant has an abort error but no terminal `finish`. This lets the loop create a fresh assistant attempt for the same user turn after restart without creating a second user message.

## Components

### Provider recovery classifier

A pure recovery classifier examines only enabled accounts for the current provider and returns one of:

- `available`: at least one account is account-wide available now;
- `quota-blocked`: every potentially usable account is blocked by a live exhausted usage window or a quota-class cooldown, with `nextCheckAt`;
- `unusable`: no account can become usable merely by waiting, such as an empty pool or accounts requiring re-login.

`PoolAccount` gains an optional `cooldownKind: "quota" | "auth" | "transient"`. Account-class `429`/`402` rotations write `quota`, `401`/`403` rotations write `auth`, and thrown refresh/network errors write `transient`. Legacy rows without this field are treated as quota-blocked only when their usage windows independently prove exhaustion; an unclassified cooldown otherwise retains the old degraded-attempt behavior instead of becoming a speculative durable wait.

For one account, recovery requires every active account-wide constraint to expire. Its recovery time is therefore the maximum of:

- `resetAt` for each exhausted hourly or weekly window;
- a known quota-class `cooldownUntil`.

The provider's earliest recovery is the minimum recovery time across its accounts. If any exhausted constraint has no reset time, it is rechecked on the existing five-minute usage refresh cadence; `nextCheckAt` is the earlier of that poll and any known account recovery. Per-model `modelCooldownsUntil` is deliberately ignored by this classifier because it belongs to the fallback ladder, not provider-wide pending.

### Pending store

Pending metadata lives in a separate `auth-load-balancer-pending.json` beside the credential pool file. Keeping it separate avoids enlarging every pool hot-path read and prevents the standalone TUI's whole-file pool writes from overwriting pending state.

The version-one file contains entries with:

```ts
interface PendingTurn {
  key: string
  workspace: string
  providerID: string
  sessionID: string
  messageID: string
  createdAt: number
  updatedAt: number
  nextCheckAt: number
  resumeAt: number | null
}
```

`key` is deterministic from workspace, provider, session, and message ids, so repeated `429` rounds update one entry rather than append duplicates. `resumeAt` is null when no reset is known; `nextCheckAt` always holds the next poll or reset check.

The store uses the repository's atomic temp-file-and-rename discipline, mode `0600`, an in-process mutation chain, and a cross-process mutation lock. The read boundary drops malformed entries rather than letting hand-edited or corrupt data fail model requests.

### Per-turn execution lease

One process may own a pending turn at a time. A per-entry lock directory, derived from a hash of the pending key, is held for the life of the blocked or restored turn. It heartbeats every five seconds and becomes reclaimable after 30 seconds without a heartbeat; its timer does not keep the process alive. A normal release removes the lock; a crashed process stops heartbeating and a later process reclaims the stale lease.

The lease coordinates only identical pending entries. It does not serialize different sessions, including sessions for the same provider.

The coordinator keeps locally owned leases in a map keyed by pending key. Startup restoration acquires the lease before calling `session.prompt`; when that nested prompt reaches the load-balanced fetch, it reuses the same local lease rather than trying to acquire it again. This makes ownership reentrant within one coordinator without making it reentrant across processes.

### Pending coordinator

Each provider plugin owns a coordinator bound to the plugin's `directory`, OpenCode client, and provider adapter. It performs four jobs:

1. Upsert pending metadata before a long quota wait begins.
2. Hold the per-turn lease and perform abortable waits and usage rechecks.
3. Restore matching workspace entries after plugin initialization.
4. Reconcile or remove completed, cancelled, deleted, and orphaned entries.

The load-balanced fetch receives the coordinator and the internal session/message references. Requests without both references are not durable and retain the existing `OPENCODE_AUTH_LB_MAX_WAIT_MS` bounded wait behavior. This covers provider-internal calls that are not an OpenCode user turn.

## Runtime Data Flow

### Initial request in a live process

1. `chat.headers` adds internal session and message id headers.
2. The fetch strips both headers from the upstream header set.
3. Existing model-tier fallback and normal selection remain authoritative whenever an account is account-wide available.
4. If the recovery classifier proves provider-wide quota exhaustion, the coordinator acquires the per-turn lease and writes the pending entry before sleeping. A persistence failure releases the lease. No provider request is sent.
5. The fetch remains unresolved, so OpenCode keeps the session busy and `Esc` continues to cancel the turn.
6. At `nextCheckAt`, usage is refreshed when stale and the pool is reread.
7. If quota is still exhausted, the entry is updated and the loop sleeps again.
8. When an account is available, selection restarts with a clean `tried` set. A non-quota terminal response removes the pending entry.
9. If every attempted account returns another quota response, the entry receives the new `Retry-After` or reset time and returns to waiting.

### OpenCode shutdown and restart

1. The plugin `dispose` hook marks the coordinator as shutting down before active fetch aborts are handled. Shutdown aborts preserve pending entries; abrupt termination also preserves them because no cleanup runs.
2. No timers, workers, or network requests exist after the OpenCode process exits.
3. On the next start, each provider coordinator reads entries for its exact workspace and tries to acquire each entry lease.
4. The coordinator fetches the referenced session message and checks the session history.
5. A normal terminal assistant child means the request already completed at a crash boundary; the coordinator deletes the stale entry without sending.
6. A missing session or user message is an orphan; the coordinator deletes it.
7. An incomplete or abort-interrupted assistant is resumable. The coordinator calls `session.prompt` with the same user `messageID`, the persisted user metadata, and no new prompt parts. OpenCode's upsert leaves the already persisted parts attached to that message, avoiding a second copy of the prompt and attachments.
8. The restored session immediately reaches the load-balanced fetch, which re-enters the pending wait if quota has not recovered. This keeps the session cancellable with `Esc` after restart.
9. If `nextCheckAt` passed while OpenCode was closed, the usage check and eligible dispatch happen immediately.

Restored sessions are launched independently with `Promise.allSettled` semantics. One missing or broken session cannot prevent another session from resuming.

## Cancellation and Cleanup

- An abort while the coordinator is not disposing is treated as explicit turn cancellation. Its pending entry is deleted before the abort propagates.
- An abort during plugin disposal preserves the entry for restart.
- `session.deleted` removes every pending entry for that session.
- A normal provider response, auth failure, non-quota terminal error, missing credentials, or all-disabled pool clears any existing quota pending entry before surfacing its normal result.
- A usage endpoint failure never manufactures headroom. The entry stays pending and checks again on the five-minute cadence.
- A reset with no refreshed endpoint data is still safe: the scheduler's existing expired-window rule treats the elapsed stored window as zero. A repeated provider `429` immediately updates the pending entry again.
- Pending entries have no age TTL. They are bounded by explicit cancellation, session deletion, orphan reconciliation, or eventual completion, so closing OpenCode for longer than a weekly window cannot silently discard requested work.

## User Feedback

The existing toast client displays deduplicated state transitions:

- known reset: `Claude usage exhausted — pending until Aug 27, 14:20 (Esc to cancel)`;
- unknown reset: `Claude usage exhausted — checking again in 5m (Esc to cancel)`;
- startup: `Restored 3 pending Claude sessions`;
- recovery: `Claude usage recovered — resuming request`.

Polling and repeated `429` rounds do not repeat an unchanged pending toast. `auth_lb_status` gains a pending section with provider, session count, and nearest known recovery. The separate TUI artifact is unchanged in this release.

## Failure Boundaries

- No accounts, all accounts disabled, and re-login-required accounts return the existing clean auth failure rather than pending.
- Auth-class `401`/`403` and thrown token-refresh or network errors retain their current cooldown/failure behavior and do not become durable quota waits.
- A pending-store read or write failure must never make the plugin send a request known to be quota-blocked. The request reports a clear local persistence error because accepting an untracked multi-day wait would violate restart durability.
- Failure to restore one entry leaves it persisted, releases its lease, and retries with exponential backoff starting at one second and capped at 60 seconds while OpenCode remains active. Missing session/message errors are the only restoration failures that delete the entry.
- At the dispatch/delete crash boundary, session-history reconciliation is the data-level backstop. A terminal assistant child wins over a stale pending entry, preventing a second provider call.

## Configuration

No new mandatory configuration is introduced. Durable pending is the default for session-bound requests because it replaces a guaranteed `429` with the requested behavior.

`OPENCODE_AUTH_LB_MAX_WAIT_MS` continues to bound requests that lack durable OpenCode session/message identity. Setting it to `0` keeps those anonymous requests fail-fast; it does not disable durable pending for identified user turns.

The existing five-minute usage refresh TTL is reused for unknown-reset polling so the pending feature does not increase usage-endpoint call frequency.

## Testing

Tests use injected clocks and sleepers for multi-day scenarios; the suite never waits for real quota durations.

### Recovery classifier tests

- An available account prevents pending.
- Per-tier exhaustion does not count as provider-wide exhaustion.
- Multiple live exhausted windows use the latest reset for one account.
- Multiple accounts use the earliest account recovery.
- An unknown reset schedules the five-minute poll.
- Empty, disabled, and re-login-only pools are `unusable`, not quota-blocked.

### Pending store and lease tests

- Atomic create, read, update, deduplication, and deletion.
- Malformed file and row normalization.
- Two processes cannot own the same entry simultaneously.
- A stale crashed lease is reclaimable.
- Different session leases can be held concurrently.

### Fetch tests

- Known provider exhaustion performs zero upstream calls before recovery.
- Existing tier fallback runs instead of pending when a lower family is usable.
- A reactive all-account `429` round enters durable pending and honors `Retry-After`.
- A second `429` updates the pending entry.
- Recovery restarts selection and returns the successful response.
- `Esc` deletes pending and performs no retry.
- Disposal preserves pending.
- Auth and network failures do not pending.
- Missing internal identity retains the bounded legacy wait.
- Two sessions recover concurrently without FIFO ordering.

### Plugin restoration tests

- The message id internal header is attached and stripped before upstream.
- Startup resumes an abort-interrupted user turn with the same `messageID` and no new prompt parts.
- A completed assistant child suppresses resend and removes the entry.
- Missing sessions/messages and `session.deleted` remove entries.
- One restore failure does not block other entries.
- Startup with an already elapsed `nextCheckAt` checks immediately.

### Full verification

Run targeted tests during each red-green-refactor cycle, followed by:

```text
bun test
bun run typecheck
bun run lint
bun run build
```

Add a minor changepack and update README behavior, configuration semantics, status output, and architecture notes.

## Local Application

After all verification passes, build `dist`, determine how the current OpenCode configuration resolves this plugin, and replace or link only that installed plugin target to this verified workspace build. Preserve unrelated OpenCode configuration. The running OpenCode process must be restarted once so it loads the new plugin code; pending entries then remain restart-safe under the design above.
