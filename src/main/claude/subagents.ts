/**
 * Subagents of a Claude Code session. Claude Code keeps them next to the session transcript:
 * ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl plus agent-<id>.meta.json
 * ({agentType, description, model, ...}). Only the head and tail of each transcript are read.
 */
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SubagentInfo } from '@shared/claude';
import { mapLimit } from '../concurrency';
import { isRecord, readJsonAsync, stringOrNull } from './common';
import { endsTurn } from './feedParse';
import { findSubagentsDir, parseJsonLine, parseJsonLines, readSlice, readTail } from './transcripts';

const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 256 * 1024;
/** A transcript that has not grown for this long is treated as finished even without a closing turn. */
const QUIET_MS = 10 * 60 * 1000;
/** Transcripts read at the same time. */
const READ_CONCURRENCY = 8;
/** Tail of the parent transcript searched for task notifications (killed or failed agents). */
const PARENT_TAIL_BYTES = 1024 * 1024;

export interface TranscriptFacts {
  model: string | null;
  modelName: string | null;
  startedAt: string | null;
  /** True when the agent's last turn ended: end_turn, the hand-back tool result, or an interrupt. */
  closed: boolean;
  /** Timestamp of the last user or assistant record in the tail. */
  lastAt: string | null;
}

/** Facts from the head (start time) and tail (model, closing turn) of a subagent transcript. */
export function transcriptFacts(head: string, tail: string): TranscriptFacts {
  let startedAt: string | null = null;
  for (const record of parseJsonLines(head)) {
    const ts = stringOrNull(record.timestamp);
    if (ts) {
      startedAt = ts;
      break;
    }
  }
  // Latest assistant turn gives the model in use; the latest /model switch record gives its
  // marketing name, used only when it names the same model.
  let model: string | null = null;
  let switchId: string | null = null;
  let switchName: string | null = null;
  let closed = false;
  let lastAt: string | null = null;
  let sawTurn = false;
  const tailRecords = parseJsonLines(tail);
  for (let i = tailRecords.length - 1; i >= 0; i--) {
    const record = tailRecords[i];
    if (!record) continue;
    const attachment = isRecord(record.attachment) ? record.attachment : null;
    if (!switchId && attachment?.type === 'model' && isRecord(attachment.identity)) {
      switchId = stringOrNull(attachment.identity.modelId);
      switchName = stringOrNull(attachment.identity.marketingName);
    }
    // Attachments (reminders, snapshots) trail both open and finished turns, so they decide nothing.
    if (!sawTurn && (record.type === 'assistant' || record.type === 'user')) {
      sawTurn = true;
      closed = endsTurn(record);
      lastAt = stringOrNull(record.timestamp);
    }
    if (record.type !== 'assistant' || !isRecord(record.message)) continue;
    const m = stringOrNull(record.message.model);
    if (!model && m && m !== '<synthetic>') model = m;
    if (model && switchId) break;
  }
  model ??= switchId;
  const modelName = model && switchId === model ? switchName : null;
  return { model, modelName, startedAt, closed, lastAt };
}

/**
 * Agents the parent session was told have stopped (`<task-notification>` with a status other than
 * running), mapped to the latest such notification time. Killed agents leave no closing record in
 * their own transcript, so this is the only sign they are gone.
 */
export function stoppedAgents(parentTail: string): Map<string, string> {
  const stopped = new Map<string, string>();
  for (const line of parentTail.split('\n')) {
    if (!line.includes('<task-notification>')) continue;
    // Only the notification itself counts; copies (queue removals, prompt snapshots, quoted tool
    // output) land later and would make a resumed agent look stopped.
    const record = parseJsonLine(line);
    if (!record || !isNotification(record)) continue;
    const ts = stringOrNull(record.timestamp);
    if (!ts) continue;
    for (const block of line.split('<task-notification>').slice(1)) {
      const id = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/.exec(block)?.[1];
      const status = /<status>([a-z_]+)<\/status>/.exec(block)?.[1];
      if (!id || !status || status === 'running') continue;
      const prev = stopped.get(id);
      if (!prev || prev < ts) stopped.set(id, ts);
    }
  }
  return stopped;
}

function isNotification(record: Record<string, unknown>): boolean {
  if (record.type === 'queue-operation') return record.operation === 'enqueue';
  return record.type === 'user' && isRecord(record.origin) && record.origin.kind === 'task-notification';
}

async function readParentTail(subagentsDir: string): Promise<string> {
  const file = `${dirname(subagentsDir)}.jsonl`;
  try {
    const info = await stat(file);
    return await readTail(file, info.size, PARENT_TAIL_BYTES);
  } catch {
    return '';
  }
}

async function readSubagent(
  dir: string,
  name: string,
  now: number,
  stopped: () => Promise<ReadonlyMap<string, string>>,
): Promise<SubagentInfo | null> {
  const file = join(dir, name);
  const id = name.slice('agent-'.length, -'.jsonl'.length);
  let head: string;
  let tail: string;
  let mtimeMs: number;
  try {
    const info = await stat(file);
    mtimeMs = info.mtimeMs;
    head = await readSlice(file, 0, Math.min(info.size, HEAD_BYTES));
    tail = info.size <= HEAD_BYTES ? head : await readTail(file, info.size, TAIL_BYTES);
  } catch {
    return null;
  }
  const facts = transcriptFacts(head, tail);
  const meta = await readJsonAsync(join(dir, `agent-${id}.meta.json`));
  const metaRecord = isRecord(meta) ? meta : {};
  const metaModel = stringOrNull(metaRecord.model);
  // A stop notification counts only when it is not older than the agent's last turn (it may be resumed).
  const open = !facts.closed && now - mtimeMs < QUIET_MS;
  const stoppedAt = open ? (await stopped()).get(id) : undefined;
  const notified = stoppedAt !== undefined && (facts.lastAt === null || stoppedAt >= facts.lastAt);
  return {
    id,
    label: stringOrNull(metaRecord.description),
    agentType: stringOrNull(metaRecord.agentType),
    model: facts.model ?? (metaModel && metaModel !== 'inherit' ? metaModel : null),
    modelName: facts.modelName,
    startedAt: facts.startedAt,
    lastActivityAt: new Date(mtimeMs).toISOString(),
    running: open && !notified,
    toolUseId: stringOrNull(metaRecord.toolUseId),
  };
}

/** Subagents of a session: running ones first, then by latest activity. */
export async function listSubagents(sessionId: string, home: string, now: number = Date.now()): Promise<SubagentInfo[]> {
  const dir = await findSubagentsDir(sessionId, home);
  if (!dir) return [];
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n));
  } catch {
    return [];
  }
  // The parent tail is read at most once, and only when some agent still looks open.
  let parent: Promise<Map<string, string>> | null = null;
  const stopped = (): Promise<Map<string, string>> => (parent ??= readParentTail(dir).then(stoppedAgents));
  const out = (await mapLimit(names, READ_CONCURRENCY, (name) => readSubagent(dir, name, now, stopped))).filter(
    (info): info is SubagentInfo => info !== null,
  );
  out.sort((a, b) => Number(b.running) - Number(a.running) || b.lastActivityAt.localeCompare(a.lastActivityAt));
  return out;
}
