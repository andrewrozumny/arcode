/**
 * How the Claude feed names tool calls: a short human phrase per call ("Read FeedView.tsx",
 * "Edited feed.css +12 -3", "Ran `pnpm test`"), the label of a run of calls ("Read 3 files, ran
 * 2 commands") and the icon family of each tool. Pure, so it is covered by tests.
 */
import type { FeedItem, FeedToolResult } from '@shared/claude';
import { addedRows, diffLines, diffStats, patchRows } from './feedDiff';

export type ToolItem = Extract<FeedItem, { kind: 'tool' }>;

/** Icon family of a tool row. */
export type ToolIcon =
  | 'read'
  | 'edit'
  | 'write'
  | 'bash'
  | 'search'
  | 'agent'
  | 'todo'
  | 'question'
  | 'plan'
  | 'web'
  | 'skill'
  | 'mcp'
  | 'tool';

export interface ToolPhrase {
  icon: ToolIcon;
  /** "Read", "Edited", "Ran"; "Running" while the call has no result. */
  verb: string;
  /** What the call worked on: a file name, a command, a pattern. */
  target: string;
  /** Draw `target` as inline code. */
  code: boolean;
  /** Lines added and removed, for edits and writes. */
  added?: number;
  removed?: number;
  /** A short muted suffix: "12 files", "lines 40-80". */
  note?: string;
}

const TARGET_CHARS = 90;

function short(text: string, max = TARGET_CHARS): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `mcp__plugin_playwright_playwright__browser_click` -> server `playwright`, tool `browser_click`. */
export function mcpParts(name: string): { server: string; tool: string } | null {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return null;
  const server = (mcp[1] ?? '').replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  return { server, tool: mcp[2] ?? '' };
}

/** Lines added and removed by an edit or write: from the reported patch, else from the input. */
export function editStats(item: ToolItem, result: FeedToolResult | undefined): { added: number; removed: number } | null {
  const detail = item.detail;
  if (!detail || (detail.type !== 'edit' && detail.type !== 'write')) return null;
  if (result?.patch && result.patch.length > 0) return diffStats(patchRows(result.patch));
  if (detail.type === 'write') return { added: addedRows(detail.content).length, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const edit of detail.edits) {
    const stats = diffStats(diffLines(edit.oldText, edit.newText));
    added += stats.added;
    removed += stats.removed;
  }
  return { added, removed };
}

function pick(running: boolean, now: string, done: string): string {
  return running ? now : done;
}

/** The phrase of one tool call; worded as running while it has no result, unless told otherwise. */
export function toolPhrase(item: ToolItem, result: FeedToolResult | undefined, running = !result): ToolPhrase {
  const detail = item.detail;
  if (detail) {
    switch (detail.type) {
      case 'bash':
        return {
          icon: 'bash',
          verb: pick(running, 'Running', 'Ran'),
          target: short(detail.command),
          code: true,
          ...(detail.background ? { note: 'in background' } : {}),
        };
      case 'read': {
        const from = detail.offset ?? 1;
        const range = detail.offset !== null || detail.limit !== null
          ? `lines ${from}-${detail.limit !== null ? from + detail.limit - 1 : 'end'}`
          : result?.lines ? plural(result.lines.count, 'line') : undefined;
        return { icon: 'read', verb: pick(running, 'Reading', 'Read'), target: baseName(detail.path), code: false, ...(range ? { note: range } : {}) };
      }
      case 'edit':
      case 'write': {
        const stats = editStats(item, result);
        const verb = detail.type === 'edit'
          ? pick(running, 'Editing', 'Edited')
          : result?.created ? 'Created' : pick(running, 'Writing', 'Wrote');
        return {
          icon: detail.type,
          verb,
          target: baseName(detail.path),
          code: false,
          ...(stats ? { added: stats.added, removed: stats.removed } : {}),
        };
      }
      case 'search': {
        const grep = item.name === 'Grep';
        const matches = result?.matches;
        const note = matches ? plural(matches.count, matches.unit === 'lines' ? 'line' : 'file') : undefined;
        return {
          icon: 'search',
          verb: grep ? pick(running, 'Searching for', 'Searched for') : pick(running, 'Finding', 'Found'),
          target: grep ? `"${short(detail.pattern, 60)}"` : short(detail.pattern, 60),
          code: !grep,
          ...(note ? { note } : {}),
        };
      }
      case 'agent':
        return { icon: 'agent', verb: 'Agent:', target: short(detail.description), code: false, ...(detail.agentType ? { note: detail.agentType } : {}) };
      case 'todos': {
        const done = detail.todos.filter((todo) => todo.status === 'completed').length;
        return { icon: 'todo', verb: 'Updated todos', target: '', code: false, note: `${done}/${detail.todos.length} done` };
      }
      case 'task': {
        const subject = detail.subject ?? (detail.taskId ? `#${detail.taskId}` : '');
        if (item.name === 'TaskCreate') return { icon: 'todo', verb: 'Added task', target: short(subject), code: false };
        const verb = detail.status === 'completed' ? 'Completed task' : detail.status === 'in_progress' ? 'Started task' : detail.status === 'deleted' ? 'Removed task' : 'Updated task';
        return { icon: 'todo', verb, target: short(subject), code: false };
      }
      case 'question':
        return { icon: 'question', verb: 'Asked', target: short(detail.questions[0]?.question ?? 'a question'), code: false };
      case 'plan':
        return { icon: 'plan', verb: 'Proposed a plan', target: '', code: false };
      case 'web':
        if (item.name === 'WebSearch') return { icon: 'web', verb: pick(running, 'Searching the web for', 'Searched the web for'), target: `"${short(detail.query ?? '', 70)}"`, code: false };
        return { icon: 'web', verb: pick(running, 'Fetching', 'Fetched'), target: short(detail.url ?? '', 70), code: false };
    }
  }
  const mcp = mcpParts(item.name);
  if (mcp) return { icon: 'mcp', verb: mcp.server, target: `· ${mcp.tool}`, code: false };
  if (item.name === 'Skill') return { icon: 'skill', verb: 'Skill', target: short(item.summary.replace(/^Skill:\s*/, '')), code: false };
  return { icon: 'tool', verb: item.name, target: short(item.summary.startsWith(`${item.name}: `) ? item.summary.slice(item.name.length + 2) : ''), code: false };
}

/** The phrase as text, for titles and tests; `plain` leaves code targets unquoted. */
export function phraseText(phrase: ToolPhrase, plain = false): string {
  const target = phrase.target ? (phrase.code && !plain ? ` \`${phrase.target}\`` : ` ${phrase.target}`) : '';
  const stats = phrase.added !== undefined ? ` +${phrase.added} -${phrase.removed ?? 0}` : '';
  const note = phrase.note ? ` (${phrase.note})` : '';
  return `${phrase.verb}${target}${stats}${note}`;
}

type Category = 'read' | 'edit' | 'write' | 'command' | 'search' | 'web' | 'other';

function category(item: ToolItem): Category {
  switch (item.detail?.type) {
    case 'read':
      return 'read';
    case 'edit':
      return 'edit';
    case 'write':
      return 'write';
    case 'bash':
      return 'command';
    case 'search':
      return 'search';
    case 'web':
      return 'web';
    default:
      return 'other';
  }
}

const CATEGORY_TEXT: Record<Category, (count: number) => string> = {
  read: (n) => `read ${plural(n, 'file')}`,
  edit: (n) => `edited ${plural(n, 'file')}`,
  write: (n) => `wrote ${plural(n, 'file')}`,
  command: (n) => `ran ${plural(n, 'command')}`,
  search: (n) => `searched ${n === 1 ? 'once' : `${n} times`}`,
  web: (n) => `fetched ${plural(n, 'page')}`,
  other: (n) => `used ${plural(n, 'tool')}`,
};

/**
 * Label of a run of tool calls: "Read 3 files, ran 2 commands". Files count once however often
 * they were touched. More than three kinds of work read "Used 9 tools".
 */
export function toolGroupLabel(items: readonly ToolItem[]): string {
  const counts = new Map<Category, Set<string>>();
  for (const item of items) {
    const kind = category(item);
    const detail = item.detail;
    const key = detail && (detail.type === 'read' || detail.type === 'edit' || detail.type === 'write') ? detail.path : item.id;
    let set = counts.get(kind);
    if (!set) counts.set(kind, (set = new Set()));
    set.add(key);
  }
  if (counts.size > 3 || (counts.size === 1 && counts.has('other'))) return `Used ${plural(items.length, 'tool')}`;
  const order: Category[] = ['read', 'search', 'edit', 'write', 'command', 'web', 'other'];
  const text = order
    .filter((kind) => counts.has(kind))
    .map((kind) => CATEGORY_TEXT[kind](counts.get(kind)?.size ?? 0))
    .join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
