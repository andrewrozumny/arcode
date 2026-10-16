import os from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Expands `~` and makes the path absolute against the project root. */
export function expandPath(path: string, projectRoot: string, home: string = os.homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}
