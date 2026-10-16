/** Pure helpers for files on the macOS clipboard (Finder's copy/paste format). No Electron imports. */
import { isAbsolute } from 'node:path';

/** Electron's name for Finder's file list flavor: an XML plist of absolute paths. */
export const FILENAMES_FLAVOR = 'electron application/osclipboard;format="NSFilenamesPboardType"';

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The plist Finder writes for copied files: a top-level array of path strings. */
export function filenamesPlist(paths: readonly string[]): string {
  const items = paths.map((p) => `<string>${xmlEscape(p)}</string>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0"><array>${items}</array></plist>\n`
  );
}

/** Keeps absolute, non-empty paths; everything else is ignored rather than put on the clipboard. */
export function usablePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && isAbsolute(p));
}

/** Decodes the XML entities a plist string may contain: the five named ones and numeric `&#N;` / `&#xH;`. */
function decodeEntities(text: string): string {
  const fromCode = (match: string, code: number): string =>
    Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex: string) => fromCode(match, Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, dec: string) => fromCode(match, Number(dec)))
    .replace(/&amp;/g, '&');
}

/**
 * Paths from the `NSFilenamesPboardType` clipboard flavor: an XML plist whose top-level
 * array holds one `<string>` per copied file. Entities are decoded; non-absolute items dropped.
 */
export function parseFilenamesPlist(xml: string): string[] {
  const paths: string[] = [];
  for (const match of xml.matchAll(/<string>([^<]*)<\/string>/g)) {
    const path = decodeEntities(match[1] ?? '');
    if (isAbsolute(path)) paths.push(path);
  }
  return paths;
}

/** `file:///Users/me/a%20b.png` -> `/Users/me/a b.png`; null for anything that is not a file URL. */
export function fileUrlToPath(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.startsWith('file://')) return null;
  try {
    const path = decodeURIComponent(new URL(trimmed).pathname);
    return isAbsolute(path) ? path : null;
  } catch {
    return null;
  }
}
