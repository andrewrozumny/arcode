import { describe, expect, it } from 'vitest';
import type { FeedChunk, FeedItem, FeedRequest, FeedToolResult } from '@shared/claude';
import { applyChunk, clipRef, deltaBrief, DELTA_BUDGET, emptyDigest, excerpt, FULL_BUDGET, fullBrief, markSent } from './sessionBrief';
import { SessionContext } from './sessionContext';

const at = { at: null, offset: 0 };
const prompt = (id: string, text: string): FeedItem => ({ ...at, id, kind: 'user', text, images: 0 });
const said = (id: string, text: string): FeedItem => ({ ...at, id, kind: 'assistant', text });
const bash = (id: string, command: string): FeedItem => ({
  ...at,
  id,
  kind: 'tool',
  name: 'Bash',
  summary: command,
  input: '',
  detail: { type: 'bash', command, description: null, background: false },
});
const edit = (id: string, path: string): FeedItem => ({ ...at, id, kind: 'tool', name: 'Edit', summary: path, input: '', detail: { type: 'edit', path, edits: [] } });
const result = (id: string, text: string, isError = false): FeedToolResult => ({ toolUseId: id, text, isError });

describe('clipping', () => {
  it('says how much is left and where to get it', () => {
    expect(clipRef('short', 100, 'x')).toBe('short');
    const clipped = clipRef('a'.repeat(500), 100, 'session_turn(-1)');
    expect(clipped.length).toBeLessThanOrEqual(100);
    expect(clipped).toMatch(/\[\+\d+ chars: session_turn\(-1\)\]$/);
  });

  it('keeps the head and the tail of a long output', () => {
    const text = `HEAD ${'x'.repeat(5000)} TAIL error here`;
    const cut = excerpt(text, 500, 'tool_output("t1")');
    expect(cut.startsWith('HEAD')).toBe(true);
    expect(cut.endsWith('TAIL error here')).toBe(true);
    expect(cut).toContain('tool_output("t1")');
    expect(cut.length).toBeLessThanOrEqual(560);
  });
});

describe('digest and briefs', () => {
  const digest = () => {
    const d = emptyDigest('s1');
    applyChunk(
      d,
      [
        prompt('p1', 'Сделай кнопку'),
        said('a1', 'Делаю.'),
        edit('e1', '/repo/src/a.ts'),
        edit('e2', '/repo/src/a.ts'),
        bash('b1', 'npm test'),
        { ...at, id: 't1', kind: 'tool', name: 'TodoWrite', summary: '', input: '', detail: { type: 'todos', todos: [{ content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }] } },
        prompt('p2', 'А теперь дебаг'),
        said('a2', 'Тесты упали, смотрю.'),
      ],
      [result('b1', `FAIL src/a.test.ts\n${'trace '.repeat(400)}\nExpected 1, got 2`, true), result('x', "The user doesn't want to proceed with this tool use.", true)],
      100,
    );
    return d;
  };

  it('has the current task, the latest message, todos, files and errors in the full brief', () => {
    const brief = fullBrief(digest(), { status: 'busy', root: '/repo' });
    expect(brief.startsWith('<claude_code_session kind="full">')).toBe(true);
    expect(brief).toContain('Claude Code is working right now.');
    expect(brief).toContain('Latest: А теперь дебаг');
    expect(brief).toContain('Before: Сделай кнопку');
    expect(brief).toContain('Тесты упали, смотрю.');
    expect(brief).toContain('[>] Writing tests');
    expect(brief).toContain('src/a.ts (2 edits)');
    expect(brief).toContain('Bash npm test failed:');
    expect(brief).not.toContain('/repo/src');
    expect(brief).toContain('Expected 1, got 2');
    expect(brief).toContain('tool_output("b1")');
    expect(brief).not.toContain("doesn't want to proceed");
  });

  it('stays within the budget however long the session is, with markers on what was cut', () => {
    const d = emptyDigest('s1');
    const items: FeedItem[] = [];
    for (let i = 0; i < 80; i++) items.push(prompt(`p${i}`, `prompt ${i} ${'z'.repeat(3000)}`), said(`a${i}`, `answer ${i} ${'y'.repeat(6000)}`));
    applyChunk(d, items, Array.from({ length: 10 }, (_, i) => result(`x${i}`, 'e'.repeat(9000), true)), 10);
    const brief = fullBrief(d, { status: 'idle' });
    expect(brief.length).toBeLessThanOrEqual(FULL_BUDGET + 500);
    expect(brief).toContain('Latest: prompt 79');
    expect(brief).toContain('session_turn(-1)');
    expect(brief).toContain('earlier prompts omitted');
  });

  it('sends only what changed after the first brief, and says when nothing did', () => {
    const d = digest();
    markSent(d);
    expect(deltaBrief(d, { status: 'idle' })).toContain('Nothing new in the session since your last message.');
    applyChunk(d, [prompt('p3', 'Проверь лог'), bash('b2', 'cat log'), said('a3', 'В логе таймаут.')], [result('b2', 'line\n'.repeat(50))], 200);
    const delta = deltaBrief(d, { status: 'idle' });
    expect(delta.startsWith('<claude_code_session kind="delta">')).toBe(true);
    expect(delta).toContain('Проверь лог');
    expect(delta).toContain('В логе таймаут.');
    expect(delta).toContain('Bash×1 (cat log)');
    expect(delta).toContain('Last command: cat log');
    expect(delta).not.toContain('Сделай кнопку');
    expect(delta).not.toContain('Plan / todos');
  });

  it('fits a delta with many long messages in its budget by dropping the oldest, visibly', () => {
    const d = emptyDigest('s1');
    markSent(d);
    applyChunk(d, Array.from({ length: 40 }, (_, i) => said(`a${i}`, `message ${i} ${'w'.repeat(3000)}`)), [], 10);
    const delta = deltaBrief(d, { status: 'busy' });
    expect(delta.length).toBeLessThanOrEqual(DELTA_BUDGET);
    expect(delta).toContain('message 39');
    expect(delta).toMatch(/\d+ earlier messages omitted/);
  });

  it('keeps an open question until its result comes, and the compaction summary', () => {
    const d = emptyDigest('s1');
    const question: FeedItem = {
      ...at,
      id: 'q1',
      kind: 'tool',
      name: 'AskUserQuestion',
      summary: '',
      input: '',
      detail: { type: 'question', questions: [{ question: 'Which DB?', header: null, multiSelect: false, options: [{ label: 'Postgres', description: null }, { label: 'SQLite', description: null }] }] },
    };
    applyChunk(d, [{ ...at, id: 'c', kind: 'notice', text: 'Earlier conversation summarized', compact: 'We built the login.' }, question], [], 10);
    expect(fullBrief(d, { status: 'waiting' })).toContain('Which DB? (Postgres / SQLite)');
    expect(fullBrief(d, { status: 'waiting' })).toContain('We built the login.');
    applyChunk(d, [], [result('q1', 'Postgres')], 20);
    expect(fullBrief(d, { status: 'busy' })).not.toContain('Which DB?');
  });
});

describe('SessionContext', () => {
  /** A fake transcript reader: chunks appended over time, read from offsets. */
  const reader = () => {
    const chunks: { items: FeedItem[]; results: FeedToolResult[] }[] = [];
    let rewritten = false;
    const read = async (request: FeedRequest): Promise<FeedChunk> => {
      const size = chunks.length;
      const base = { found: size > 0, size, usage: [], queue: [], ended: null };
      if (request.from !== undefined) {
        if (rewritten) {
          rewritten = false;
          return { ...base, start: 0, end: size, reset: true, items: chunks.flatMap((c) => c.items), results: [] };
        }
        const part = chunks.slice(request.from);
        return { ...base, start: request.from, end: size, reset: false, items: part.flatMap((c) => c.items), results: part.flatMap((c) => c.results) };
      }
      return { ...base, start: 0, end: size, reset: false, items: chunks.flatMap((c) => c.items), results: chunks.flatMap((c) => c.results) };
    };
    return { read, chunks, rewrite: () => (rewritten = true) };
  };

  it('sends a full brief first, then deltas, then a full one again when asked or on a switch', async () => {
    const { read, chunks } = reader();
    chunks.push({ items: [prompt('p1', 'Задача один')], results: [] });
    const context = new SessionContext(read);
    expect(await context.brief('s1', 'busy')).toContain('kind="full"');
    chunks.push({ items: [said('a1', 'Готово')], results: [] });
    const delta = await context.brief('s1', 'idle');
    expect(delta).toContain('kind="delta"');
    expect(delta).toContain('Готово');
    context.needFull();
    expect(await context.brief('s1', 'idle')).toContain('kind="full"');
    expect(await context.brief('s1', 'idle', true)).toContain('kind="full"');
    const switched = await context.brief('s2', 'idle');
    expect(switched).toContain('kind="full"');
    expect(switched).toContain('switched to another Claude Code session');
  });

  it('says when no session is open, once', async () => {
    const context = new SessionContext(reader().read);
    expect(await context.brief(null, null)).toContain('No Claude Code session is open');
    expect(await context.brief(null, null)).toBe('');
    expect(await context.brief(null, null, true)).toContain('No Claude Code session is open');
  });

  it('rebuilds and sends the whole brief when the transcript was rewritten', async () => {
    const { read, chunks, rewrite } = reader();
    chunks.push({ items: [prompt('p1', 'Один')], results: [] });
    const context = new SessionContext(read);
    await context.brief('s1', 'idle');
    rewrite();
    expect(await context.brief('s1', 'idle')).toContain('kind="full"');
  });
});
