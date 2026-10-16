/** Project avatar: initials on a colour derived from the name, like the JetBrains project widget. */

const PALETTE = [
  '#e0656a',
  '#e08a4a',
  '#c9a227',
  '#5fae5f',
  '#3fa89b',
  '#3b8fd8',
  '#5f6fd6',
  '#9a6fd6',
  '#d06cb0',
  '#7a8d99',
] as const;

/** First letters of the first two words (split on space, dash, underscore, dot); one word gives its first two letters. */
export function initials(name: string): string {
  const words = name.split(/[\s\-_.]+/).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const second = words[1];
  const pick = second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2);
  return pick.toUpperCase();
}

/** Deterministic palette colour for a name (FNV-1a over the code points). */
export function avatarColor(name: string): string {
  let hash = 0x811c9dc5;
  for (const char of name) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0];
}
