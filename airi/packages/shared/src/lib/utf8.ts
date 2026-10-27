// Counted per code point, so it works without TextEncoder (jsdom lacks it).
// A lone surrogate counts 3 bytes, like the U+FFFD encoders write for it.
function codePointUtf8Bytes(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) bytes += codePointUtf8Bytes(char);
  return bytes;
}

/**
 * Longest prefix of `value` that fits in `maxBytes` UTF-8 bytes. Walks code
 * points, so an emoji or other astral character is never cut in half.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    bytes += codePointUtf8Bytes(char);
    if (bytes > maxBytes) return value.slice(0, end);
    end += char.length;
  }
  return value;
}
