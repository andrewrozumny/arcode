import { LanguageDescription } from '@codemirror/language';
import type { LanguageSupport } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { basename } from './paths';

/** Maps a file name to a CodeMirror language description (loaded lazily on demand). */
export function languageForPath(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, basename(path));
}

export function languageNameForPath(path: string): string | null {
  return languageForPath(path)?.name ?? null;
}

export async function loadLanguage(path: string): Promise<LanguageSupport | null> {
  const description = languageForPath(path);
  if (!description) return null;
  try {
    return await description.load();
  } catch {
    return null;
  }
}

/** Looks up a language by fenced-block info string ("ts", "php", "bash"). */
export function languageForFence(info: string): LanguageDescription | null {
  const name = info.trim().split(/\s+/)[0] ?? '';
  if (!name) return null;
  return (
    LanguageDescription.matchLanguageName(languages, name, true) ??
    LanguageDescription.matchFilename(languages, `x.${name}`)
  );
}
