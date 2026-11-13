/**
 * What the discussion partner knows about the user's Claude Code session: a digest kept in memory
 * from the session's feed, rendered as a compact brief in front of each message. The first message
 * (and the one after a restart, a session switch or the partner's own compaction) gets the full
 * brief; later ones get only what changed. Nothing here is written to disk, and every clipped part
 * names the lookup tool that returns it whole (see sessionTools.ts).
 */
import type { FeedItem, FeedTodo, FeedToolResult } from '@shared/claude';

/** Most prompts, messages, errors and calls a digest keeps. */
const KEEP_PROMPTS = 200;
const KEEP_MESSAGES = 6;
const KEEP_ERRORS = 10;
const KEEP_CALLS = 2000;
const KEEP_FILES = 200;

export const FULL_BUDGET = 16_000;
export const DELTA_BUDGET = 8_000;

export interface DigestPrompt {
  id: string;
  text: string;
}

export interface DigestCall {
  id: string;
  name: string;
  /** One line: the command, the file, the pattern. */
  summary: string;
}

export interface DigestError {
  id: string;
  call: string;
  text: string;
}

/** The session as far as the partner needs it, plus what happened since the last brief. */
export interface SessionDigest {
  sessionId: string;
  /** Transcript byte offset read up to. */
  offset: number;
  /** Prompts the user typed, oldest first (only those read: the tail of a long session). */
  prompts: DigestPrompt[];
  /** True when earlier prompts exist before the ones read. */
  earlier: boolean;
  /** Claude Code's latest messages, oldest first. */
  messages: { id: string; text: string }[];
  todos: FeedTodo[] | null;
  /** TaskCreate / TaskUpdate state by task id or subject. */
  tasks: Map<string, { subject: string; status: string }>;
  /** Edited or written files: path -> number of edits, most recent last. */
  files: Map<string, number>;
  errors: DigestError[];
  /** A question or a plan Claude Code is waiting on (a call without its result yet). */
  open: { id: string; text: string } | null;
  /** Claude Code's summary of the conversation before its latest compaction. */
  compact: string | null;
  /** The last shell command and the tail of its output. */
  lastShell: { id: string; command: string; output: string | null; isError: boolean } | null;
  calls: Map<string, DigestCall>;
  /** Since the last brief. */
  pending: { items: FeedItem[]; results: FeedToolResult[]; todosChanged: boolean };
}

export function emptyDigest(sessionId: string): SessionDigest {
  return {
    sessionId,
    offset: 0,
    prompts: [],
    earlier: false,
    messages: [],
    todos: null,
    tasks: new Map(),
    files: new Map(),
    errors: [],
    open: null,
    compact: null,
    lastShell: null,
    calls: new Map(),
    pending: { items: [], results: [], todosChanged: false },
  };
}

const trimTo = <T>(list: T[], max: number): void => {
  if (list.length > max) list.splice(0, list.length - max);
};

function questionText(item: Extract<FeedItem, { kind: 'tool' }>): string | null {
  const detail = item.detail;
  if (detail?.type === 'question') return detail.questions.map((q) => `${q.question} (${q.options.map((o) => o.label).join(' / ')})`).join('\n');
  if (detail?.type === 'plan') return `Plan waiting for approval:\n${detail.plan}`;
  return null;
}

/** Adds the items and results of one feed chunk (in transcript order) to the digest. */
export function applyChunk(digest: SessionDigest, items: readonly FeedItem[], results: readonly FeedToolResult[], end: number): void {
  for (const item of items) {
    digest.pending.items.push(item);
    if (item.kind === 'user' && item.text.trim()) {
      digest.prompts.push({ id: item.id, text: item.text.trim() });
      trimTo(digest.prompts, KEEP_PROMPTS);
      if (digest.prompts.length === KEEP_PROMPTS) digest.earlier = true;
    } else if (item.kind === 'assistant') {
      digest.messages.push({ id: item.id, text: item.text });
      trimTo(digest.messages, KEEP_MESSAGES);
    } else if (item.kind === 'notice' && item.compact) {
      digest.compact = item.compact;
    } else if (item.kind === 'tool') {
      digest.calls.set(item.id, { id: item.id, name: item.name, summary: item.summary });
      if (digest.calls.size > KEEP_CALLS) digest.calls.delete(digest.calls.keys().next().value ?? '');
      const detail = item.detail;
      if (detail?.type === 'todos') {
        digest.todos = detail.todos;
        digest.pending.todosChanged = true;
      } else if (detail?.type === 'task') {
        const key = detail.taskId ?? detail.subject ?? item.id;
        const known = digest.tasks.get(key);
        digest.tasks.set(key, { subject: detail.subject ?? known?.subject ?? key, status: detail.status ?? known?.status ?? 'pending' });
        digest.pending.todosChanged = true;
      } else if (detail?.type === 'edit' || detail?.type === 'write') {
        const count = (digest.files.get(detail.path) ?? 0) + 1;
        digest.files.delete(detail.path);
        digest.files.set(detail.path, count);
        if (digest.files.size > KEEP_FILES) digest.files.delete(digest.files.keys().next().value ?? '');
      } else if (detail?.type === 'bash') {
        digest.lastShell = { id: item.id, command: detail.command, output: null, isError: false };
      }
      const open = questionText(item);
      if (open) digest.open = { id: item.id, text: open };
    }
  }
  for (const result of results) {
    digest.pending.results.push(result);
    if (digest.open?.id === result.toolUseId) digest.open = null;
    if (digest.lastShell?.id === result.toolUseId) digest.lastShell = { ...digest.lastShell, output: result.text, isError: result.isError };
    if (result.isError && !declined(result.text)) {
      digest.errors.push({ id: result.toolUseId, call: callLabel(digest.calls.get(result.toolUseId)), text: result.text });
      trimTo(digest.errors, KEEP_ERRORS);
    }
  }
  digest.offset = end;
}

/** The brief was sent: what is pending is now known to the partner. */
export function markSent(digest: SessionDigest): void {
  digest.pending = { items: [], results: [], todosChanged: false };
}

/** `text` cut to `max` characters, ending with how much is left and where to get it. */
export function clipRef(text: string, max: number, ref: string): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const keep = Math.max(0, max - ref.length - 24);
  return `${clean.slice(0, keep).trimEnd()} … [+${clean.length - keep} chars: ${ref}]`;
}

/** Head and tail of a long output, which is where errors and their causes usually are. */
export function excerpt(text: string, max: number, ref: string): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const head = Math.floor(max * 0.3);
  const tail = Math.max(0, max - head - ref.length - 24);
  return `${clean.slice(0, head).trimEnd()}\n… [${clean.length - head - tail} chars omitted: ${ref}] …\n${clean.slice(-tail).trimStart()}`;
}

/** A tool call in one line: its summary when that already names the tool. */
export function callLabel(call: DigestCall | undefined): string {
  if (!call) return 'A tool';
  return call.summary.startsWith(call.name) ? call.summary : `${call.name} ${call.summary}`.trim();
}

/** A tool the user declined is not an error of the work. */
const declined = (text: string): boolean => text.startsWith("The user doesn't want to proceed") || text.startsWith('The user doesn\'t want to take this action');

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** session_turn(-k) for the prompt at `index` of the digest's prompts. */
const turnRef = (digest: SessionDigest, index: number): string => `session_turn(${index - digest.prompts.length})`;

const STATUS_LINE: Record<string, string> = {
  busy: 'Claude Code is working right now.',
  idle: 'Claude Code is idle, waiting for the next prompt.',
  waiting: 'Claude Code is waiting for the user to answer it.',
  shell: 'A shell command is running in the Claude tab.',
  ended: 'Claude Code is no longer running in that tab.',
};

function statusLine(status: string | null): string {
  return (status && STATUS_LINE[status]) ?? 'Status of Claude Code unknown.';
}

function todoLines(digest: SessionDigest): string {
  const marks: Record<string, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
  const lines = (digest.todos ?? []).map((t) => `${marks[t.status] ?? '[ ]'} ${oneLine(t.status === 'in_progress' ? t.activeForm ?? t.content : t.content, 160)}`);
  for (const task of digest.tasks.values()) lines.push(`${marks[task.status] ?? `[${task.status}]`} ${oneLine(task.subject, 160)}`);
  return lines.join('\n');
}

function fileLines(digest: SessionDigest, max: number, root: string | undefined): string {
  const files = [...digest.files.entries()].reverse();
  const short = (path: string): string => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
  const shown = files.slice(0, 25).map(([path, n]) => (n > 1 ? `${short(path)} (${n} edits)` : short(path)));
  const more = files.length - shown.length;
  return fitLines(shown, max) + (more > 0 ? `\n… and ${more} more` : '');
}

/** Lines that fit in `max` characters, from the first; says how many did not. */
function fitLines(lines: string[], max: number): string {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) {
      out.push(`… ${lines.length - out.length} more`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out.join('\n');
}

function errorLines(errors: readonly DigestError[], each: number): string {
  return errors.map((e) => `${oneLine(e.call, 200)} failed:\n${excerpt(e.text, each, `tool_output("${e.id}")`)}`).join('\n\n');
}

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n${body.trim()}` : '';
}

const wrap = (kind: string, parts: string[]): string => `<claude_code_session kind="${kind}">\n${parts.filter(Boolean).join('\n\n')}\n</claude_code_session>`;

export interface BriefOptions {
  status: string | null;
  /** Opening line: why this is a full brief (a session switch, a restart). */
  lead?: string;
  /** Project folder: file paths inside it are shown relative to it. */
  root?: string;
  budget?: number;
}

/** Everything the partner needs to talk about the session, within the budget. */
export function fullBrief(digest: SessionDigest, { status, lead, root, budget = FULL_BUDGET }: BriefOptions): string {
  const head = [lead ?? '', statusLine(status), digest.open ? `Open question or plan from Claude Code:\n${clipRef(digest.open.text, 1400, 'session_turn(-1)')}` : '']
    .filter(Boolean)
    .join('\n');
  const n = digest.prompts.length;
  const first = Math.max(0, n - 23);
  const earlierPrompts = digest.prompts.slice(first, Math.max(0, n - 3));
  const omitted = first > 0 || digest.earlier;
  const earlier = section(
    'Earlier prompts in this session, oldest first',
    (omitted ? '(earlier prompts omitted: session_search or session_turn)\n' : '') +
      earlierPrompts.map((p, i) => `- ${clipRef(oneLine(p.text, 400), 160, turnRef(digest, first + i))}`).join('\n'),
  );
  const todos = section('Plan / todos', clipRef(todoLines(digest), 1200, 'session_turn(-1)'));
  const files = section('Files Claude Code changed, latest first', fileLines(digest, 1000, root));
  const errors = section('Recent errors', errorLines(digest.errors.slice(-3), 600));
  const shell =
    digest.lastShell?.output && !digest.lastShell.isError
      ? section(`Last command: ${oneLine(digest.lastShell.command, 200)}`, excerpt(digest.lastShell.output, 500, `tool_output("${digest.lastShell.id}")`))
      : '';
  const compact = digest.compact ? section('Summary of the conversation before the last compaction', clipRef(digest.compact, 1300, 'session_search')) : '';
  const fixed = [head, earlier, todos, files, errors, shell, compact].reduce((sum, part) => sum + part.length, 0);
  const room = Math.max(3000, budget - fixed - 200);
  // The current task and Claude Code's latest message share what is left.
  const recent = digest.prompts.slice(-3);
  const latest = digest.messages[digest.messages.length - 1];
  const messageRoom = latest ? Math.min(latest.text.length, Math.floor(room * 0.45)) : 0;
  const taskRoom = room - messageRoom;
  const current = section(
    'Current task: the latest prompts, oldest first',
    recent
      .map((p, i) => {
        const last = i === recent.length - 1;
        const max = last ? Math.max(800, taskRoom - (recent.length - 1) * 800) : 800;
        return `${last ? 'Latest' : 'Before'}: ${clipRef(p.text, max, turnRef(digest, n - recent.length + i))}`;
      })
      .join('\n\n') || 'No prompt yet.',
  );
  const message = latest ? section("Claude Code's latest message", clipRef(latest.text, messageRoom, 'session_turn(-1)')) : '';
  return wrap('full', [head, current, message, todos, errors, shell, files, earlier, compact]);
}

/** Tool calls as counts per tool, with the first few files or commands. */
function activityLine(items: readonly FeedItem[]): string {
  const byTool = new Map<string, string[]>();
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const list = byTool.get(item.name) ?? [];
    list.push(item.summary);
    byTool.set(item.name, list);
  }
  return [...byTool.entries()]
    .map(([name, summaries]) => {
      const names = [...new Set(summaries.filter(Boolean))].slice(0, 3).map((s) => oneLine(s, 60));
      return `${name}×${summaries.length}${names.length ? ` (${names.join(', ')})` : ''}`;
    })
    .join(', ');
}

/** Only what changed since the last brief (a line saying so when nothing did). */
export function deltaBrief(digest: SessionDigest, { status, budget = DELTA_BUDGET }: BriefOptions): string {
  const { items, results, todosChanged } = digest.pending;
  const prompts = items.filter((i): i is Extract<FeedItem, { kind: 'user' }> => i.kind === 'user' && !!i.text.trim());
  const commands = items.filter((i): i is Extract<FeedItem, { kind: 'command' }> => i.kind === 'command');
  const messages = items.filter((i): i is Extract<FeedItem, { kind: 'assistant' }> => i.kind === 'assistant');
  const errors = results
    .filter((r) => r.isError && !declined(r.text))
    .map((r) => ({ id: r.toolUseId, call: callLabel(digest.calls.get(r.toolUseId)), text: r.text }));
  const head = [statusLine(status), digest.open ? `Open question or plan from Claude Code:\n${clipRef(digest.open.text, 1000, 'session_turn(-1)')}` : ''].filter(Boolean).join('\n');
  if (items.length === 0 && results.length === 0) return wrap('delta', [`${head}\nNothing new in the session since your last message.`]);

  const n = digest.prompts.length;
  const promptIndex = (id: string): number => digest.prompts.findIndex((p) => p.id === id);
  const renderPrompts = (max: number): string =>
    prompts
      .map((p) => {
        const index = promptIndex(p.id);
        return `- ${clipRef(p.text, max, turnRef(digest, index < 0 ? n - 1 : index))}`;
      })
      .join('\n');
  const renderMessages = (latestMax: number, otherMax: number, drop: number): string => {
    const shown = messages.slice(drop);
    const lines = shown.map((m, i) => (i === shown.length - 1 ? clipRef(m.text, latestMax, 'session_turn(-1)') : `- ${clipRef(oneLine(m.text, 2000), otherMax, 'session_turn(-1)')}`));
    return (drop > 0 ? `(${drop} earlier messages omitted: session_turn(-1))\n` : '') + lines.join('\n');
  };
  const activity = activityLine(items);
  const shell =
    digest.lastShell?.output && !digest.lastShell.isError && results.some((r) => r.toolUseId === digest.lastShell?.id)
      ? section(`Last command: ${oneLine(digest.lastShell.command, 200)}`, excerpt(digest.lastShell.output, 300, `tool_output("${digest.lastShell.id}")`))
      : '';
  const build = (promptMax: number, latestMax: number, otherMax: number, drop: number, errorMax: number): string =>
    wrap('delta', [
      head,
      section('New prompts from the user', renderPrompts(promptMax)),
      section('User ran', commands.map((c) => `- ${oneLine(c.text, 200)}`).join('\n')),
      section('Claude Code said', renderMessages(latestMax, otherMax, drop)),
      section('Activity since your last message', activity),
      section('New errors', errorLines(errors.slice(-3), errorMax)),
      shell,
      todosChanged ? section('Plan / todos (changed)', clipRef(todoLines(digest), 1200, 'session_turn(-1)')) : '',
    ]);
  // Shrink in order until it fits: older messages, then dropping them, then the rest.
  let text = build(2000, 2500, 400, 0, 500);
  if (text.length > budget) text = build(2000, 2500, 150, 0, 400);
  for (let drop = 1; text.length > budget && drop < messages.length; drop++) text = build(2000, 2500, 150, drop, 400);
  if (text.length > budget) text = build(800, 1500, 150, Math.max(0, messages.length - 1), 300);
  return text;
}
