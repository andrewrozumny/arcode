/**
 * History of the discussions, kept in the project so a conversation can be looked up later:
 * `.arcode/discussions/<date>_<time>.md`, one readable Markdown file per conversation, appended to as
 * it goes. The folder is added to the repository's local `.git/info/exclude` (never to a committed
 * file), since a discussion can hold sensitive things. The session updates sent to the partner are
 * not kept: Claude Code's own transcripts have them.
 */
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isRecord } from '@shared/guards';
import { discussionModelChoice } from '@shared/voice';
import type { DiscussionLogRecord } from '@shared/voice';
import { resolveInside } from '../files/paths';

export const HISTORY_DIR = '.arcode/discussions';
const EXCLUDE_LINE = '.arcode/';
const MAX_TEXT = 20_000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-11-13_14-05.md`, from the conversation's start in local time. */
export function historyFileName(start: Date): string {
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}_${pad(start.getHours())}-${pad(start.getMinutes())}.md`;
}

const clock = (at: Date): string => `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;

const MODEL_NAME = { sonnet: 'Sonnet', opus: 'Opus' } as const;

export function historyHeader(start: Date, projectRoot: string, model: string): string {
  const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const name = MODEL_NAME[discussionModelChoice(model)];
  return `# Discussion ${date}\n\n- Project: ${basename(projectRoot)} (${projectRoot})\n- Model: ${name}\n\n`;
}

/** A Markdown block quote of free text (so headings or lists in it stay inside the record). */
const quote = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');

/** One record as Markdown, ending with a blank line. */
export function formatRecord(record: DiscussionLogRecord): string {
  const at = clock(new Date(record.at));
  switch (record.kind) {
    case 'you':
      return `**Ты** · ${at}\n\n${record.text}\n\n`;
    case 'partner': {
      let out = `**Собеседник** · ${at}\n\n${record.text || '_(no text)_'}\n\n`;
      if (record.task) out += `Task for Claude Code (${record.taskStatus ?? 'status unknown'}):\n\n${quote(record.task)}\n\n`;
      return out;
    }
    case 'task':
      return `_${at} · task: ${record.taskStatus ?? record.text}_\n\n`;
    case 'note':
      return `_${at} · ${record.text}_\n\n`;
    case 'error':
      return `**Error** · ${at}\n\n${quote(record.text)}\n\n`;
  }
}

/** A log record from a renderer; throws on anything malformed. */
export function logRecord(value: unknown): DiscussionLogRecord {
  if (!isRecord(value)) throw new Error('Invalid discussion record');
  const kinds = ['you', 'partner', 'task', 'note', 'error'] as const;
  const kind = kinds.find((k) => k === value.kind);
  const conversation = value.conversation;
  if (!kind || typeof conversation !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(conversation)) {
    throw new Error('Invalid discussion record');
  }
  const str = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const at = typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : Date.parse(conversation);
  const record: DiscussionLogRecord = { conversation, kind, at, model: discussionModelChoice(value.model), text: str(value.text) ?? '' };
  const task = str(value.task);
  const taskStatus = str(value.taskStatus, 200);
  if (task) record.task = task;
  if (taskStatus) record.taskStatus = taskStatus;
  return record;
}

/** The repository's git folder for `root`: `.git`, or the folder a `.git` file points to (worktrees). */
async function gitDir(root: string): Promise<string | null> {
  const dotGit = join(root, '.git');
  try {
    const info = await stat(dotGit);
    if (info.isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim();
    if (!pointer) return null;
    const dir = isAbsolute(pointer) ? pointer : resolve(root, pointer);
    // A worktree's git folder has no info/ of its own: excludes live with the main repository.
    const common = await readFile(join(dir, 'commondir'), 'utf8').catch(() => null);
    return common ? resolve(dir, common.trim()) : dir;
  } catch {
    return null;
  }
}

/** Adds `.arcode/` to `.git/info/exclude` when the project is a git repository and it is not there yet. */
export async function excludeFromGit(root: string): Promise<void> {
  const dir = await gitDir(root);
  if (!dir) return;
  const file = join(dir, 'info', 'exclude');
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').some((line) => line.trim() === EXCLUDE_LINE || line.trim() === '/.arcode/' || line.trim() === '.arcode')) return;
  await mkdir(dirname(file), { recursive: true });
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await writeFile(file, `${current}${separator}# ARcode: discussion history and other local files\n${EXCLUDE_LINE}\n`);
}

/** The history of one project: a file per conversation, appended record by record. */
export class DiscussionHistory {
  private readonly files = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly projectRoot: string) {}

  /** Appends a record (records are written in the order they arrive). */
  append(record: DiscussionLogRecord): Promise<void> {
    const next = this.queue.then(() => this.write(record));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async write(record: DiscussionLogRecord): Promise<void> {
    let file = this.files.get(record.conversation);
    if (!file) {
      // The folder must resolve inside the project, symlinks included.
      const dir = await resolveInside(this.projectRoot, HISTORY_DIR);
      await mkdir(dir, { recursive: true });
      await resolveInside(this.projectRoot, HISTORY_DIR);
      await excludeFromGit(this.projectRoot).catch(() => undefined);
      const start = new Date(record.conversation);
      const base = historyFileName(start).replace(/\.md$/, '');
      file = join(dir, `${base}.md`);
      for (let n = 2; await exists(file); n++) file = join(dir, `${base}-${n}.md`);
      await writeFile(file, historyHeader(start, this.projectRoot, record.model), { flag: 'wx', mode: 0o600 });
      this.files.set(record.conversation, file);
    }
    await appendFile(file, formatRecord(record));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
