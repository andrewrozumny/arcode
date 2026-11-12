/**
 * Which processes run in a window's ptys: a command started in a shell tab (`pnpm dev`, a gate) or a
 * shell command Claude Code runs through its Bash tool, foreground or in the background. One `ps`
 * of the whole process table per tick serves every pty of the window.
 */
import { execFile } from 'node:child_process';
import type { PtyId } from '@shared/ipc';
import type { PtyActivity, PtyJob } from '@shared/terminal';

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Longest command text reported per job. */
const MAX_COMMAND_LENGTH = 160;
/** Most jobs reported per pty. */
const MAX_JOBS = 20;
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh']);

/** Parses `ps -A -ww -o pid=,ppid=,command=` output. */
export function parsePsTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2] || match[3] === undefined) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3].trim() });
  }
  return rows;
}

/** Name of the program a command line runs (`/bin/zsh -c ...` -> `zsh`, `-zsh` -> `zsh`). */
export function programName(command: string): string {
  const first = command.split(/\s+/, 1)[0] ?? '';
  return (first.split('/').pop() ?? first).replace(/^-/, '');
}

function isClaude(command: string): boolean {
  const name = programName(command);
  if (name === 'claude') return true;
  // An npm install runs `node .../@anthropic-ai/claude-code/cli.js`.
  return name === 'node' && /@anthropic-ai\/claude-code\/|\/claude(\.js)?(\s|$)/.test(command);
}

function shorten(text: string): string {
  // ps writes control characters of a command line as octal escapes (`\012` for a newline).
  const flat = text.replace(/\\0(?:11|12|15)/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_COMMAND_LENGTH ? `${flat.slice(0, MAX_COMMAND_LENGTH - 1)}…` : flat;
}

/**
 * The command a Claude Code Bash tool shell runs. Claude Code wraps it as
 * `zsh -c source <snapshot> ... && eval '<command>' < /dev/null && pwd -P >| <file>`, with single
 * quotes inside written as `'"'"'`. Falls back to the shell's own command line.
 */
export function claudeShellCommand(command: string): string {
  const start = command.lastIndexOf("eval '");
  if (start >= 0) {
    const body = command.slice(start + "eval '".length);
    const end = body.lastIndexOf("' < /dev/null");
    const quoted = end >= 0 ? body.slice(0, end) : body.replace(/'$/, '');
    return shorten(quoted.replaceAll(`'"'"'`, "'"));
  }
  return shorten(command.replace(/^\S+\s+-c\s+/, ''));
}

/**
 * Jobs per pty. Direct children of a pty's shell are commands started there, except a Claude Code
 * process, whose own shell children are the commands Claude runs. Claude Code's MCP servers and
 * helpers (`caffeinate`) are not jobs.
 */
export function ptyActivity(rows: readonly ProcessRow[], shells: ReadonlyMap<number, PtyId>): PtyActivity[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const result: PtyActivity[] = [];
  for (const [shellPid, ptyId] of shells) {
    const jobs: PtyJob[] = [];
    for (const child of children.get(shellPid) ?? []) {
      if (isClaude(child.command)) {
        for (const grandchild of children.get(child.pid) ?? []) {
          // Only Bash tool shells count: MCP servers and helpers such as caffeinate live as long as Claude.
          if (SHELLS.has(programName(grandchild.command)) && /\s-c(\s|$)/.test(grandchild.command)) {
            jobs.push({ command: claudeShellCommand(grandchild.command), source: 'claude' });
          }
        }
      } else {
        jobs.push({ command: shorten(child.command), source: 'shell' });
      }
    }
    result.push({ ptyId, jobs: jobs.slice(0, MAX_JOBS) });
  }
  return result.sort((a, b) => a.ptyId - b.ptyId);
}

export function readProcessTable(): Promise<ProcessRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : parsePsTable(stdout));
    });
  });
}

export interface ActivityMonitorOptions {
  shells: () => ReadonlyMap<number, PtyId>;
  onChange: (activity: PtyActivity[]) => void;
  read?: () => Promise<ProcessRow[]>;
  intervalMs?: number;
}

/** Polls the process table while the window has ptys and reports changes. */
export class ActivityMonitor {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private last = '[]';
  private current: PtyActivity[] = [];
  private readonly read: () => Promise<ProcessRow[]>;

  constructor(private readonly options: ActivityMonitorOptions) {
    this.read = options.read ?? readProcessTable;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 1500);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): PtyActivity[] {
    return this.current;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const shells = this.options.shells();
      const next = shells.size === 0 ? [] : ptyActivity(await this.read(), shells);
      const json = JSON.stringify(next);
      if (json === this.last) return;
      this.last = json;
      this.current = next;
      this.options.onChange(next);
    } finally {
      this.running = false;
    }
  }
}
