/**
 * Turns Claude Code transcript records into Claude feed items. Pure: no file system access, so
 * every rule about what the feed shows or hides lives here and is covered by tests.
 *
 * Shown: prompts the user typed (also ones queued while Claude was busy), slash and `!` commands,
 * assistant text, one line per tool call (results are paired by tool_use id), and a few muted
 * notices (an agent finished, the conversation was compacted, an interrupt).
 * Hidden: thinking, attachments, meta and injected user entries, system reminders, hook and
 * classifier records, shell output of `!` commands and every sidechain (subagent) record.
 */
import type { FeedHunk, FeedItem, FeedQuestion, FeedTaskNotice, FeedTodo, FeedToolDetail, FeedToolResult } from '@shared/claude';
import { isRecord } from '@shared/guards';

/**
 * Longest text kept per field (an edit's old or new text, written content, a result): enough to
 * read, small enough that a tail load of many tool calls stays cheap over IPC.
 */
export const FIELD_CHARS = 20_000;
/** Generic JSON input of tools without a dedicated view. */
export const INPUT_CHARS = 4000;
/** Read results are file contents the feed never shows; keep only enough for an error. */
const READ_RESULT_CHARS = 600;
/** Patch text kept per result, counted over all hunk lines. */
const PATCH_CHARS = 20_000;
/** Pasted images are sent as data URLs up to this size; larger ones are only counted. */
export const THUMB_CHARS = 600_000;
const MAX_THUMBS = 4;
const MAX_EDITS = 30;
const SUMMARY_CHARS = 140;

/** One complete line of a transcript and the byte offset it starts at. */
export interface FeedLine {
  offset: number;
  text: string;
}

export interface ParsedFeed {
  items: FeedItem[];
  results: FeedToolResult[];
}

/** Wrappers Claude Code or the IDE bridge add to user text; never something the user typed. */
const INJECTED_BLOCKS =
  /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|local-command-caveat)>[\s\S]*?<\/\1>/g;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function oneLine(text: string, max = SUMMARY_CHARS): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}

function tag(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? (match[1] ?? '') : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Drops injected blocks (system reminders, IDE context) and surrounding blank space. */
export function stripInjected(text: string): string {
  return text.replace(INJECTED_BLOCKS, '').trim();
}

type Classified = { kind: 'user' | 'command' | 'notice'; text: string; task?: FeedTaskNotice } | null;

/**
 * What a piece of user-role text is: a typed prompt, a command the user ran, a notice, or noise
 * (null). Claude Code writes commands, their output and background task notices as user entries
 * wrapped in tags.
 */
export function classifyUserText(raw: string): Classified {
  const text = raw.trim();
  if (text.startsWith('<task-notification>')) {
    const summary = tag(text, 'summary');
    const result = tag(text, 'result')?.trim();
    const task: FeedTaskNotice = {
      toolUseId: tag(text, 'tool-use-id')?.trim() || null,
      status: tag(text, 'status')?.trim() || 'completed',
      result: result ? clip(result, FIELD_CHARS) : null,
    };
    return { kind: 'notice', text: oneLine(summary ?? 'Background task finished'), task };
  }
  const command = tag(text, 'command-name');
  if (command !== null) {
    const args = (tag(text, 'command-args') ?? '').trim();
    return { kind: 'command', text: oneLine(args ? `${command.trim()} ${args}` : command.trim()) };
  }
  const shell = tag(text, 'bash-input');
  if (shell !== null) return { kind: 'command', text: oneLine(`! ${shell.trim()}`) };
  if (text.startsWith('<bash-stdout>') || text.startsWith('<bash-stderr>')) return null;
  const stdout = tag(text, 'local-command-stdout');
  if (stdout !== null) {
    const clean = stdout.replace(ANSI, '').trim();
    return clean ? { kind: 'notice', text: oneLine(clean) } : null;
  }
  if (/^\[Request interrupted by user[^\]]*\]$/.test(text)) return { kind: 'notice', text: 'Interrupted by user' };
  const prompt = stripInjected(text);
  return prompt ? { kind: 'user', text: prompt } : null;
}

/** `/repo/src/a.ts` -> `src/a.ts` when the path is inside the session's working folder. */
export function relativeTo(cwd: string | null, path: string): string {
  if (!cwd) return path;
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** `mcp__plugin_playwright_playwright__browser_click` -> `playwright · browser_click`. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return name;
  const server = (mcp[1] ?? '').replace(/^plugin_[^_]+_/, '').replace(/^claude_ai_/, '').replace(/_/g, ' ');
  return `${server} · ${mcp[2] ?? ''}`;
}

/** The first non-empty string among an input's values, for tools without a dedicated summary. */
function firstText(input: Record<string, unknown>): string | null {
  for (const value of Object.values(input)) {
    const text = str(value);
    if (text) return text;
  }
  return null;
}

/** One muted line describing a tool call, e.g. `Bash: Run the gates` or `Read src/a.ts`. */
export function toolSummary(name: string, input: Record<string, unknown>, cwd: string | null): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const rel = path ? relativeTo(cwd, path) : null;
  switch (name) {
    case 'Bash':
      return oneLine(`Bash: ${str(input.description) ?? str(input.command) ?? ''}`);
    case 'Read': {
      const offset = typeof input.offset === 'number' ? `:${input.offset}` : '';
      return oneLine(`Read ${rel ?? ''}${offset}`);
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return oneLine(`${name} ${rel ?? ''}`);
    case 'Grep':
      return oneLine(`Grep "${str(input.pattern) ?? ''}"${rel ? ` in ${rel}` : ''}`);
    case 'Glob':
      return oneLine(`Glob ${str(input.pattern) ?? ''}${rel ? ` in ${rel}` : ''}`);
    case 'Agent':
    case 'Task': {
      const type = str(input.subagent_type);
      return oneLine(`Agent: ${str(input.description) ?? 'subagent'}${type ? ` (${type})` : ''}`);
    }
    case 'WebFetch':
      return oneLine(`Fetch ${str(input.url) ?? ''}`);
    case 'WebSearch':
      return oneLine(`Search the web: ${str(input.query) ?? ''}`);
    case 'Skill':
      return oneLine(`Skill: ${str(input.skill) ?? ''}`);
    case 'TodoWrite':
      return `Update todos${Array.isArray(input.todos) ? ` (${input.todos.length})` : ''}`;
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? input.questions[0] : null;
      const question = isRecord(first) ? str(first.question) : null;
      return oneLine(`Question: ${question ?? ''}`);
    }
    default: {
      const label = toolLabel(name);
      const detail = rel ?? firstText(input);
      return oneLine(detail ? `${label}: ${detail}` : label);
    }
  }
}

/** JSON input of a tool without a dedicated view, for the expanded line. */
export function toolInput(input: Record<string, unknown>): string {
  return clip(JSON.stringify(input, null, 2), INPUT_CHARS);
}

function field(value: unknown, max = FIELD_CHARS): string {
  return typeof value === 'string' ? clip(value, max) : '';
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function todoStatus(value: unknown): FeedTodo['status'] {
  return value === 'completed' || value === 'in_progress' ? value : 'pending';
}

function todos(value: unknown): FeedTodo[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, 100).map((todo) => ({
    content: oneLine(str(todo.content) ?? str(todo.subject) ?? '', 400),
    status: todoStatus(todo.status),
    activeForm: str(todo.activeForm) ? oneLine(String(todo.activeForm), 400) : null,
  }));
}

function questions(value: unknown): FeedQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).slice(0, 10).map((q) => ({
    question: field(q.question, 2000),
    header: str(q.header),
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(isRecord).slice(0, 12).map((o) => ({
      label: field(o.label, 400),
      description: str(o.description) ? field(o.description, 1000) : null,
    })),
  }));
}

/** Structured input of the tools the feed draws in their own way; null for the rest. */
export function toolDetail(name: string, input: Record<string, unknown>): FeedToolDetail | null {
  const path = str(input.file_path) ?? str(input.notebook_path);
  switch (name) {
    case 'Bash':
      return {
        type: 'bash',
        command: field(input.command, 8000),
        description: str(input.description),
        background: input.run_in_background === true,
      };
    case 'Edit':
      return path
        ? { type: 'edit', path, edits: [{ oldText: field(input.old_string), newText: field(input.new_string) }] }
        : null;
    case 'MultiEdit': {
      if (!path || !Array.isArray(input.edits)) return null;
      const edits = input.edits.filter(isRecord).slice(0, MAX_EDITS);
      return { type: 'edit', path, edits: edits.map((e) => ({ oldText: field(e.old_string), newText: field(e.new_string) })) };
    }
    case 'Write':
      return path ? { type: 'write', path, content: field(input.content) } : null;
    case 'Read':
      return path ? { type: 'read', path, offset: num(input.offset), limit: num(input.limit) } : null;
    case 'Grep':
    case 'Glob':
      return { type: 'search', pattern: field(input.pattern, 1000), path: str(input.path), glob: str(input.glob) ?? str(input.type) };
    case 'Agent':
    case 'Task':
      return {
        type: 'agent',
        agentType: str(input.subagent_type),
        description: oneLine(str(input.description) ?? 'Subagent', 300),
        prompt: field(input.prompt),
        model: str(input.model),
        background: input.run_in_background === true,
      };
    case 'TodoWrite':
      return { type: 'todos', todos: todos(input.todos) };
    case 'TaskCreate':
    case 'TaskUpdate':
      return {
        type: 'task',
        taskId: str(input.taskId) ?? (num(input.taskId) !== null ? String(input.taskId) : null),
        subject: str(input.subject) ? oneLine(String(input.subject), 400) : null,
        status: str(input.status),
        activeForm: str(input.activeForm) ? oneLine(String(input.activeForm), 400) : null,
      };
    case 'AskUserQuestion':
      return { type: 'question', questions: questions(input.questions) };
    case 'ExitPlanMode':
      return { type: 'plan', plan: field(input.plan) };
    case 'WebFetch':
    case 'WebSearch':
      return { type: 'web', url: str(input.url), query: str(input.query), prompt: str(input.prompt) ? field(input.prompt, 2000) : null };
    default:
      return null;
  }
}

/** The hunks of a structuredPatch, cut once PATCH_CHARS of line text are kept. */
function patch(value: unknown): FeedHunk[] | null {
  if (!Array.isArray(value)) return null;
  const hunks: FeedHunk[] = [];
  let budget = PATCH_CHARS;
  for (const hunk of value) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines) || budget <= 0) continue;
    const lines: string[] = [];
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (budget <= 0) break;
      const kept = clip(line, 2000);
      lines.push(kept);
      budget -= kept.length + 1;
    }
    hunks.push({ oldStart: num(hunk.oldStart) ?? 1, newStart: num(hunk.newStart) ?? 1, lines });
  }
  return hunks;
}

/** Facts from a record's `toolUseResult` that the feed shows next to a tool call. */
export function resultMeta(name: string | null, meta: unknown): Partial<FeedToolResult> {
  if (!isRecord(meta)) return {};
  const out: Partial<FeedToolResult> = {};
  const hunks = patch(meta.structuredPatch);
  if (hunks && (hunks.length > 0 || meta.type === 'create')) out.patch = hunks;
  if (meta.type === 'create') out.created = true;
  const files = num(meta.numFiles);
  const lines = num(meta.numLines);
  if (meta.mode === 'content' && lines !== null) out.matches = { count: lines, unit: 'lines' };
  else if (files !== null) out.matches = { count: files, unit: 'files' };
  if (isRecord(meta.file)) {
    const count = num(meta.file.numLines);
    if (count !== null) out.lines = { count, total: num(meta.file.totalLines) };
  }
  if (name === 'Agent' || name === 'Task' || typeof meta.agentId === 'string') {
    const model = str(meta.resolvedModel) ?? str(meta.model);
    out.agent = { agentId: str(meta.agentId), model, async: meta.isAsync === true || meta.status === 'async_launched' };
  }
  if (isRecord(meta.answers)) {
    const answers: Record<string, string> = {};
    for (const [question, answer] of Object.entries(meta.answers)) {
      if (typeof answer === 'string') answers[question] = clip(answer, 2000);
    }
    out.answers = answers;
  }
  // Claude Code writes the plan to a file and calls ExitPlanMode without input; the result carries it.
  if ((name === null || name === 'ExitPlanMode') && typeof meta.plan === 'string' && meta.plan.trim()) out.plan = clip(meta.plan, FIELD_CHARS);
  return out;
}

/** Text of a tool_result's content: a string or blocks (text, image, document, tool_reference). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
    else if (block.type === 'document') parts.push('[document]');
    else if (block.type === 'tool_reference' && typeof block.tool_name === 'string') parts.push(block.tool_name);
  }
  return parts.join('\n');
}

type ItemBase = Pick<FeedItem, 'id' | 'at' | 'offset'>;

function pushClassified(out: ParsedFeed, base: ItemBase, kind: Classified, images = 0, thumbs: string[] = []): void {
  if (!kind) return;
  if (kind.kind === 'user') {
    out.items.push(thumbs.length > 0 ? { ...base, kind: 'user', text: kind.text, images, thumbs } : { ...base, kind: 'user', text: kind.text, images });
  } else if (kind.kind === 'notice' && kind.task) out.items.push({ ...base, kind: 'notice', text: kind.text, task: kind.task });
  else out.items.push({ ...base, kind: kind.kind, text: kind.text });
}

/** A pasted image block as a data URL, when it is base64 data of a reasonable size. */
function thumb(block: Record<string, unknown>): string | null {
  const source = isRecord(block.source) ? block.source : null;
  if (!source || source.type !== 'base64' || typeof source.data !== 'string') return null;
  const type = typeof source.media_type === 'string' ? source.media_type : '';
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(type) || source.data.length > THUMB_CHARS) return null;
  return `data:${type};base64,${source.data}`;
}

/**
 * Tool names by tool_use id, so results can be cut and described per tool. Filled while parsing;
 * a result whose call lies outside the parsed range gets the generic treatment.
 */
export type ToolNames = Map<string, string>;

function userContent(content: unknown, base: ItemBase, out: ParsedFeed, meta: unknown, names: ToolNames): void {
  if (typeof content === 'string') {
    pushClassified(out, base, classifyUserText(content));
    return;
  }
  if (!Array.isArray(content)) return;
  const texts: string[] = [];
  const thumbs: string[] = [];
  let images = 0;
  const results = content.filter((block) => isRecord(block) && block.type === 'tool_result').length;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      const name = names.get(block.tool_use_id) ?? null;
      // A call read in an earlier chunk is unnamed here; a Read result still shows by its file record.
      const read = name === 'Read' || (results === 1 && isRecord(meta) && isRecord(meta.file));
      const max = read ? READ_RESULT_CHARS : FIELD_CHARS;
      out.results.push({
        toolUseId: block.tool_use_id,
        text: clip(stripInjected(resultText(block.content)), max),
        isError: block.is_error === true,
        // The record-level toolUseResult describes the record's only result.
        ...(results === 1 ? resultMeta(name, meta) : {}),
      });
    } else if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image') {
      images++;
      const url = thumbs.length < MAX_THUMBS ? thumb(block) : null;
      if (url) thumbs.push(url);
    }
  }
  // Text next to tool results is injected context (reminders, hook output), not a prompt.
  if (texts.length === 0 || results > 0) return;
  pushClassified(out, base, classifyUserText(texts.join('\n\n')), images, thumbs);
}

function systemItem(record: Record<string, unknown>, base: ItemBase): FeedItem | null {
  const content = str(record.content);
  switch (record.subtype) {
    case 'compact_boundary':
      return { ...base, kind: 'notice', text: 'Conversation compacted' };
    case 'away_summary':
      return content ? { ...base, kind: 'notice', text: `While you were away: ${oneLine(content, 600)}` } : null;
    case 'scheduled_task_fire':
      return content ? { ...base, kind: 'notice', text: oneLine(content) } : null;
    case 'local_command': {
      const kind = content ? classifyUserText(content) : null;
      return kind && kind.kind !== 'user' ? { ...base, kind: kind.kind, text: kind.text } : null;
    }
    default:
      return null;
  }
}

/** Appends the feed items and tool results of one record; `offset` (its byte offset) names records without a uuid. */
export function parseFeedRecord(record: Record<string, unknown>, offset: number, out: ParsedFeed, names: ToolNames = new Map()): void {
  if (record.isSidechain === true) return;
  const uuid = typeof record.uuid === 'string' ? record.uuid : `@${offset}`;
  const at = typeof record.timestamp === 'string' ? record.timestamp : null;
  const cwd = typeof record.cwd === 'string' ? record.cwd : null;
  const message = isRecord(record.message) ? record.message : null;

  switch (record.type) {
    case 'user': {
      if (record.isMeta === true || !message) return;
      userContent(message.content, { id: uuid, at, offset }, out, record.toolUseResult, names);
      return;
    }
    case 'assistant': {
      if (!message || !Array.isArray(message.content)) return;
      message.content.forEach((block: unknown, index: number) => {
        if (!isRecord(block)) return;
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = block.text.trim();
          if (text && text !== '(no content)') out.items.push({ kind: 'assistant', id: `${uuid}:${index}`, at, offset, text });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          const input = isRecord(block.input) ? block.input : {};
          const id = typeof block.id === 'string' ? block.id : `${uuid}:${index}`;
          const detail = toolDetail(block.name, input);
          if (names.size > 5000) names.clear();
          names.set(id, block.name);
          out.items.push({
            kind: 'tool',
            id,
            at,
            offset,
            name: block.name,
            summary: toolSummary(block.name, input, cwd),
            input: detail ? '' : toolInput(input),
            detail,
          });
        }
      });
      return;
    }
    case 'attachment': {
      // Prompts typed while Claude was busy reach the transcript only as queued commands.
      const attachment = isRecord(record.attachment) ? record.attachment : null;
      if (!attachment || attachment.type !== 'queued_command') return;
      const prompt = attachment.prompt;
      const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? resultText(prompt) : '';
      if (text) pushClassified(out, { id: uuid, at, offset }, classifyUserText(text));
      return;
    }
    case 'system': {
      const item = systemItem(record, { id: uuid, at, offset });
      if (item) out.items.push(item);
      return;
    }
    default:
      return;
  }
}

/** Feed items of transcript lines in file order. Lines that are not JSON objects are skipped. */
export function parseFeedLines(lines: readonly FeedLine[]): ParsedFeed {
  const out: ParsedFeed = { items: [], results: [] };
  const names: ToolNames = new Map();
  for (const line of lines) {
    if (!line.text.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line.text);
    } catch {
      continue;
    }
    if (isRecord(record)) parseFeedRecord(record, line.offset, out, names);
  }
  return out;
}

/**
 * Whole lines of a byte range read from a transcript that starts at file offset `base`.
 * `alignStart` drops the first (possibly cut) line, for ranges that start mid-file. Bytes after
 * the last newline are a line still being written and are left for the next read. `start` and
 * `end` are the file offsets of the whole lines returned; with no newline at all both are null.
 */
export function splitLines(
  bytes: Uint8Array,
  base: number,
  alignStart: boolean,
): { lines: FeedLine[]; start: number | null; end: number | null } {
  const NL = 10;
  let head = 0;
  if (alignStart && base > 0) {
    const first = bytes.indexOf(NL);
    if (first < 0) return { lines: [], start: null, end: null };
    head = first + 1;
  }
  const last = bytes.lastIndexOf(NL);
  if (last < head) return { lines: [], start: base + head, end: base + head };
  const decoder = new TextDecoder();
  const lines: FeedLine[] = [];
  let from = head;
  while (from <= last) {
    const nl = bytes.indexOf(NL, from);
    lines.push({ offset: base + from, text: decoder.decode(bytes.subarray(from, nl)) });
    from = nl + 1;
  }
  return { lines, start: base + head, end: base + last + 1 };
}
