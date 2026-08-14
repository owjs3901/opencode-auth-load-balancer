import { anthropicAdapter } from './anthropic/adapter'
import { openaiAdapter } from './openai/adapter'
import type { ProviderAdapter } from './types'

/**
 * Every provider adapter this plugin ships, in one place.
 *
 * The per-provider plugin exports in `index.ts` each own exactly ONE adapter
 * (opencode registers an auth hook per provider), but the provider-agnostic
 * surfaces — the usage-endpoint refresh and the `auth_lb_status` dashboard —
 * must reach ALL of them. Without a shared registry those call sites
 * hand-listed the pair and drifted: the request path only ever refreshed the
 * adapter whose fetch it belonged to, so a provider you did not actively send
 * requests to (e.g. Codex while you work in Claude) had NO refresh cycle at
 * all after its startup seed and its usage froze for the whole opencode
 * process lifetime. Adding a third provider now means editing this array only.
 *
 * `readonly` so a consumer cannot mutate the shared list; iteration order is
 * irrelevant (each account is matched to its own adapter by `providerID`).
 */
export const ADAPTERS: readonly ProviderAdapter[] = [
  anthropicAdapter,
  openaiAdapter,
]

/**
 * The adapter that owns `providerID`, or undefined for a pool row whose
 * provider this build does not know (a hand-edited file, or a row left behind
 * by a newer version). A linear scan, not a Map: the registry has a handful of
 * entries and this runs per account on the request hot path, where building a
 * Map per call would cost more than the scan it replaces.
 */
export function adapterFor(
  adapters: readonly ProviderAdapter[],
  providerID: string,
): ProviderAdapter | undefined {
  for (const adapter of adapters) if (adapter.id === providerID) return adapter
  return undefined
}
