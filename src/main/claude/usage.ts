import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsageLimit, UsageSummary, UsageWindow } from '@shared/claude';
import { mapLimit } from '../concurrency';
import { isRecord } from './common';
import { parseJsonLine, projectDir } from './transcripts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Files stat'ed or read at the same time. */
const READ_CONCURRENCY = 8;

export const LIMITS_NOTE =
  'Plan percentages are not stored on disk, so this shows token counts from the session transcripts. ' +
  'The limit card shows the newest limit hit in the last 7 days and when it resets.';

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One assistant turn. Streamed turns are written several times with the same message id; fields keep their max. */
interface Turn extends Totals {
  id: string;
  timestamp: number | null;
  file: string;
}

/** A rejected request: Claude Code wrote `quotaLimits` with status "rejected" when the plan limit stopped it. */
interface LimitHit {
  timestamp: number;
  resetsAt: string | null;
  rateLimitType: string | null;
}

interface Transcript {
  turns: Turn[];
  hits: LimitHit[];
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Assistant turns and limit hits of one transcript file. Turns are keyed by message id.
 * Limit records carry a zero usage block and a `<synthetic>` model; they are not turns.
 */
async function readTranscript(file: string): Promise<Transcript> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { turns: [], hits: [] };
  }
  const byId = new Map<string, Turn>();
  const hits: LimitHit[] = [];
  let anonymous = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"') && !line.includes('"quotaLimits"')) continue;
    const record = parseJsonLine(line);
    if (!record || record.type !== 'assistant' || !isRecord(record.message)) continue;
    const timestamp = parseTime(record.timestamp);

    const quota = record.quotaLimits;
    if (isRecord(quota) && quota.status === 'rejected' && timestamp !== null) {
      const resets = num(quota.resetsAt);
      hits.push({
        timestamp,
        resetsAt: resets > 0 ? new Date(resets * 1000).toISOString() : null,
        rateLimitType: typeof quota.rateLimitType === 'string' ? quota.rateLimitType : null,
      });
      continue;
    }
    if (record.message.model === '<synthetic>') continue;

    const usage = record.message.usage;
    if (!isRecord(usage)) continue;
    const id = typeof record.message.id === 'string' ? record.message.id : `anon-${anonymous++}`;
    const next: Totals = {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
    const prev = byId.get(id);
    byId.set(id, {
      id,
      file,
      timestamp: timestamp ?? prev?.timestamp ?? null,
      input: Math.max(prev?.input ?? 0, next.input),
      output: Math.max(prev?.output ?? 0, next.output),
      cacheRead: Math.max(prev?.cacheRead ?? 0, next.cacheRead),
      cacheWrite: Math.max(prev?.cacheWrite ?? 0, next.cacheWrite),
    });
  }
  return { turns: [...byId.values()], hits };
}

function windowOf(label: string, turns: Turn[]): UsageWindow {
  const window: UsageWindow = {
    label,
    messages: turns.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessions: new Set(turns.map((t) => t.file)).size,
  };
  for (const t of turns) {
    window.inputTokens += t.input;
    window.outputTokens += t.output;
    window.cacheReadTokens += t.cacheRead;
    window.cacheWriteTokens += t.cacheWrite;
  }
  return window;
}

/**
 * Token totals for this project's Claude sessions: the most recently written transcript,
 * today (since local midnight) and the last seven days, plus the newest limit hit.
 */
export async function summarizeUsage(root: string, home: string, now: Date = new Date()): Promise<UsageSummary> {
  const dir = await projectDir(root, home);
  let files: { file: string; mtime: number }[] = [];
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    files = await mapLimit(names, READ_CONCURRENCY, async (name) => {
      const file = join(dir, name);
      return { file, mtime: (await stat(file)).mtimeMs };
    });
  } catch {
    // No transcripts for this project yet.
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const nowMs = now.getTime();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const weekAgo = nowMs - 7 * DAY_MS;

  // Only files touched in the last week can hold turns or hits inside the windows.
  const recentFiles = files.filter((f) => f.mtime >= weekAgo);
  const recent = await mapLimit(recentFiles, READ_CONCURRENCY, (f) => readTranscript(f.file));
  const recentTurns = recent.flatMap((t) => t.turns);
  const latest = files[0];
  // The newest file is usually among the recent ones; read it only when it is older than a week.
  const latestTurns = !latest ? [] : latest === recentFiles[0] ? (recent[0]?.turns ?? []) : (await readTranscript(latest.file)).turns;

  const newest = recent
    .flatMap((t) => t.hits)
    .filter((h) => h.timestamp >= weekAgo)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const limit: UsageLimit = newest
    ? {
        state: 'hit',
        hitAt: new Date(newest.timestamp).toISOString(),
        resetsAt: newest.resetsAt,
        rateLimitType: newest.rateLimitType,
      }
    : { state: 'none', hitAt: null, resetsAt: null, rateLimitType: null };

  return {
    currentSession: latest ? windowOf('Current session', latestTurns) : null,
    today: windowOf('Today', recentTurns.filter((t) => t.timestamp !== null && t.timestamp >= midnight.getTime())),
    last7Days: windowOf('Last 7 days', recentTurns.filter((t) => t.timestamp !== null && t.timestamp >= weekAgo)),
    limit,
    limitsNote: LIMITS_NOTE,
  };
}
