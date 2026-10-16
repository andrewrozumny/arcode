import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface LockContents {
  workspaceFolders: string[];
  pid: number;
  ideName: string;
  transport: 'ws';
  runningInWindows: boolean;
  authToken: string;
}

export function defaultLockDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'ide');
}

/** 64 random bytes, base64url without padding (86 chars). */
export function generateAuthToken(): string {
  return randomBytes(64).toString('base64url');
}

export function lockPath(dir: string, port: number): string {
  return join(dir, `${port}.lock`);
}

/** Writes `<dir>/<port>.lock` atomically with mode 0600. Returns the file path. */
export function writeLock(dir: string, port: number, contents: LockContents): string {
  mkdirSync(dir, { recursive: true });
  const target = lockPath(dir, port);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(contents), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  return target;
}

export function removeLock(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // best effort
  }
}
