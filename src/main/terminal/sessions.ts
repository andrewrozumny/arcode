/**
 * Watches Claude Code's live process registry (~/.claude/sessions/<pid>.json)
 * and reports status changes, matched to the pty whose shell started the process.
 */
import { execFile } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { PtyId } from '@shared/ipc';
import type { ClaudeStatus, ClaudeStatusEvent } from '@shared/terminal';
import { isRecord } from '../claude/common';
import { findSessionTranscript, parseJsonLine, readTail } from '../claude/transcripts';

const KNOWN_STATUSES: readonly ClaudeStatus[] = ['busy', 'idle', 'waiting', 'shell'];
/** Enough of the transcript tail to contain the latest assistant turn, even after a long tool-heavy turn. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
/** How often the transcripts of live sessions are checked for a model switch. */
const MODEL_RECHECK_MS = 2000;

export function sessionsDir(): string {
  return join(os.homedir(), '.claude', 'sessions');
}

/** Parses one registry file; returns null for anything that is not a live-process record. */
export function parseSessionFile(text: string): Omit<ClaudeStatusEvent, 'ptyId'> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const pid = record.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const status = KNOWN_STATUSES.find((s) => s === record.status) ?? 'idle';
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  return {
    pid,
    sessionId: str(record.sessionId),
    status,
    waitingFor: str(record.waitingFor),
    name: str(record.name),
    cwd: str(record.cwd),
    model: null,
    modelName: null,
  };
}

/**
 * Walks up the parent chain of `pid` until a known shell pid is found.
 * `parentOf` is injected so the walk is testable without spawning processes.
 */
export async function findOwnerPty(
  pid: number,
  shells: ReadonlyMap<number, PtyId>,
  parentOf: (pid: number) => Promise<number | null>,
  maxDepth = 8,
): Promise<PtyId | null> {
  let current: number | null = pid;
  for (let depth = 0; depth < maxDepth && current !== null && current > 1; depth++) {
    const owner = shells.get(current);
    if (owner !== undefined) return owner;
    current = await parentOf(current);
  }
  return null;
}

export function psParentOf(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (error, stdout) => {
      const parsed = Number.parseInt(stdout.trim(), 10);
      resolve(error || !Number.isInteger(parsed) ? null : parsed);
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WatcherOptions {
  dir?: string;
  /** Home folder whose ~/.claude/projects holds the transcripts (tests). */
  home?: string;
  shells: () => ReadonlyMap<number, PtyId>;
  onChange: (event: ClaudeStatusEvent) => void;
  parentOf?: (pid: number) => Promise<number | null>;
}

export class ClaudeSessionWatcher {
  private readonly dir: string;
  private readonly parentOf: (pid: number) => Promise<number | null>;
  private readonly known = new Map<number, ClaudeStatusEvent>();
  private watcher: FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private modelTimer: NodeJS.Timeout | undefined;
  /** Transcript mtime per pid at the last model read, so unchanged files are not re-read. */
  private readonly transcriptMtimes = new Map<number, number>();
  /** Transcript path per session id: found once, since a transcript never moves between project folders. */
  private readonly transcripts = new Map<string, string>();
  private scanning = false;
  private recheckRunning = false;
  private rescan = false;
  private stopped = false;

  constructor(private readonly options: WatcherOptions) {
    this.dir = options.dir ?? sessionsDir();
    this.parentOf = options.parentOf ?? psParentOf;
  }

  start(): void {
    this.stopped = false;
    this.attach();
    void this.scan();
    this.modelTimer = setInterval(() => void this.recheckModels(), MODEL_RECHECK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.retry) clearTimeout(this.retry);
    if (this.modelTimer) clearInterval(this.modelTimer);
  }

  snapshot(): ClaudeStatusEvent[] {
    return [...this.known.values()];
  }

  private attach(): void {
    if (this.stopped || this.watcher) return;
    if (!existsSync(this.dir)) {
      // The registry appears with the first claude run; keep looking for it.
      this.retry = setTimeout(() => {
        this.attach();
        void this.scan();
      }, 3000);
      return;
    }
    try {
      this.watcher = watch(this.dir, () => this.schedule());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
        this.retry = setTimeout(() => this.attach(), 3000);
      });
    } catch {
      this.retry = setTimeout(() => this.attach(), 3000);
    }
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.scan(), 120);
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    try {
      do {
        this.rescan = false;
        await this.scanOnce();
      } while (this.rescan && !this.stopped);
    } finally {
      this.scanning = false;
    }
  }

  private async scanOnce(): Promise<void> {
    let files: string[] = [];
    try {
      files = (await readdir(this.dir)).filter((name) => /^\d+\.json$/.test(name));
    } catch {
      // Directory vanished; treat as "no sessions".
    }
    const seen = new Set<number>();
    for (const name of files) {
      let text: string;
      try {
        text = await readFile(join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSessionFile(text);
      if (!parsed || !isAlive(parsed.pid)) continue;
      seen.add(parsed.pid);
      const previous = this.known.get(parsed.pid);
      // Owner is decided once per process: a foreign session (another window, another terminal app)
      // stays foreign, so it must not cost a chain of `ps` calls on every status change.
      const ptyId = previous ? previous.ptyId : await findOwnerPty(parsed.pid, this.options.shells(), this.parentOf);
      const info = parsed.sessionId ? await this.modelInfo(parsed.sessionId) : null;
      this.transcriptMtimes.set(parsed.pid, info?.mtimeMs ?? 0);
      const event: ClaudeStatusEvent = { ...parsed, ptyId, model: info?.model ?? null, modelName: info?.modelName ?? null };
      if (!previous || !sameState(previous, event)) {
        this.known.set(parsed.pid, event);
        this.options.onChange(event);
      }
    }
    for (const [pid, previous] of [...this.known]) {
      if (seen.has(pid)) continue;
      this.known.delete(pid);
      this.transcriptMtimes.delete(pid);
      this.options.onChange({ ...previous, status: 'ended', waitingFor: null });
    }
  }

  /**
   * A `/model` switch only touches the transcript, not the registry the directory watcher
   * sees, so live sessions are re-read when their transcript's mtime moved.
   */
  private async recheckModels(): Promise<void> {
    if (this.stopped || this.scanning || this.recheckRunning) return;
    this.recheckRunning = true;
    try {
      for (const [pid, previous] of [...this.known]) {
        if (!previous.sessionId) continue;
        const file = await this.transcriptOf(previous.sessionId);
        if (!file) continue;
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(file)).mtimeMs;
        } catch {
          this.transcripts.delete(previous.sessionId);
          continue;
        }
        if (mtimeMs === this.transcriptMtimes.get(pid)) continue;
        this.transcriptMtimes.set(pid, mtimeMs);
        const info = await readModelInfo(file);
        // A scan may have replaced or ended the process while the transcript was read.
        const current = this.known.get(pid);
        if (this.stopped || !current || current.sessionId !== previous.sessionId) continue;
        const event: ClaudeStatusEvent = { ...current, model: info?.model ?? null, modelName: info?.modelName ?? null };
        if (!sameState(current, event)) {
          this.known.set(pid, event);
          this.options.onChange(event);
        }
      }
    } finally {
      this.recheckRunning = false;
    }
  }

  private async transcriptOf(sessionId: string): Promise<string | null> {
    const cached = this.transcripts.get(sessionId);
    if (cached) return cached;
    const found = await findSessionTranscript(sessionId, this.options.home ?? os.homedir());
    if (found) this.transcripts.set(sessionId, found);
    return found;
  }

  private async modelInfo(sessionId: string): Promise<SessionModelInfo | null> {
    const file = await this.transcriptOf(sessionId);
    return file ? readModelInfo(file) : null;
  }
}

function sameState(a: ClaudeStatusEvent, b: ClaudeStatusEvent): boolean {
  return (
    a.status === b.status &&
    a.waitingFor === b.waitingFor &&
    a.name === b.name &&
    a.sessionId === b.sessionId &&
    a.model === b.model &&
    a.modelName === b.modelName &&
    a.ptyId === b.ptyId
  );
}

export interface SessionModelInfo {
  model: string;
  modelName: string | null;
  /** Transcript mtime at read time, for cheap change detection. */
  mtimeMs: number;
}

/**
 * Latest model of a transcript from its tail: either the newest assistant turn (`message.model`)
 * or the record Claude Code writes on `/model` (`attachment.identity.modelId`), whichever comes
 * last in the file.
 */
export async function readModelInfo(file: string): Promise<SessionModelInfo | null> {
  let text: string;
  let mtimeMs: number;
  try {
    const stats = await stat(file);
    mtimeMs = stats.mtimeMs;
    text = await readTail(file, stats.size, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return null;
  }
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"model')) continue;
    // The first line of the tail is usually cut in the middle; parseJsonLine skips it.
    const record = parseJsonLine(line);
    if (!record) continue;
    const attachment = isRecord(record.attachment) ? record.attachment : null;
    if (attachment?.type === 'model') {
      const identity = isRecord(attachment.identity) ? attachment.identity : {};
      const id = str(identity.modelId);
      if (id) return { model: id, modelName: str(identity.marketingName), mtimeMs };
    }
    const model = str(isRecord(record.message) ? record.message.model : null);
    if (model && model !== '<synthetic>') return { model, modelName: null, mtimeMs };
  }
  return null;
}
