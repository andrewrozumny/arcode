/** Type guards for untrusted JSON (files on disk, IPC payloads). No Electron imports. */

/** A plain object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
