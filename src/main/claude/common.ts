import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Reads and parses a JSON file; null when it is missing, unreadable or not valid JSON. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Async readJson, for readers on polled paths. */
export async function readJsonAsync(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Reads a text file; null when it does not exist. */
export function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export { isRecord } from '@shared/guards';

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Paths of the settings files that apply to a project, in precedence order (highest first). */
export function settingsFiles(root: string, home: string): { file: string; scope: 'local' | 'project' | 'user' }[] {
  return [
    { file: join(root, '.claude', 'settings.local.json'), scope: 'local' },
    { file: join(root, '.claude', 'settings.json'), scope: 'project' },
    { file: join(home, '.claude', 'settings.json'), scope: 'user' },
  ];
}

/**
 * Key/value pairs from a leading `---` frontmatter block. Only flat `key: value` lines are read;
 * surrounding single or double quotes are removed.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') break;
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] ?? '').trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[match[1] ?? ''] = value;
  }
  return out;
}
