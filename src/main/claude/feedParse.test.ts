import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '@shared/claude';
import { feedRequest, readFeed } from './feed';
import {
  FIELD_CHARS,
  THUMB_CHARS,
  classifyUserText,
  toolDetail,
  parseFeedLines,
  parseFeedRecord,
  splitLines,
  toolLabel,
  toolSummary,
} from './feedParse';
import type { FeedLine, ParsedFeed } from './feedParse';

const CWD = '/repo';

function parse(...records: Record<string, unknown>[]): ParsedFeed {
  const out: ParsedFeed = { items: [], results: [] };
  records.forEach((record, index) => parseFeedRecord(record, index * 100, out));
  return out;
}

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid: `u-${JSON.stringify(content).length}`,
  timestamp: '2026-10-14T10:00:00.000Z',
  cwd: CWD,
  message: { role: 'user', content },
  ...extra,
});

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: 'a-1',
  timestamp: '2026-10-14T10:00:01.000Z',
  cwd: CWD,
  message: { role: 'assistant', content },
  ...extra,
});

const kinds = (items: FeedItem[]): string[] => items.map((item) => item.kind);

describe('user records', () => {
  it('keeps a typed prompt and drops system reminders inside it', () => {
    const { items } = parse(user('Fix the build\n<system-reminder>be careful</system-reminder>'));
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Fix the build', images: 0, at: '2026-10-14T10:00:00.000Z' }),
    ]);
  });

  it('turns tool_result blocks into results, not prompts', () => {
    const parsed = parse(
      user([
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok\n<system-reminder>x</system-reminder>' },
        { type: 'text', text: 'injected next to a result' },
      ]),
    );
    expect(parsed.items).toEqual([]);
    expect(parsed.results).toEqual([{ toolUseId: 'toolu_1', text: 'ok', isError: false }]);
  });

  it('reads block results and error flags', () => {
    const { results } = parse(
      user([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: true,
          content: [{ type: 'text', text: 'boom' }, { type: 'image', source: {} }],
        },
      ]),
    );
    expect(results).toEqual([{ toolUseId: 'toolu_2', text: 'boom\n[image]', isError: true }]);
  });

  it('counts pasted images next to the prompt text', () => {
    const { items } = parse(user([{ type: 'text', text: '[Image #1] what is this?' }, { type: 'image', source: {} }]));
    expect(items).toEqual([expect.objectContaining({ kind: 'user', text: '[Image #1] what is this?', images: 1 })]);
  });

  it('hides meta entries and sidechain records', () => {
    expect(parse(user('Base directory for this skill', { isMeta: true })).items).toEqual([]);
    expect(parse(user('subagent prompt', { isSidechain: true })).items).toEqual([]);
    expect(parse(assistant([{ type: 'text', text: 'subagent reply' }], { isSidechain: true })).items).toEqual([]);
  });

  it('classifies commands, notices and noise', () => {
    expect(classifyUserText('<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>opus</command-args>')).toEqual({
      kind: 'command',
      text: '/model opus',
    });
    expect(classifyUserText('<bash-input>git status</bash-input>')).toEqual({ kind: 'command', text: '! git status' });
    expect(classifyUserText('<bash-stdout>lots</bash-stdout><bash-stderr></bash-stderr>')).toBeNull();
    expect(classifyUserText('<local-command-stdout>Set model to \u001b[1mOpus\u001b[22m</local-command-stdout>')).toEqual({
      kind: 'notice',
      text: 'Set model to Opus',
    });
    expect(
      classifyUserText('<task-notification>\n<task-id>a1</task-id>\n<summary>Agent "Review" finished</summary>\n</task-notification>'),
    ).toEqual({ kind: 'notice', text: 'Agent "Review" finished', task: { toolUseId: null, status: 'completed', result: null } });
    expect(classifyUserText('[Request interrupted by user for tool use]')).toEqual({ kind: 'notice', text: 'Interrupted by user' });
    expect(classifyUserText('<system-reminder>only a reminder</system-reminder>')).toBeNull();
    expect(classifyUserText('<ide_opened_file>The user opened a.ts</ide_opened_file>Explain this')).toEqual({
      kind: 'user',
      text: 'Explain this',
    });
  });
});

describe('assistant records', () => {
  it('keeps text, hides thinking and turns tool_use into one tool line', () => {
    const { items } = parse(
      assistant([
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: '## Plan\n\n1. Do it' },
        { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'scripts/gates.sh all', description: 'Run the gates' } },
        { type: 'text', text: '(no content)' },
      ]),
    );
    expect(kinds(items)).toEqual(['assistant', 'tool']);
    expect(items[0]).toMatchObject({ id: 'a-1:1', text: '## Plan\n\n1. Do it' });
    expect(items[1]).toMatchObject({
      id: 'toolu_9',
      name: 'Bash',
      summary: 'Bash: Run the gates',
      input: '',
      detail: { type: 'bash', command: 'scripts/gates.sh all', description: 'Run the gates', background: false },
    });
  });
});

describe('other records', () => {
  it('shows queued prompts, compaction and task notices; hides the rest', () => {
    const { items } = parse(
      { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: 'also update docs', commandMode: 'prompt' } },
      { type: 'attachment', uuid: 'q2', attachment: { type: 'total_tokens_reminder' } },
      { type: 'attachment', uuid: 'q3', attachment: { type: 'bash_output_audience_note', content: 'Shell cwd was reset' } },
      { type: 'system', uuid: 's1', subtype: 'compact_boundary', content: 'Conversation compacted' },
      { type: 'system', uuid: 's2', subtype: 'stop_hook_summary' },
      { type: 'system', uuid: 's3', subtype: 'turn_duration' },
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'permission-mode', permissionMode: 'auto' },
    );
    expect(items.map((item) => [item.kind, 'text' in item ? item.text : ''])).toEqual([
      ['user', 'also update docs'],
      ['notice', 'Conversation compacted'],
    ]);
  });
});

describe('tool summaries', () => {
  it('describes common tools with paths relative to the session folder', () => {
    expect(toolSummary('Read', { file_path: '/repo/src/a.ts', offset: 40 }, CWD)).toBe('Read src/a.ts:40');
    expect(toolSummary('Edit', { file_path: '/repo/src/b.ts', old_string: 'a', new_string: 'b' }, CWD)).toBe('Edit src/b.ts');
    expect(toolSummary('Write', { file_path: '/elsewhere/c.md', content: '' }, CWD)).toBe('Write /elsewhere/c.md');
    expect(toolSummary('Grep', { pattern: 'TODO', path: '/repo/src' }, CWD)).toBe('Grep "TODO" in src');
    expect(toolSummary('Agent', { description: 'Explore the tree', subagent_type: 'Explore' }, CWD)).toBe('Agent: Explore the tree (Explore)');
    expect(toolSummary('Bash', { command: 'ls -la\nwc -l' }, CWD)).toBe('Bash: ls -la wc -l');
    expect(toolSummary('mcp__plugin_playwright_playwright__browser_navigate', { url: 'https://x.dev' }, CWD)).toBe(
      'playwright · browser_navigate: https://x.dev',
    );
    expect(toolLabel('mcp__claude_ai_Gmail__search_threads')).toBe('Gmail · search_threads');
  });
});

describe('structured tool calls', () => {
  it('keeps edit texts, written content and questions, cut to FIELD_CHARS', () => {
    expect(toolDetail('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' })).toEqual({
      type: 'edit',
      path: '/repo/a.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(toolDetail('MultiEdit', { file_path: '/r/b.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] })).toMatchObject({
      edits: [{ oldText: '1', newText: '2' }, { oldText: '3', newText: '4' }],
    });
    const write = toolDetail('Write', { file_path: '/r/c.md', content: 'x'.repeat(FIELD_CHARS * 2) });
    expect(write?.type === 'write' && write.content.length).toBe(FIELD_CHARS);
    expect(
      toolDetail('AskUserQuestion', {
        questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B' }] }],
      }),
    ).toEqual({
      type: 'question',
      questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: 'first' }, { label: 'B', description: null }] }],
    });
    expect(toolDetail('TodoWrite', { todos: [{ content: 'Do', status: 'in_progress', activeForm: 'Doing' }] })).toEqual({
      type: 'todos',
      todos: [{ content: 'Do', status: 'in_progress', activeForm: 'Doing' }],
    });
    expect(toolDetail('ExitPlanMode', { plan: '# Plan' })).toEqual({ type: 'plan', plan: '# Plan' });
    expect(toolDetail('mcp__x__y', { a: 1 })).toBeNull();
  });

  it('keeps generic JSON input only for tools without a detail', () => {
    const { items } = parse(
      assistant([
        { type: 'tool_use', id: 't1', name: 'mcp__srv__do', input: { q: 'x' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      ]),
    );
    expect(items[0]).toMatchObject({ input: '{\n  "q": "x"\n}', detail: null });
    expect(items[1]).toMatchObject({ input: '', detail: { type: 'read', path: '/repo/a.ts', offset: null, limit: null } });
  });

  it('reads the patch, counts and agent facts from toolUseResult', () => {
    const out: ParsedFeed = { items: [], results: [] };
    const names = new Map<string, string>();
    parseFeedRecord(assistant([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } }]), 0, out, names);
    parseFeedRecord(
      user([{ type: 'tool_result', tool_use_id: 'e1', content: 'updated' }], {
        toolUseResult: { filePath: '/repo/a.ts', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }] },
      }),
      100,
      out,
      names,
    );
    expect(out.results[0]).toEqual({ toolUseId: 'e1', text: 'updated', isError: false, patch: [{ oldStart: 3, newStart: 3, lines: ['-a', '+b'] }] });

    const agent = parse(
      user([{ type: 'tool_result', tool_use_id: 'ag', content: 'launched' }], {
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1', resolvedModel: 'claude-haiku-5-5' },
      }),
    );
    expect(agent.results[0]?.agent).toEqual({ agentId: 'a1', model: 'claude-haiku-5-5', async: true });

    const grep = parse(user([{ type: 'tool_result', tool_use_id: 'g', content: 'Found 4 files' }], { toolUseResult: { mode: 'files_with_matches', numFiles: 4 } }));
    expect(grep.results[0]?.matches).toEqual({ count: 4, unit: 'files' });

    const answers = parse(user([{ type: 'tool_result', tool_use_id: 'q', content: 'answered' }], { toolUseResult: { answers: { 'Which?': 'A' } } }));
    expect(answers.results[0]?.answers).toEqual({ 'Which?': 'A' });

    // Claude Code calls ExitPlanMode without input; the approved plan comes back in the result.
    const plan = parse(user([{ type: 'tool_result', tool_use_id: 'p', content: 'User has approved your plan.' }], { toolUseResult: { plan: '# Plan\n\n1. Step' } }));
    expect(plan.results[0]?.plan).toBe('# Plan\n\n1. Step');
  });

  it('cuts Read results short and keeps other results up to FIELD_CHARS', () => {
    const out: ParsedFeed = { items: [], results: [] };
    const names = new Map([['r', 'Read']]);
    parseFeedRecord(user([{ type: 'tool_result', tool_use_id: 'r', content: 'x'.repeat(5000) }]), 0, out, names);
    parseFeedRecord(user([{ type: 'tool_result', tool_use_id: 'b', content: 'y'.repeat(FIELD_CHARS + 50) }]), 1, out, names);
    expect(out.results[0]?.text.length).toBeLessThan(1000);
    expect(out.results[1]?.text.length).toBe(FIELD_CHARS);
  });

  it('parses task notifications with their call, status and report', () => {
    const notice = classifyUserText(
      '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_7</tool-use-id>\n<status>completed</status>\n<summary>Agent "Map" finished</summary>\n<result>All done.</result>\n</task-notification>',
    );
    expect(notice).toEqual({ kind: 'notice', text: 'Agent "Map" finished', task: { toolUseId: 'toolu_7', status: 'completed', result: 'All done.' } });
  });

  it('sends small pasted images as data URLs and only counts large ones', () => {
    const { items } = parse(
      user([
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B'.repeat(THUMB_CHARS + 1) } },
      ]),
    );
    expect(items[0]).toMatchObject({ kind: 'user', images: 2, thumbs: ['data:image/png;base64,AAAA'] });
  });
});

describe('line splitting', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('keeps a partial last line for the next read', () => {
    const split = splitLines(bytes('{"a":1}\n{"b":2}\n{"c":'), 100, false);
    expect(split.lines.map((l: FeedLine) => [l.offset, l.text])).toEqual([
      [100, '{"a":1}'],
      [108, '{"b":2}'],
    ]);
    expect(split).toMatchObject({ start: 100, end: 116 });
  });

  it('drops the cut first line of a range that starts mid-file', () => {
    const split = splitLines(bytes('t":1}\n{"x":"é"}\n'), 50, true);
    expect(split.lines.map((l) => l.text)).toEqual(['{"x":"é"}']);
    expect(split).toMatchObject({ start: 56, end: 67 });
  });

  it('reports no lines when a range is inside one long line', () => {
    expect(splitLines(bytes('aaaa'), 10, true)).toEqual({ lines: [], start: null, end: null });
    expect(splitLines(bytes('aaaa'), 10, false)).toEqual({ lines: [], start: 10, end: 10 });
  });

  it('parses lines and skips broken ones', () => {
    const parsed = parseFeedLines([
      { offset: 0, text: JSON.stringify(user('hello')) },
      { offset: 10, text: '{"type":"user","mess' },
      { offset: 20, text: '' },
    ]);
    expect(kinds(parsed.items)).toEqual(['user']);
    expect(parsed.items[0]?.offset).toBe(0);
  });
});

describe('readFeed', () => {
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

  function transcript(): { home: string; file: string } {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-feed-'));
    const dir = join(home, '.claude', 'projects', '-repo');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, line(user('first')) + line(assistant([{ type: 'text', text: 'reply' }])));
    return { home, file };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not search again for a missing transcript for a few seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const home = mkdtempSync(join(os.tmpdir(), 'acode-feed-'));
    const missingId = '22222222-3333-4444-5555-666666666666';
    expect((await readFeed({ sessionId: missingId }, home)).found).toBe(false);
    const dir = join(home, '.claude', 'projects', '-repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${missingId}.jsonl`), line(user('hello')));
    // Created right after the miss: still reported missing until the miss expires.
    expect((await readFeed({ sessionId: missingId }, home)).found).toBe(false);
    vi.advanceTimersByTime(5000);
    expect((await readFeed({ sessionId: missingId }, home)).found).toBe(true);
  });

  it('loads the tail, then only appended whole lines', async () => {
    const { home, file } = transcript();
    const first = await readFeed({ sessionId }, home);
    expect(first.found).toBe(true);
    expect(first.start).toBe(0);
    expect(first.end).toBe(first.size);
    expect(kinds(first.items)).toEqual(['user', 'assistant']);

    const next = line(user('second'));
    appendFileSync(file, next.slice(0, 10));
    const partial = await readFeed({ sessionId, from: first.end }, home);
    expect(partial.items).toEqual([]);
    expect(partial.end).toBe(first.end);

    appendFileSync(file, next.slice(10));
    const whole = await readFeed({ sessionId, from: partial.end }, home);
    expect(whole.items).toEqual([expect.objectContaining({ kind: 'user', text: 'second' })]);
    expect(whole.end).toBe(whole.size);
  });

  it('keeps lines longer than one backward step and pages back to the start', async () => {
    const { home, file } = transcript();
    appendFileSync(file, line(user([{ type: 'tool_result', tool_use_id: 'big', content: 'x'.repeat(700_000) }])));
    appendFileSync(file, line(user('after the big result')));
    const tail = await readFeed({ sessionId }, home);
    expect(tail.start).toBe(0);
    expect(kinds(tail.items)).toEqual(['user', 'assistant', 'user']);
    expect(tail.results.map((r) => r.toolUseId)).toEqual(['big']);
    expect(tail.results[0]?.text.length).toBeLessThanOrEqual(FIELD_CHARS);
  });

  it('starts over when the file shrank, and reports unknown sessions', async () => {
    const { home } = transcript();
    const reset = await readFeed({ sessionId, from: 10_000_000 }, home);
    expect(reset.reset).toBe(true);
    expect(reset.items.length).toBe(2);
    expect((await readFeed({ sessionId: '99999999-0000-0000-0000-000000000000' }, home)).found).toBe(false);
  });

  it('checks requests from the renderer', () => {
    expect(feedRequest({ sessionId, from: 5 })).toEqual({ sessionId, from: 5 });
    expect(() => feedRequest({ sessionId, from: -1 })).toThrow();
    expect(() => feedRequest({ sessionId, before: 1.5 })).toThrow();
    expect(() => feedRequest('x')).toThrow();
  });
});
