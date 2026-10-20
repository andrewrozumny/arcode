/**
 * Renderer state of the Claude feed: chunks read by main are merged here (tail, live appends,
 * "load earlier"), tool results are paired with their calls, and consecutive tool calls are
 * grouped into one collapsible line. Pure, so it is covered by tests.
 */
import type { FeedChunk, FeedItem, FeedToolResult, FeedUsage } from '@shared/claude';

/** Items kept in memory; live appends past this drop the oldest (they can be loaded again). */
export const MAX_ITEMS = 3000;
/**
 * Cap once earlier items were loaded, so a live append does not throw away what the user just
 * loaded. Past it nothing more is loaded; a fresh tail read goes back to MAX_ITEMS.
 */
export const MAX_LOADED_ITEMS = 2 * MAX_ITEMS;

export interface FeedState {
  /** What the state belongs to: the session id, or `<session>/<agent>` for a subagent's transcript. */
  sessionId: string;
  items: FeedItem[];
  /** Tool results by tool_use id; results may arrive before or after their call is loaded. */
  results: Record<string, FeedToolResult>;
  /** Byte range of the transcript covered by `items`. */
  start: number;
  end: number;
  /** False until the first chunk arrived. */
  loaded: boolean;
  /** False when the session has no transcript yet. */
  found: boolean;
  /** Most items kept: MAX_ITEMS, or MAX_LOADED_ITEMS after "load earlier". */
  cap: number;
  /** Token usage records of the loaded range, in file order (several per streamed API call). */
  usage: FeedUsage[];
  /** Whether the transcript's latest turn record ends a turn; null while unknown. */
  ended: boolean | null;
}

export function emptyFeed(sessionId: string): FeedState {
  return { sessionId, items: [], results: {}, start: 0, end: 0, loaded: false, found: false, cap: MAX_ITEMS, usage: [], ended: null };
}

/** True when "load earlier" can add anything: the transcript has earlier bytes and the ceiling is not reached. */
export function canLoadEarlier(state: FeedState): boolean {
  return state.found && state.start > 0 && state.items.length < MAX_LOADED_ITEMS;
}

function withResults(base: Record<string, FeedToolResult>, results: readonly FeedToolResult[]): Record<string, FeedToolResult> {
  if (results.length === 0) return base;
  const next = { ...base };
  for (const result of results) next[result.toolUseId] = result;
  return next;
}

/**
 * Drops the oldest items past the cap; `start` moves to the first kept item. Items of one
 * transcript record share an offset, so the cut moves forward to the next record: a record is
 * kept or dropped whole and the dropped part can be loaded again from `start`.
 */
function trim(state: FeedState): FeedState {
  const all = state.items;
  if (all.length <= state.cap) return state;
  let cut = all.length - state.cap;
  while (cut < all.length && all[cut]?.offset === all[cut - 1]?.offset) cut++;
  // One record holds every item past the cut: keep that record whole instead.
  if (cut >= all.length) {
    cut = all.length - state.cap;
    while (cut > 0 && all[cut]?.offset === all[cut - 1]?.offset) cut--;
    if (cut === 0) return state;
  }
  const items = all.slice(cut);
  const kept = new Set(items.map((item) => item.id));
  const results: Record<string, FeedToolResult> = {};
  for (const [id, result] of Object.entries(state.results)) if (kept.has(id)) results[id] = result;
  const start = items[0]?.offset ?? state.start;
  return { ...state, items, results, start, usage: state.usage.filter((u) => u.offset >= start) };
}

/**
 * Merges a chunk into the state. `tail` replaces everything (first load, or main reported that
 * the file was rewritten), `append` adds live lines at the end, `prepend` adds earlier lines.
 */
export function mergeChunk(state: FeedState, chunk: FeedChunk, mode: 'tail' | 'append' | 'prepend'): FeedState {
  if (!chunk.found) return { ...emptyFeed(state.sessionId), loaded: true };
  if (mode === 'tail' || chunk.reset) {
    return trim({
      sessionId: state.sessionId,
      items: chunk.items,
      results: withResults({}, chunk.results),
      start: chunk.start,
      end: chunk.end,
      loaded: true,
      found: true,
      cap: MAX_ITEMS,
      usage: chunk.usage,
      ended: chunk.ended,
    });
  }
  if (mode === 'append') {
    // A chunk that does not continue where the state ends is stale (an overlapping poll).
    if (chunk.start !== state.end) return state;
    if (chunk.items.length === 0 && chunk.results.length === 0 && chunk.end === state.end) return state;
    return trim({
      ...state,
      items: chunk.items.length > 0 ? [...state.items, ...chunk.items] : state.items,
      results: withResults(state.results, chunk.results),
      end: chunk.end,
      found: true,
      usage: chunk.usage.length > 0 ? [...state.usage, ...chunk.usage] : state.usage,
      ended: chunk.ended ?? state.ended,
    });
  }
  if (chunk.end !== state.start) return state;
  const items = [...chunk.items, ...state.items];
  // Results already loaded win over nothing; earlier chunks only add calls and their results.
  // Once the user loaded earlier items, live appends keep them: the cap rises to the hard ceiling.
  return trim({
    ...state,
    items,
    results: { ...withResults({}, chunk.results), ...state.results },
    start: chunk.start,
    cap: MAX_LOADED_ITEMS,
    usage: [...chunk.usage, ...state.usage],
  });
}

/**
 * Merges a chunk read for session `sessionId` into `prev`, which may belong to another session
 * by the time the read returns. Only a tail read starts a session over; a late append or
 * "load earlier" reply for another session is dropped.
 */
export function applyChunk(prev: FeedState | null, sessionId: string, chunk: FeedChunk, mode: 'tail' | 'append' | 'prepend'): FeedState | null {
  if (prev?.sessionId === sessionId) return mergeChunk(prev, chunk, mode);
  if (mode !== 'tail') return prev;
  return mergeChunk(emptyFeed(sessionId), chunk, mode);
}

type ToolItem = Extract<FeedItem, { kind: 'tool' }>;
type NoticeItem = Extract<FeedItem, { kind: 'notice' }>;

export type FeedBlock =
  | { type: 'item'; item: Exclude<FeedItem, ToolItem> }
  /** A run of consecutive tool calls drawn as one row (or a single row when it has one call). */
  | { type: 'tools'; id: string; items: ToolItem[] }
  /** A tool call drawn as a card of its own: an agent, a question, a plan, the current task list. */
  | { type: 'card'; item: ToolItem }
  /** A time divider before an item that follows a long pause. */
  | { type: 'divider'; id: string; at: string }
  /** Tokens and time of a finished turn, under its last item. */
  | { type: 'turn'; id: string; stats: TurnStats };

/** A pause between two items longer than this gets a time divider. */
export const DIVIDER_GAP_MS = 30 * 60 * 1000;

function isListTool(item: FeedItem): boolean {
  return item.kind === 'tool' && (item.detail?.type === 'todos' || item.detail?.type === 'task');
}

/** Id of the last todo or task tool call: only it is drawn as the task list card. */
export function latestListId(items: readonly FeedItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && isListTool(item)) return item.id;
  }
  return null;
}

function isCard(item: ToolItem, listId: string | null): boolean {
  const type = item.detail?.type;
  return type === 'agent' || type === 'question' || type === 'plan' || item.id === listId;
}

function time(at: string | null): number | null {
  if (!at) return null;
  const value = Date.parse(at);
  return Number.isNaN(value) ? null : value;
}

/**
 * Groups consecutive tool calls into one block; agents, questions, plans and the latest task list
 * are cards of their own; every other item is a block of its own. A pause of DIVIDER_GAP_MS or
 * more between two items puts a time divider before the later one.
 */
export function groupFeed(items: readonly FeedItem[], turns: ReadonlyMap<string, TurnStats> = new Map()): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  const listId = latestListId(items);
  let last: number | null = null;
  for (const item of items) {
    const at = time(item.at);
    if (at !== null) {
      if (last !== null && at - last >= DIVIDER_GAP_MS && item.at) blocks.push({ type: 'divider', id: `divider:${item.id}`, at: item.at });
      last = at;
    }
    if (item.kind !== 'tool') blocks.push({ type: 'item', item });
    else if (isCard(item, listId)) blocks.push({ type: 'card', item });
    else {
      const prev = blocks[blocks.length - 1];
      if (prev?.type === 'tools') prev.items.push(item);
      else blocks.push({ type: 'tools', id: item.id, items: [item] });
    }
    const stats = turns.get(item.id);
    if (stats) blocks.push({ type: 'turn', id: `turn:${item.id}`, stats });
  }
  return blocks;
}

/** Tokens of one or more API calls. `input` counts only input not read from the cache. */
export interface UsageTotals {
  /** Input not served from the prompt cache: fresh input plus tokens written to the cache. */
  input: number;
  output: number;
  /** Input tokens served from the prompt cache. */
  cacheRead: number;
  /** Input tokens written to the prompt cache (part of `input`). */
  cacheWrite: number;
  /** Distinct API calls (message ids). */
  calls: number;
}

export interface TurnStats extends UsageTotals {
  /** From the prompt to the last assistant record of the turn; null when a timestamp is missing. */
  durationMs: number | null;
}

interface Call {
  offset: number;
  at: number | null;
  fresh: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One entry per API call: Claude Code writes a streamed message once per content block, each
 * record with the usage so far, so fields keep their maximum and the call sits at its first record.
 */
function usageCalls(usage: readonly FeedUsage[]): Call[] {
  const byId = new Map<string, Call>();
  for (const u of usage) {
    const at = time(u.at);
    const prev = byId.get(u.messageId);
    if (!prev) {
      byId.set(u.messageId, { offset: u.offset, at, fresh: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite });
      continue;
    }
    if (at !== null) prev.at = prev.at === null ? at : Math.max(prev.at, at);
    prev.fresh = Math.max(prev.fresh, u.input);
    prev.output = Math.max(prev.output, u.output);
    prev.cacheRead = Math.max(prev.cacheRead, u.cacheRead);
    prev.cacheWrite = Math.max(prev.cacheWrite, u.cacheWrite);
  }
  return [...byId.values()];
}

function sum(calls: readonly Call[]): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: calls.length };
  for (const call of calls) {
    totals.input += call.fresh + call.cacheWrite;
    totals.output += call.output;
    totals.cacheRead += call.cacheRead;
    totals.cacheWrite += call.cacheWrite;
  }
  return totals;
}

/** Tokens of every API call in the loaded range. */
export function usageTotals(usage: readonly FeedUsage[]): UsageTotals {
  return sum(usageCalls(usage));
}

/**
 * Tokens and time per finished turn, keyed by the id of the turn's last item (where the chip goes).
 * A turn runs from a prompt to the next one; its API calls are the usage records in between.
 * Every turn followed by a prompt is finished; the last one only when `lastDone` (the session is
 * not working on it). Items before the first loaded prompt belong to a turn whose start is not
 * loaded and get no chip.
 */
export function turnStats(items: readonly FeedItem[], usage: readonly FeedUsage[], lastDone: boolean): Map<string, TurnStats> {
  const out = new Map<string, TurnStats>();
  if (usage.length === 0) return out;
  const calls = usageCalls(usage);
  const prompts: number[] = [];
  items.forEach((item, index) => {
    if (item.kind === 'user') prompts.push(index);
  });
  prompts.forEach((promptIndex, n) => {
    const prompt = items[promptIndex];
    const nextIndex = prompts[n + 1];
    if (!prompt || (nextIndex === undefined && !lastDone)) return;
    let anchor: FeedItem | null = null;
    for (let i = (nextIndex ?? items.length) - 1; i > promptIndex; i--) {
      const item = items[i];
      if (item && (item.kind === 'assistant' || item.kind === 'tool')) {
        anchor = item;
        break;
      }
    }
    if (!anchor) return;
    const until = nextIndex === undefined ? Number.POSITIVE_INFINITY : (items[nextIndex]?.offset ?? Number.POSITIVE_INFINITY);
    const turn = calls.filter((call) => call.offset > prompt.offset && call.offset < until);
    if (turn.length === 0) return;
    const started = time(prompt.at);
    let last: number | null = null;
    for (const call of turn) if (call.at !== null && (last === null || call.at > last)) last = call.at;
    const durationMs = started !== null && last !== null ? Math.max(0, last - started) : null;
    out.set(anchor.id, { ...sum(turn), durationMs });
  });
  return out;
}

/** `830`, `1.1k`, `12.4k`, `245k`, `1.2M`. */
export function compactTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 100_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (count < 999_500) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** `38 s`, `4 m 12 s`, `1 h 3 m`. */
export function turnDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

/** The chip under a turn: `12.4k in · 1.1k out · 38 s`. */
export function turnLabel(stats: TurnStats): string {
  const parts = [`${compactTokens(stats.input)} in`, `${compactTokens(stats.output)} out`];
  if (stats.durationMs !== null) parts.push(turnDuration(stats.durationMs));
  return parts.join(' · ');
}

/** Tooltip of a usage chip: the cache split and the number of API calls. */
export function usageTooltip(totals: UsageTotals): string {
  const n = (value: number): string => value.toLocaleString('en-US');
  return [
    `Input not from cache: ${n(totals.input)} (of it written to cache: ${n(totals.cacheWrite)})`,
    `Read from cache: ${n(totals.cacheRead)}`,
    `Output: ${n(totals.output)}`,
    `${totals.calls} API ${totals.calls === 1 ? 'call' : 'calls'}`,
  ].join('\n');
}

export interface FeedTask {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string | null;
}

/**
 * The task list as of the latest todo or task call: a TodoWrite carries the whole list; TaskCreate
 * and TaskUpdate calls are replayed in order (a created task's id comes from its result).
 */
export function taskList(items: readonly FeedItem[], results: Record<string, FeedToolResult>): FeedTask[] {
  const listId = latestListId(items);
  const latest = listId ? items.find((item) => item.id === listId) : undefined;
  if (latest?.kind === 'tool' && latest.detail?.type === 'todos') {
    return latest.detail.todos.map((todo, i) => ({ id: String(i + 1), subject: todo.content, status: todo.status, activeForm: todo.activeForm }));
  }
  const tasks = new Map<string, FeedTask>();
  let provisional = 0;
  for (const item of items) {
    if (item.kind !== 'tool' || item.detail?.type !== 'task') continue;
    const detail = item.detail;
    if (item.name === 'TaskCreate') {
      const id = /#(\w+)/.exec(results[item.id]?.text ?? '')?.[1] ?? `new-${++provisional}`;
      tasks.set(id, { id, subject: detail.subject ?? `Task ${id}`, status: 'pending', activeForm: detail.activeForm });
      continue;
    }
    const id = detail.taskId;
    if (!id) continue;
    if (detail.status === 'deleted') {
      tasks.delete(id);
      continue;
    }
    const task = tasks.get(id) ?? { id, subject: `Task #${id}`, status: 'pending', activeForm: null };
    if (detail.subject) task.subject = detail.subject;
    if (detail.activeForm) task.activeForm = detail.activeForm;
    if (detail.status === 'pending' || detail.status === 'in_progress' || detail.status === 'completed') task.status = detail.status;
    tasks.set(id, task);
  }
  return [...tasks.values()];
}

/** Task notifications by the tool_use id of the call that started the task; later ones win. */
export function taskNotices(items: readonly FeedItem[]): Map<string, NonNullable<NoticeItem['task']>> {
  const notices = new Map<string, NonNullable<NoticeItem['task']>>();
  for (const item of items) {
    if (item.kind === 'notice' && item.task?.toolUseId) notices.set(item.task.toolUseId, item.task);
  }
  return notices;
}

export type RunState = 'running' | 'done' | 'error' | 'stopped';

/** What the session's Claude process is doing, as far as the window knows; `unknown` before the first status. */
export type SessionActivity = 'busy' | 'waiting' | 'idle' | 'gone' | 'unknown';

/**
 * State of a tool call. A call without a result runs while the session works, else it was cut
 * short. Background agents run until their task notification arrives (or the session process is
 * gone).
 */
export function runState(
  item: ToolItem,
  result: FeedToolResult | undefined,
  notice: NonNullable<NoticeItem['task']> | undefined,
  activity: SessionActivity,
): RunState {
  if (notice) return notice.status === 'completed' ? 'done' : notice.status === 'running' ? 'running' : 'error';
  if (!result) return activity === 'busy' || activity === 'waiting' || activity === 'unknown' ? 'running' : 'stopped';
  if (result.isError) return 'error';
  // A background agent reports back with a task notification; until then it works.
  if (result.agent?.async === true && item.detail?.type === 'agent') return activity === 'gone' ? 'stopped' : 'running';
  return 'done';
}

/**
 * What a subagent is doing. It runs until its transcript ends a turn; without a closing record it
 * is taken as running while the parent session's process lives.
 */
export function agentActivity(ended: boolean | null, parent: SessionActivity): SessionActivity {
  if (ended === true) return 'idle';
  return parent === 'gone' || parent === 'unknown' ? parent : 'busy';
}

/** State of a run of calls: running while any runs, else failed when any failed. */
export function toolGroupState(states: readonly RunState[]): RunState {
  if (states.includes('running')) return 'running';
  if (states.includes('error')) return 'error';
  if (states.includes('stopped')) return 'stopped';
  return 'done';
}

/**
 * True when the transcript ends mid-turn: the last prompt or tool call has no final reply after it.
 * Used only while the live process status is unknown.
 */
export function endsMidTurn(items: readonly FeedItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === 'notice') {
      if (item.task) continue;
      return false;
    }
    return item.kind === 'user' || item.kind === 'tool';
  }
  return false;
}

/** The newest tool call that still runs, looking back past notices to the last text item. */
export function runningCall(
  items: readonly FeedItem[],
  results: Record<string, FeedToolResult>,
  notices: Map<string, NonNullable<NoticeItem['task']>>,
  activity: SessionActivity,
): ToolItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item || item.kind === 'notice') continue;
    if (item.kind !== 'tool') return null;
    if (runState(item, results[item.id], notices.get(item.id), activity) === 'running') return item;
  }
  return null;
}

/** Time of the last prompt, when the current turn started. */
export function lastPromptAt(items: readonly FeedItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === 'user') return item.at;
  }
  return null;
}
