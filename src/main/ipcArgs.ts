/**
 * Argument checks shared by every IPC handler. Renderers are sandboxed, but whatever they send
 * arrives as `unknown`, so handlers declare their arguments as `unknown` and check them here.
 *
 * Convention: `invoke` handlers (ipcMain.handle) throw, which rejects the renderer's promise;
 * `send` handlers (ipcMain.on) must not throw (it would surface as an uncaught exception in the
 * main process), so they use the `is*` predicates and ignore bad input.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export function isText(value: unknown): value is string {
  return typeof value === 'string';
}

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** The value as a string; throws `Invalid <name>` otherwise. */
export function text(value: unknown, name: string): string {
  if (!isText(value)) throw new Error(`Invalid ${name}`);
  return value;
}

/** A string or null (absent arguments arrive as undefined and count as null). */
export function textOrNull(value: unknown, name: string): string | null {
  return value === null || value === undefined ? null : text(value, name);
}

export function integer(value: unknown, name: string): number {
  if (!isInteger(value)) throw new Error(`Invalid ${name}`);
  return value;
}

export function textList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every(isText)) throw new Error(`Invalid ${name}`);
  return value;
}

/** An absolute path to an existing folder; throws `Not a project folder` otherwise. */
export async function projectRoot(value: unknown): Promise<string> {
  const root = text(value, 'project root');
  const info = isAbsolute(root) ? await stat(root).catch(() => null) : null;
  if (!info?.isDirectory()) throw new Error(`Not a project folder: ${root}`);
  return root;
}
