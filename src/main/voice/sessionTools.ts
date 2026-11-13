/**
 * Lookup tools the discussion partner calls (over the `arcode` MCP server) for what a brief leaves
 * out: one turn of the session in full, the whole output of one tool call, a search through the
 * session, its subagents. They read the session's own transcript on demand, read only, and never
 * copy it anywhere. Every result is capped and says how to get the next part.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { FeedItem, FeedToolResult } from '@shared/claude';
import { isRecord } from '@shared/guards';
import { readFeed } from '../claude/feed';
import { classifyUserText, resultText, stripInjected } from '../claude/feedParse';
import { listSubagents } from '../claude/subagents';
import { findSessionTranscript } from '../claude/transcripts';

/** Longest text one tool call returns. */
export const PAGE_CHARS = 12_000;
/** Search reads at most this much of the end of the transcript, and for at most this long. */
const SEARCH_BYTES = 64 * 1024 * 1024;
const SEARCH_MS = 3000;
/** Backward feed reads one session_turn may take. */
const TURN_READS = 12;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const SESSION_TOOLS: ToolDef[] = [
  {
    name: 'session_brief',
    description: "The full brief of the user's Claude Code session right now: current task, latest message, todos, errors, files changed.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'session_turn',
    description:
      'One turn of the Claude Code session in full: the user prompt, every Claude Code message and every tool call with its id and a short result. turn = -1 is the latest turn, -2 the one before, and so on. Long turns come in parts.',
    inputSchema: {
      type: 'object',
      properties: { turn: { type: 'integer', description: '-1 latest, -2 before it, ...' }, part: { type: 'integer', description: 'Part of a long turn, from 1' } },
      required: ['turn'],
    },
  },
  {
    name: 'tool_output',
    description: 'The whole input and output of one tool call of the session (a test run, a log, a command), by its id, in pages.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Tool call id, as in tool_output("…") markers' },
        offset: { type: 'integer', description: 'Character offset in the output to start from (default 0)' },
        tail: { type: 'boolean', description: 'Return the last page of the output instead' },
      },
      required: ['id'],
    },
  },
  {
    name: 'session_search',
    description: 'Searches the Claude Code session for a literal text (case-insensitive), newest hits first, with the turn each hit is in.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['prompts', 'messages', 'outputs', 'all'], description: 'Default all' },
        limit: { type: 'integer', description: 'Most hits, up to 20 (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'subagents',
    description: 'The subagents Claude Code started in this session: what each does, whether it still runs, and the tool call id of its report.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface SessionSource {
  home: string;
  /** Session the partner is talking about, or null when no Claude tab is open. */
  sessionId(): string | null;
  /** The current full brief. */
  brief(): Promise<string>;
}

export const NO_SESSION = 'No Claude Code session is open in this window.';

const int = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) ? v : fallback);

function page(text: string, offset: number, more: (next: number) => string): string {
  const start = Math.min(Math.max(0, offset), text.length);
  const end = Math.min(text.length, start + PAGE_CHARS);
  const body = text.slice(start, end);
  const left = text.length - end;
  return left > 0 ? `${body}\n\n[characters ${start}-${end} of ${text.length}; next: ${more(end)}]` : body;
}

/** Calls one lookup tool; the answer is always text (errors too, so the partner can say what went wrong). */
export async function callSessionTool(name: string, args: Record<string, unknown>, source: SessionSource): Promise<string> {
  if (name === 'session_brief') return source.brief();
  const sessionId = source.sessionId();
  if (!sessionId) return NO_SESSION;
  switch (name) {
    case 'session_turn':
      return sessionTurn(sessionId, source.home, int(args.turn, -1), int(args.part, 1));
    case 'tool_output':
      return toolOutput(sessionId, source.home, typeof args.id === 'string' ? args.id : '', int(args.offset, 0), args.tail === true);
    case 'session_search': {
      const scope = typeof args.scope === 'string' && SCOPES.includes(args.scope as Scope) ? (args.scope as Scope) : 'all';
      return sessionSearch(sessionId, source.home, typeof args.query === 'string' ? args.query : '', scope, Math.min(20, Math.max(1, int(args.limit, 10))));
    }
    case 'subagents':
      return subagents(sessionId, source.home);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** The items of one turn rendered as text, with tool ids and short results. */
export function renderTurn(items: readonly FeedItem[], results: ReadonlyMap<string, FeedToolResult>): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'user') lines.push(`User: ${item.text}`);
    else if (item.kind === 'command') lines.push(`User ran: ${item.text}`);
    else if (item.kind === 'assistant') lines.push(`Claude Code: ${item.text}`);
    else if (item.kind === 'notice') lines.push(`(${item.text}${item.task?.result ? `: ${item.task.result.slice(0, 1500)}` : ''})`);
    else {
      const result = results.get(item.id);
      const flat = result ? result.text.replace(/\s+/g, ' ').trim() : '';
      // An error's cause is usually at the end of the output.
      const short = flat.length <= 400 ? flat : result?.isError ? `…${flat.slice(-400)}` : `${flat.slice(0, 300)}…`;
      const outcome = result ? `${result.isError ? 'FAILED: ' : '-> '}${short}${flat.length > 400 ? ` [whole: tool_output("${item.id}")]` : ''}` : '(no result yet)';
      lines.push(`[tool ${item.name} id="${item.id}"] ${item.summary}\n  ${outcome}`);
    }
  }
  return lines.join('\n\n');
}

/** Turn `turn` counted back from the latest (-1), read backwards from the transcript's end as far as needed. */
async function sessionTurn(sessionId: string, home: string, turn: number, part: number): Promise<string> {
  if (turn >= 0) return 'Count turns back from the latest one: turn = -1 is the latest, -2 the one before.';
  const want = -turn;
  let chunk = await readFeed({ sessionId }, home);
  if (!chunk.found) return 'The session has no transcript yet.';
  let items = chunk.items;
  const results = new Map(chunk.results.map((r) => [r.toolUseId, r]));
  const prompts = (): number => items.filter((i) => i.kind === 'user').length;
  for (let reads = 1; prompts() < want + 1 && chunk.start > 0 && reads < TURN_READS; reads++) {
    chunk = await readFeed({ sessionId, before: chunk.start }, home);
    items = [...chunk.items, ...items];
    for (const r of chunk.results) results.set(r.toolUseId, r);
  }
  const starts = items.flatMap((item, index) => (item.kind === 'user' ? [index] : []));
  const total = starts.length;
  if (total < want) return `Only ${total} turns could be read back (the latest is -1). Use session_search for older ones.`;
  const from = starts[total - want] ?? 0;
  const to = want === 1 ? items.length : (starts[total - want + 1] ?? items.length);
  const text = renderTurn(items.slice(from, to), results);
  const offset = (Math.max(1, part) - 1) * PAGE_CHARS;
  if (offset >= text.length && text.length > 0) return `Turn ${turn} has only ${Math.ceil(text.length / PAGE_CHARS)} parts.`;
  return page(text, offset, () => `session_turn(${turn}, part ${Math.max(1, part) + 1})`);
}

/** Lines of the transcript (from `start`), with their byte offsets, until `visit` returns false or time runs out. */
async function eachLine(path: string, start: number, visit: (line: string, offset: number) => boolean, deadline = Infinity): Promise<boolean> {
  const stream = createReadStream(path, { start, encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let offset = start;
  let complete = true;
  try {
    for await (const line of lines) {
      const at = offset;
      offset += Buffer.byteLength(line, 'utf8') + 1;
      if (!visit(line, at)) break;
      if (Date.now() > deadline) {
        complete = false;
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return complete;
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function blocks(record: Record<string, unknown>): Record<string, unknown>[] {
  const message = isRecord(record.message) ? record.message : null;
  return message && Array.isArray(message.content) ? message.content.filter(isRecord) : [];
}

async function toolOutput(sessionId: string, home: string, id: string, offset: number, tail: boolean): Promise<string> {
  if (!/^[A-Za-z0-9_:@.-]{1,128}$/.test(id)) return 'Give the id of a tool call, as in a tool_output("…") marker.';
  const path = await findSessionTranscript(sessionId, home);
  if (!path) return 'The session has no transcript yet.';
  let call: string | null = null;
  let output: { text: string; isError: boolean } | null = null;
  const needle = `"${id}"`;
  await eachLine(path, 0, (line) => {
    if (!line.includes(needle)) return true;
    const record = parse(line);
    if (!record) return true;
    for (const block of blocks(record)) {
      if (block.type === 'tool_use' && block.id === id) call = `${String(block.name)} ${JSON.stringify(block.input ?? {})}`;
      if (block.type === 'tool_result' && block.tool_use_id === id) output = { text: stripInjected(resultText(block.content)), isError: block.is_error === true };
    }
    return output === null;
  });
  if (!call && !output) return `No tool call with id ${id} in this session.`;
  const found = output as { text: string; isError: boolean } | null;
  const head = `Call: ${call ? (call as string).slice(0, 2000) : 'unknown'}\n${found ? (found.isError ? 'Result (error):' : 'Result:') : 'No result yet.'}\n`;
  if (!found) return head;
  const start = tail ? Math.max(0, found.text.length - PAGE_CHARS) : offset;
  return head + page(found.text, start, (next) => `tool_output("${id}", offset ${next})`);
}

const SCOPES = ['prompts', 'messages', 'outputs', 'all'] as const;
type Scope = (typeof SCOPES)[number];

interface Hit {
  offset: number;
  kind: string;
  id: string;
  text: string;
}

/** Texts of one record that the scope covers, as [kind, id, text]. */
function recordTexts(record: Record<string, unknown>, scope: Scope): [string, string, string][] {
  if (record.isSidechain === true) return [];
  const uuid = typeof record.uuid === 'string' ? record.uuid : '';
  const out: [string, string, string][] = [];
  const message = isRecord(record.message) ? record.message : null;
  if (record.type === 'user' && message && record.isMeta !== true) {
    if (typeof message.content === 'string') {
      const kind = record.isCompactSummary === true ? 'summary' : 'prompt';
      const classified = classifyUserText(message.content);
      if ((scope === 'all' || scope === 'prompts') && classified?.kind === 'user') out.push([kind, uuid, classified.text]);
    }
    for (const block of blocks(record)) {
      if (block.type === 'text' && typeof block.text === 'string' && (scope === 'all' || scope === 'prompts')) {
        const classified = classifyUserText(block.text);
        if (classified?.kind === 'user') out.push(['prompt', uuid, classified.text]);
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && (scope === 'all' || scope === 'outputs')) {
        out.push(['output', block.tool_use_id, resultText(block.content)]);
      }
    }
  } else if (record.type === 'assistant') {
    for (const block of blocks(record)) {
      if (block.type === 'text' && typeof block.text === 'string' && (scope === 'all' || scope === 'messages')) out.push(['message', uuid, block.text]);
      if (block.type === 'tool_use' && typeof block.id === 'string' && (scope === 'all' || scope === 'outputs')) {
        out.push(['call', block.id, `${String(block.name)} ${JSON.stringify(block.input ?? {})}`]);
      }
    }
  }
  return out;
}

/** True for a record the feed shows as a typed prompt (what turns are counted by). */
function isPromptRecord(record: Record<string, unknown>): boolean {
  if (record.type !== 'user' || record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) return false;
  const message = isRecord(record.message) ? record.message : null;
  if (!message) return false;
  if (typeof message.content === 'string') return classifyUserText(message.content)?.kind === 'user';
  return blocks(record).some((b) => b.type === 'text' && typeof b.text === 'string' && classifyUserText(b.text)?.kind === 'user');
}

function snippet(text: string, at: number, length: number): string {
  const from = Math.max(0, at - 80);
  const to = Math.min(text.length, at + length + 120);
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

async function sessionSearch(sessionId: string, home: string, query: string, scope: Scope, limit: number): Promise<string> {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return 'Search for at least two characters.';
  const path = await findSessionTranscript(sessionId, home);
  if (!path) return 'The session has no transcript yet.';
  const size = (await stat(path)).size;
  const start = Math.max(0, size - SEARCH_BYTES);
  const hits: Hit[] = [];
  const prompts: number[] = [];
  // JSON escapes quotes, backslashes and newlines; a query with those is matched on the parsed text only.
  const raw = /["\\\n]/.test(needle) ? null : needle;
  const complete = await eachLine(
    path,
    start,
    (line, offset) => {
      const lower = line.toLowerCase();
      const maybePrompt = line.includes('"type":"user"') && !line.includes('"tool_result"');
      if (!maybePrompt && raw !== null && !lower.includes(raw)) return true;
      const record = parse(line);
      if (!record) return true;
      if (maybePrompt && isPromptRecord(record)) prompts.push(offset);
      if (raw !== null && !lower.includes(raw)) return true;
      for (const [kind, id, text] of recordTexts(record, scope)) {
        const at = text.toLowerCase().indexOf(needle);
        if (at >= 0) hits.push({ offset, kind, id, text: snippet(text, at, needle.length) });
      }
      return true;
    },
    Date.now() + SEARCH_MS,
  );
  const notes = [start > 0 ? 'only the latest 64 MB of the session were searched' : '', complete ? '' : 'the search stopped after 3 seconds; results are partial'].filter(Boolean);
  if (hits.length === 0) return `No match for "${query}".${notes.length ? ` (${notes.join('; ')})` : ''}`;
  const turnOf = (offset: number): number => {
    const before = prompts.filter((p) => p <= offset).length;
    return before === 0 ? 0 : before - prompts.length - 1;
  };
  const shown = hits.slice(-limit).reverse();
  const lines = shown.map((hit) => {
    const turn = turnOf(hit.offset);
    const where = turn < 0 ? `turn ${turn}` : 'before the first turn read';
    const more = hit.kind === 'output' || hit.kind === 'call' ? `tool_output("${hit.id}")` : turn < 0 ? `session_turn(${turn})` : '';
    return `- ${where} · ${hit.kind}${more ? ` · ${more}` : ''}: ${hit.text}`;
  });
  return [`${hits.length} matches for "${query}"${hits.length > shown.length ? `, newest ${shown.length} shown` : ''}:`, ...lines, ...(notes.length ? [`(${notes.join('; ')})`] : [])].join('\n');
}

async function subagents(sessionId: string, home: string): Promise<string> {
  const list = await listSubagents(sessionId, home);
  if (list.length === 0) return 'Claude Code started no subagents in this session.';
  return list
    .slice(0, 30)
    .map(
      (a) =>
        `- ${a.label ?? a.agentType ?? a.id} (${a.agentType ?? 'agent'}${a.modelName ? `, ${a.modelName}` : ''}): ${a.running ? 'running' : 'finished'}` +
        (a.toolUseId ? `; its report: tool_output("${a.toolUseId}")` : ''),
    )
    .join('\n');
}
