/**
 * Watches the usage records written by `resources/arcode-statusline.py`
 * (`~/Library/Application Support/ARcode/usage/<sessionId>.json`) and keeps the latest snapshot.
 */
import { mkdirSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiveUsage, LiveUsageWindow } from '@shared/claude';
import { isRecord } from './common';

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function windowOf(value: unknown): LiveUsageWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = num(value.usedPercent);
  const resetsAt = num(value.resetsAt);
  if (usedPercent === null && resetsAt === null) return null;
  return { usedPercent, resetsAt };
}

/** Parses one record file; null for anything that is not a usable record. */
export function parseUsageRecord(text: string): LiveUsage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  const model = isRecord(raw.model) ? raw.model : {};
  const context = isRecord(raw.contextWindow) ? raw.contextWindow : {};
  const limits = isRecord(raw.rateLimits) ? raw.rateLimits : {};
  const modelName =
    typeof model.displayName === 'string' && model.displayName
      ? model.displayName
      : typeof model.id === 'string' && model.id
        ? model.id
        : null;
  return {
    sessionId: raw.sessionId,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    modelId: typeof model.id === 'string' && model.id ? model.id : null,
    modelName,
    contextUsed: num(context.totalInputTokens),
    contextSize: num(context.size),
    contextPercent: num(context.usedPercent),
    fiveHour: windowOf(limits.fiveHour),
    sevenDay: windowOf(limits.sevenDay),
    updatedAt: num(raw.updatedAt) ?? 0,
  };
}

/** Reads every record in the folder, newest first. Missing folder means no records. */
export async function readUsageDir(dir: string): Promise<LiveUsage[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json') && !name.startsWith('.'));
  } catch {
    return [];
  }
  const records: LiveUsage[] = [];
  for (const name of names) {
    try {
      const record = parseUsageRecord(await readFile(join(dir, name), 'utf8'));
      if (record) records.push(record);
    } catch {
      // Half-written or vanished file; the next change re-reads it.
    }
  }
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export class LiveUsageWatcher {
  private watcher: FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private lastSignature = '';
  private records: LiveUsage[] = [];
  private refreshing = false;
  private refreshAgain = false;
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly onChange: (records: LiveUsage[]) => void,
  ) {}

  start(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      this.watcher = watch(this.dir, () => this.schedule());
      this.watcher.on('error', () => undefined);
    } catch {
      // fs.watch can fail on some volumes; polling below still works.
    }
    // Fallback for editors and volumes where fs.watch misses atomic renames.
    this.poll = setInterval(() => this.schedule(), 2000);
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.debounce) clearTimeout(this.debounce);
    if (this.poll) clearInterval(this.poll);
  }

  snapshot(): LiveUsage[] {
    return this.records;
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 150);
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      // Cheap change check first: names plus mtimes.
      let signature = '';
      try {
        for (const name of await readdir(this.dir)) {
          if (!name.endsWith('.json')) continue;
          signature += `${name}:${(await stat(join(this.dir, name))).mtimeMs};`;
        }
      } catch {
        return;
      }
      if (signature === this.lastSignature) return;
      const records = await readUsageDir(this.dir);
      if (this.stopped) return;
      this.lastSignature = signature;
      this.records = records;
      this.onChange(records);
    } finally {
      this.refreshing = false;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        this.schedule();
      }
    }
  }
}
