/**
 * Optional project registry: a local SQLite database with a `projects` table
 * (`slug, name, status, kind, home`). Read only, through the system `sqlite3` CLI so no
 * native module is needed. Any failure yields an empty list.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import type { ProjectEntry } from '@shared/app';

export interface RegistryRow {
  slug?: unknown;
  name?: unknown;
  status?: unknown;
  kind?: unknown;
  home?: unknown;
}

/** Statuses listed first in the switcher. */
export const PRIORITY_STATUSES: readonly string[] = ['active', 'validating'];

/**
 * Extracts a folder path from a free-form `home` value such as
 * `~/work/app · notes`, `~/work/app (draft)` or `/abs/path`. Returns null when the
 * value does not start with a path.
 */
export function parseHome(home: string, homeDir: string = os.homedir()): string | null {
  const token = (home.trim().split(/[\s\u00b7(]+/)[0] ?? '').replace(/[,;]+$/, '');
  if (!token) return null;
  let path: string;
  if (token === '~') path = homeDir;
  else if (token.startsWith('~/')) path = `${homeDir}${token.slice(1)}`;
  else if (token.startsWith('/')) path = token;
  else return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Rows to entries: parses `home`, drops rows without a path, sorts priority statuses first. */
export function registryEntries(
  rows: readonly RegistryRow[],
  options: { homeDir?: string; exists?: (path: string) => boolean } = {},
): ProjectEntry[] {
  const exists = options.exists ?? isDirectory;
  const seen = new Set<string>();
  const entries: ProjectEntry[] = [];
  for (const row of rows) {
    const home = text(row.home);
    if (!home) continue;
    const root = parseHome(home, options.homeDir);
    if (!root || seen.has(root) || !exists(root)) continue;
    seen.add(root);
    const entry: ProjectEntry = { root, name: text(row.name) ?? text(row.slug) ?? root, source: 'registry' };
    const slug = text(row.slug);
    const status = text(row.status);
    const kind = text(row.kind);
    if (slug) entry.slug = slug;
    if (status) entry.status = status;
    if (kind) entry.kind = kind;
    entries.push(entry);
  }
  const rank = (entry: ProjectEntry): number => (PRIORITY_STATUSES.includes(entry.status ?? '') ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function expandHome(path: string, homeDir: string = os.homedir()): string {
  if (path === '~') return homeDir;
  return path.startsWith('~/') ? `${homeDir}${path.slice(1)}` : path;
}

const QUERY = 'SELECT slug, name, status, kind, home FROM projects;';

/** Reads the registry database. Never throws; resolves to [] on any error. */
export function readRegistry(dbPath: string | undefined, timeoutMs = 3000): Promise<ProjectEntry[]> {
  if (!dbPath) return Promise.resolve([]);
  const file = expandHome(dbPath);
  return new Promise((resolve) => {
    execFile(
      'sqlite3',
      ['-readonly', '-json', file, QUERY],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          console.warn(`[acode] project registry unavailable: ${error.message}`);
          resolve([]);
          return;
        }
        try {
          const rows: unknown = stdout.trim() ? JSON.parse(stdout) : [];
          resolve(Array.isArray(rows) ? registryEntries(rows as RegistryRow[]) : []);
        } catch {
          resolve([]);
        }
      },
    );
  });
}
