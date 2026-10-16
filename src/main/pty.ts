import os from 'node:os';
import * as nodePty from 'node-pty';
import type { IPty } from 'node-pty';
import type { PtyCreateResult, PtyDataEvent, PtyExitEvent, PtyId } from '@shared/ipc';
import { envForChild } from './env';

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  extraEnv?: Record<string, string> | undefined;
  name?: string | undefined;
}

export interface PtyEvents {
  onData(event: PtyDataEvent): void;
  onExit(event: PtyExitEvent): void;
}

export function defaultShell(): string {
  return process.env.SHELL || os.userInfo().shell || '/bin/zsh';
}

/** Owns every pty session of one window. */
export class PtyManager {
  private readonly sessions = new Map<PtyId, IPty>();
  private nextId = 1;

  constructor(private readonly events: PtyEvents) {}

  create(options: PtySpawnOptions): PtyCreateResult {
    const shell = defaultShell();
    const id = this.nextId++;
    const proc = nodePty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: Math.max(1, options.cols),
      rows: Math.max(1, options.rows),
      cwd: options.cwd,
      env: envForChild(process.env, { project: options.cwd, extraEnv: options.extraEnv }),
    });
    this.sessions.set(id, proc);
    proc.onData((data) => this.events.onData({ id, data }));
    proc.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id);
      this.events.onExit(signal === undefined ? { id, exitCode } : { id, exitCode, signal });
    });
    return { id, pid: proc.pid, cwd: options.cwd, shell };
  }

  write(id: PtyId, data: string): void {
    this.sessions.get(id)?.write(data);
  }

  resize(id: PtyId, cols: number, rows: number): void {
    const proc = this.sessions.get(id);
    if (!proc || cols < 1 || rows < 1) return;
    try {
      proc.resize(cols, rows);
    } catch {
      // The process may have exited between the lookup and the resize.
    }
  }

  kill(id: PtyId): void {
    const proc = this.sessions.get(id);
    if (!proc) return;
    this.sessions.delete(id);
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  ids(): PtyId[] {
    return [...this.sessions.keys()];
  }

  /** OS pid of a session's shell, if it is still alive. */
  pidOf(id: PtyId): number | undefined {
    return this.sessions.get(id)?.pid;
  }

  /** Map of shell pid to pty id for every live session. */
  pidMap(): Map<number, PtyId> {
    return new Map([...this.sessions.entries()].map(([id, p]) => [p.pid, id]));
  }

  pids(): number[] {
    return [...this.sessions.values()].map((p) => p.pid);
  }
}
