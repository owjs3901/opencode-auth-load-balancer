/**
 * Whether a character is invisible or steers the display (a label lands in the
 * TUI): C0 and C1 controls, DEL, and the bidi, zero-width and line/paragraph
 * format characters that can reorder or hide text.
 */
function isControl(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x61c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2069) ||
    code === 0xfeff
  )
}

/** `text` with those characters turned into spaces, trimmed. */
export function printable(text: string): string {
  return Array.from(text, (ch) =>
    isControl(ch.codePointAt(0) ?? 0) ? ' ' : ch,
  )
    .join('')
    .trim()
}

export function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined
}

/** The longest label a synced credential or login may carry. */
export const MAX_LABEL = 80
