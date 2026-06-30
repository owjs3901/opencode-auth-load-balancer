/**
 * Shared PKCE (RFC 7636) helper used by both the Anthropic and OpenAI OAuth
 * flows. The per-provider files were byte-identical except that anthropic also
 * returned `method: 'S256'`. The unified shape always includes `method: 'S256'`;
 * the openai consumer simply ignores it, and the anthropic `oauth.ts` hard-codes
 * the literal `'S256'` into the URL params anyway.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export async function generatePKCE(): Promise<{
  verifier: string
  challenge: string
  method: 'S256'
}> {
  const buf = new Uint8Array(64)
  crypto.getRandomValues(buf)
  const verifier = base64UrlEncode(buf)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return {
    verifier,
    challenge: base64UrlEncode(new Uint8Array(digest)),
    method: 'S256',
  }
}
