/**
 * Shared OAuth callback helpers used by both the Anthropic and OpenAI OAuth
 * flows. Sibling to `pkce.ts` — both providers had near-identical private
 * copies of `generateState` (byte-identical) and `parseCallbackInput`
 * (95%-identical: the Anthropic variant also accepts the legacy `code#state`
 * hash-split format pasted manually by users). Keeping two copies meant every
 * future tweak (new callback format, whitespace normalization) had to be made
 * in two places to stay consistent.
 */

/** Generate an opaque OAuth `state` parameter (32-char hex, no hyphens). */
export function generateState(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * Parse a pasted OAuth callback into `{ code, state }`. Accepts a full
 * `https://…?code=…&state=…` URL, a `key=value` form (`code=…&state=…`), and
 * — when `allowHashFormat` is on — the legacy/manual `<code>#<state>` format.
 * Returns null when no shape matches.
 */
export function parseCallbackInput(
  input: string,
  options: { allowHashFormat?: boolean } = {},
): { code: string; state: string } | null {
  const trimmed = input.trim()

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (code && state) return { code, state }
  } catch {
    // Fall through to legacy/manual formats.
  }

  if (options.allowHashFormat) {
    const hashSplits = trimmed.split('#')
    if (hashSplits.length === 2 && hashSplits[0] && hashSplits[1]) {
      return { code: hashSplits[0], state: hashSplits[1] }
    }
  }

  const params = new URLSearchParams(trimmed)
  const code = params.get('code')
  const state = params.get('state')
  if (code && state) return { code, state }

  return null
}
