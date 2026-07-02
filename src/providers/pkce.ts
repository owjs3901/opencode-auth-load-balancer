/**
 * Shared PKCE (RFC 7636) helper used by both the Anthropic and OpenAI OAuth
 * flows (the per-provider copies were byte-identical). Only the S256 method is
 * supported; both consumers hard-code `code_challenge_method=S256` into their
 * URL params, so the method is not part of the return shape.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export async function generatePKCE(): Promise<{
  verifier: string
  challenge: string
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
  }
}
