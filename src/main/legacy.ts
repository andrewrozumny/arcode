/**
 * The app was called Acode before 0.2.0. Its data folder (`~/Library/Application Support/Acode`)
 * is copied once into the current one so recent projects, layout, tabs and live usage survive the
 * rename. The old folder is left as it was.
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEGACY_NAME = 'Acode';
export const LEGACY_SCRIPT_NAME = 'acode-statusline.py';

/** Our own entries only; Chromium's caches and locks are rebuilt by Electron. */
const CARRIED = ['state.json', 'usage', 'paste', 'Local Storage'];

/**
 * Copies the legacy data on the first start under the new name. Returns true when it did.
 * A custom `--user-data-dir` (demo and bench sandboxes) is never filled from the real one.
 */
export function migrateLegacyUserData(appData: string, userData: string): boolean {
  if (dirname(userData) !== appData) return false;
  const legacy = join(appData, LEGACY_NAME);
  if (existsSync(join(userData, 'state.json')) || !existsSync(join(legacy, 'state.json'))) return false;
  for (const entry of CARRIED) {
    const from = join(legacy, entry);
    if (existsSync(from)) cpSync(from, join(userData, entry), { recursive: true, force: false, errorOnExist: false });
  }
  return true;
}

export function legacyStatusLineScript(appData: string): string {
  return join(appData, LEGACY_NAME, LEGACY_SCRIPT_NAME);
}
