import { describe, expect, it } from 'vitest';
import type { FeedChunk, FeedItem, FeedUsage } from '@shared/claude';
import { agentActivity, compactTokens, turnDuration, turnLabel, turnStats, usageTotals } from './feedModel';
import { DIVIDER_GAP_MS, MAX_ITEMS, MAX_LOADED_ITEMS, applyChunk, canLoadEarlier, emptyFeed, endsMidTurn, groupFeed, lastPromptAt, pendingPrompt, planTexts, runningCall, mergeChunk, runState, taskList, taskNotices } from './feedModel';

const text = (id: string, offset: number, kind: 'user' | 'assistant' = 'assistant'): FeedItem =>
  kind === 'user' ? { kind, id, at: null, offset, text: id, images: 0 } : { kind, id, at: null, offset, text: id };

const tool = (id: string, offset: number, summary = `Bash: ${id}`): Extract<FeedItem, { kind: 'tool' }> => ({
  kind: 'tool',
  id,
  at: null,
  offset,
  name: summary.split(/[:\s]/)[0] ?? 'Bash',
  summary,
  input: '',
  detail: null,
});

function chunk(start: number, end: number, items: FeedItem[], extra: Partial<FeedChunk> = {}): FeedChunk {
  return { found: true, size: end, start, end, reset: false, items, results: [], usage: [], ended: null, ...extra };
}

describe('mergeChunk', () => {
  it('loads the tail, appends live lines and prepends earlier ones', () => {
    let state = mergeChunk(emptyFeed('s'), chunk(100, 200, [text('b', 100)]), 'tail');
    expect(state).toMatchObject({ loaded: true, found: true, start: 100, end: 200 });

    state = mergeChunk(state, chunk(200, 260, [tool('t1', 200)]), 'append');
    state = mergeChunk(state, chunk(260, 300, [], { results: [{ toolUseId: 't1', text: 'ok', isError: false }] }), 'append');
    expect(state.items.map((i) => i.id)).toEqual(['b', 't1']);
    expect(state.results.t1?.text).toBe('ok');
    expect(state.end).toBe(300);

    state = mergeChunk(state, chunk(0, 100, [text('a', 0, 'user')]), 'prepend');
    expect(state.items.map((i) => i.id)).toEqual(['a', 'b', 't1']);
    expect(state.start).toBe(0);
  });

  it('ignores stale appends and empty polls', () => {
    const state = mergeChunk(emptyFeed('s'), chunk(0, 50, [text('a', 0)]), 'tail');
    expect(mergeChunk(state, chunk(10, 60, [text('x', 10)]), 'append')).toBe(state);
    expect(mergeChunk(state, chunk(50, 50, []), 'append')).toBe(state);
  });

  it('starts over on a reset and when the transcript is missing', () => {
    const state = mergeChunk(emptyFeed('s'), chunk(0, 50, [text('a', 0)]), 'tail');
    const reset = mergeChunk(state, chunk(0, 20, [text('z', 0)], { reset: true }), 'append');
    expect(reset.items.map((i) => i.id)).toEqual(['z']);
    const missing = mergeChunk(state, { ...chunk(0, 0, []), found: false }, 'append');
    expect(missing).toMatchObject({ loaded: true, found: false, items: [] });
  });

  it('keeps at most MAX_ITEMS, moving start to the first kept item', () => {
    const many = Array.from({ length: MAX_ITEMS + 5 }, (_, i) => text(`i${i}`, i * 10));
    const state = mergeChunk(emptyFeed('s'), chunk(0, many.length * 10, many), 'tail');
    expect(state.items.length).toBe(MAX_ITEMS);
    expect(state.start).toBe(50);
  });

  it('trims at record boundaries: items of one record are kept or dropped together', () => {
    // Five records of two items each (same offset), then MAX_ITEMS - 9 single-item records.
    const pairs = Array.from({ length: 10 }, (_, i) => text(`p${i}`, Math.floor(i / 2) * 10));
    const singles = Array.from({ length: MAX_ITEMS - 9 }, (_, i) => text(`s${i}`, 100 + i * 10));
    const items = [...pairs, ...singles];
    const state = mergeChunk(emptyFeed('s'), chunk(0, 100 + singles.length * 10, items), 'tail');
    // One item over the cap would cut the first record in half; the whole record goes instead.
    expect(state.items[0]?.id).toBe('p2');
    expect(state.start).toBe(10);
    expect(state.items.length).toBe(MAX_ITEMS - 1);
  });

  it('keeps items loaded earlier when live lines arrive, up to MAX_LOADED_ITEMS', () => {
    const tail = Array.from({ length: MAX_ITEMS }, (_, i) => text(`t${i}`, 1000 + i));
    let state = mergeChunk(emptyFeed('s'), chunk(1000, 1000 + MAX_ITEMS, tail), 'tail');
    const earlier = Array.from({ length: 100 }, (_, i) => text(`e${i}`, 900 + i));
    state = mergeChunk(state, chunk(900, 1000, earlier), 'prepend');
    expect(state.start).toBe(900);
    state = mergeChunk(state, chunk(state.end, state.end + 1, [text('live', state.end)]), 'append');
    expect(state.items[0]?.id).toBe('e0');
    expect(state.start).toBe(900);
    expect(state.items.length).toBe(MAX_ITEMS + 101);
    // Live lines past MAX_LOADED_ITEMS drop the oldest again.
    const more = Array.from({ length: MAX_ITEMS }, (_, i) => text(`m${i}`, state.end + i));
    state = mergeChunk(state, chunk(state.end, state.end + MAX_ITEMS, more), 'append');
    expect(state.items.length).toBe(MAX_LOADED_ITEMS);
    expect(state.items[0]?.id).toBe('t1');
  });

  it('stops loading earlier at MAX_LOADED_ITEMS', () => {
    const tail = Array.from({ length: MAX_ITEMS }, (_, i) => text(`t${i}`, 10_000 + i));
    let state = mergeChunk(emptyFeed('s'), chunk(10_000, 10_000 + MAX_ITEMS, tail), 'tail');
    expect(canLoadEarlier(state)).toBe(true);
    const earlier = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => text(`e${i}`, 5000 + i));
    state = mergeChunk(state, chunk(5000, 10_000, earlier), 'prepend');
    expect(state.items.length).toBe(MAX_LOADED_ITEMS);
    expect(state.items[0]?.id).toBe('e10');
    expect(canLoadEarlier(state)).toBe(false);
  });

  it('drops a late append or prepend for another session; a tail starts the new one', () => {
    const b = mergeChunk(emptyFeed('b'), chunk(100, 200, [text('b1', 100)]), 'tail');
    const late = chunk(0, 100, [text('a1', 0)]);
    expect(applyChunk(b, 'a', late, 'prepend')).toBe(b);
    expect(applyChunk(b, 'a', late, 'append')).toBe(b);
    expect(applyChunk(null, 'a', late, 'prepend')).toBeNull();
    expect(applyChunk(b, 'a', late, 'tail')).toMatchObject({ sessionId: 'a', start: 0, end: 100 });
    expect(applyChunk(b, 'b', chunk(200, 210, [text('b2', 200)]), 'append')?.items.map((i) => i.id)).toEqual(['b1', 'b2']);
  });
});

describe('groupFeed', () => {
  it('groups consecutive tool calls between text items', () => {
    const blocks = groupFeed([text('u', 0, 'user'), tool('t1', 1), tool('t2', 2, 'Read src/a.ts'), text('a', 3), tool('t3', 4)]);
    expect(blocks.map((b) => (b.type === 'tools' ? b.items.map((i) => i.id).join('+') : b.type === 'divider' ? '|' : b.type === 'turn' ? '#' : b.item.id))).toEqual([
      'u',
      't1+t2',
      'a',
      't3',
    ]);
  });

  it('draws agents, questions, plans and the latest task list as cards', () => {
    const agent: FeedItem = { ...tool('ag', 1), name: 'Agent', detail: { type: 'agent', agentType: 'Explore', description: 'Look', prompt: '', model: null, background: false } };
    const todos = (id: string, offset: number): FeedItem => ({ ...tool(id, offset), name: 'TodoWrite', detail: { type: 'todos', todos: [] } });
    const blocks = groupFeed([tool('t1', 0), agent, todos('td1', 2), tool('t2', 3), todos('td2', 4)]);
    expect(blocks.map((b) => (b.type === 'tools' ? `tools:${b.items.map((i) => i.id).join('+')}` : b.type === 'card' ? `card:${b.item.id}` : b.type))).toEqual([
      'tools:t1',
      'card:ag',
      'tools:td1+t2',
      'card:td2',
    ]);
  });

  it('puts a divider before an item after a long pause', () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 9, 14, 10) + ms).toISOString();
    const items: FeedItem[] = [
      { ...text('a', 0), at: at(0) },
      { ...text('b', 1), at: at(60_000) },
      { ...text('c', 2), at: at(60_000 + DIVIDER_GAP_MS) },
    ];
    expect(groupFeed(items).map((b) => b.type)).toEqual(['item', 'item', 'divider', 'item']);
  });
});

describe('task list', () => {
  const task = (id: string, offset: number, name: string, detail: Record<string, unknown>): FeedItem => ({
    ...tool(id, offset),
    name,
    detail: { type: 'task', taskId: null, subject: null, status: null, activeForm: null, ...detail } as never,
  });

  it('shows the latest TodoWrite list as it is', () => {
    const items: FeedItem[] = [
      { ...tool('w1', 0), name: 'TodoWrite', detail: { type: 'todos', todos: [{ content: 'old', status: 'pending', activeForm: null }] } },
      {
        ...tool('w2', 1),
        name: 'TodoWrite',
        detail: {
          type: 'todos',
          todos: [
            { content: 'Parse', status: 'completed', activeForm: null },
            { content: 'Render', status: 'in_progress', activeForm: 'Rendering' },
          ],
        },
      },
    ];
    expect(taskList(items, {}).map((t) => [t.subject, t.status])).toEqual([
      ['Parse', 'completed'],
      ['Render', 'in_progress'],
    ]);
  });

  it('replays TaskCreate and TaskUpdate calls, taking ids from the results', () => {
    const items = [
      task('c1', 0, 'TaskCreate', { subject: 'Write tests' }),
      task('c2', 1, 'TaskCreate', { subject: 'Ship' }),
      task('u1', 2, 'TaskUpdate', { taskId: '1', status: 'completed' }),
      task('u2', 3, 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
      task('u3', 4, 'TaskUpdate', { taskId: '7', status: 'deleted' }),
    ];
    const results = {
      c1: { toolUseId: 'c1', text: 'Task #1 created successfully: Write tests', isError: false },
      c2: { toolUseId: 'c2', text: 'Task #2 created successfully: Ship', isError: false },
    };
    expect(taskList(items, results).map((t) => [t.id, t.subject, t.status])).toEqual([
      ['1', 'Write tests', 'completed'],
      ['2', 'Ship', 'in_progress'],
    ]);
  });
});

describe('run state', () => {
  const agent: FeedItem & { kind: 'tool' } = {
    ...(tool('ag', 0) as FeedItem & { kind: 'tool' }),
    name: 'Agent',
    detail: { type: 'agent', agentType: null, description: 'x', prompt: '', model: null, background: true },
  };
  const launched = { toolUseId: 'ag', text: 'launched', isError: false, agent: { agentId: 'a1', model: null, async: true } };

  it('keeps a background agent running until its notification', () => {
    expect(runState(agent, launched, undefined, 'idle')).toBe('running');
    expect(runState(agent, launched, { toolUseId: 'ag', status: 'completed', result: 'done' }, 'idle')).toBe('done');
    expect(runState(agent, launched, { toolUseId: 'ag', status: 'failed', result: null }, 'idle')).toBe('error');
    expect(runState(agent, launched, undefined, 'gone')).toBe('stopped');
  });

  it('marks calls without a result as running only while the session works', () => {
    const call = tool('t', 0) as FeedItem & { kind: 'tool' };
    expect(runState(call, undefined, undefined, 'busy')).toBe('running');
    expect(runState(call, undefined, undefined, 'idle')).toBe('stopped');
    expect(runState(call, { toolUseId: 't', text: 'x', isError: true }, undefined, 'busy')).toBe('error');
  });

  it('indexes task notifications by tool call', () => {
    const notices = taskNotices([{ kind: 'notice', id: 'n', at: null, offset: 0, text: 'done', task: { toolUseId: 'ag', status: 'completed', result: null } }]);
    expect(notices.get('ag')?.status).toBe('completed');
  });
});

describe('endsMidTurn', () => {
  it('is true after a prompt or a tool call, false after a reply or an interrupt', () => {
    expect(endsMidTurn([text('u', 0, 'user')])).toBe(true);
    expect(endsMidTurn([text('u', 0, 'user'), tool('t', 1)])).toBe(true);
    expect(endsMidTurn([text('u', 0, 'user'), text('a', 1)])).toBe(false);
    expect(endsMidTurn([tool('t', 1), { kind: 'notice', id: 'n', at: null, offset: 2, text: 'Interrupted by user' }])).toBe(false);
    expect(
      endsMidTurn([tool('t', 1), { kind: 'notice', id: 'n', at: null, offset: 2, text: 'Agent done', task: { toolUseId: 'x', status: 'completed', result: null } }]),
    ).toBe(true);
  });
});

describe('current activity', () => {
  it('finds the newest running call and the start of the turn', () => {
    const items: FeedItem[] = [{ ...text('u', 0, 'user'), at: '2026-10-14T10:00:00.000Z' }, tool('t1', 1), tool('t2', 2)];
    const done = { toolUseId: 'x', text: '', isError: false };
    expect(runningCall(items, { t1: done, t2: done }, new Map(), 'busy')).toBeNull();
    expect(runningCall(items, { t2: done }, new Map(), 'busy')?.id).toBe('t1');
    expect(runningCall(items, {}, new Map(), 'busy')?.id).toBe('t2');
    expect(runningCall([...items, text('a', 3)], {}, new Map(), 'busy')).toBeNull();
    expect(lastPromptAt(items)).toBe('2026-10-14T10:00:00.000Z');
  });
});

describe('prompts', () => {
  const withDetail = (id: string, offset: number, detail: NonNullable<Extract<FeedItem, { kind: 'tool' }>['detail']>): FeedItem => ({ ...tool(id, offset), detail });
  const done = { toolUseId: 'x', text: '', isError: false };
  const question = withDetail('q', 2, { type: 'question', questions: [{ question: 'Which?', header: null, multiSelect: false, options: [] }] });
  const notice: FeedItem = { kind: 'notice', id: 'n', at: null, offset: 3, text: 'Agent done', task: { toolUseId: 'x', status: 'completed', result: null } };

  it('finds the question or plan Claude waits on: the latest call, without a result, while waiting', () => {
    expect(pendingPrompt([text('u', 0, 'user'), question], {}, 'waiting')?.id).toBe('q');
    expect(pendingPrompt([question, notice], {}, 'waiting')?.id).toBe('q');
    expect(pendingPrompt([question], {}, 'busy')).toBeNull();
    expect(pendingPrompt([question], { q: done }, 'waiting')).toBeNull();
    expect(pendingPrompt([question, text('a', 4)], {}, 'waiting')).toBeNull();
    expect(pendingPrompt([question, tool('t', 4)], {}, 'waiting')).toBeNull();
  });

  it('takes the plan text from the input, the result or the plan file written before the call', () => {
    const file = withDetail('w', 1, { type: 'write', path: '/home/me/.claude/plans/quiet-plan.md', content: '# From the file' });
    const empty = withDetail('p', 2, { type: 'plan', plan: '' });
    const own = withDetail('p2', 3, { type: 'plan', plan: '# Own input' });
    expect(planTexts([file, empty], {}).get('p')).toBe('# From the file');
    expect(planTexts([file, empty], { p: { ...done, plan: '# Approved' } }).get('p')).toBe('# Approved');
    expect(planTexts([file, own], {}).get('p2')).toBe('# Own input');
    // A file is used once: a later plan call without input has no text.
    expect(planTexts([file, empty, withDetail('p3', 4, { type: 'plan', plan: '' })], {}).has('p3')).toBe(false);
    expect(planTexts([withDetail('w2', 1, { type: 'write', path: '/repo/notes.md', content: 'x' }), empty], {}).has('p')).toBe(false);
  });
});

const at = (seconds: number): string => new Date(Date.UTC(2026, 9, 14, 10, 0, seconds)).toISOString();
const timed = (item: FeedItem, seconds: number): FeedItem => ({ ...item, at: at(seconds) });
const use = (messageId: string, offset: number, seconds: number, tokens: Partial<FeedUsage> = {}): FeedUsage => ({
  messageId,
  offset,
  at: at(seconds),
  input: 10,
  output: 100,
  cacheRead: 1000,
  cacheWrite: 200,
  ...tokens,
});

describe('turn usage', () => {
  const items: FeedItem[] = [
    timed(text('p1', 0, 'user'), 0),
    timed(tool('t1', 10), 2),
    timed(text('a1', 20), 5),
    timed(text('p2', 30, 'user'), 60),
    timed(text('a2', 40), 70),
  ];
  // m1 is streamed as two records (a tool call and later text); its usage counts once, at its max.
  const usage = [use('m1', 10, 2, { output: 40 }), use('m1', 20, 5), use('m2', 40, 98, { input: 5, output: 7, cacheRead: 0, cacheWrite: 0 })];

  it('sums the API calls of each turn under its last item, from the prompt to the last reply', () => {
    const stats = turnStats(items, usage, true);
    expect([...stats.keys()]).toEqual(['a1', 'a2']);
    expect(stats.get('a1')).toEqual({ input: 210, output: 100, cacheRead: 1000, cacheWrite: 200, calls: 1, durationMs: 5000 });
    expect(stats.get('a2')).toMatchObject({ input: 5, output: 7, calls: 1, durationMs: 38_000 });
  });

  it('leaves the last turn open while the session works on it, and skips turns without a loaded prompt', () => {
    expect([...turnStats(items, usage, false).keys()]).toEqual(['a1']);
    expect([...turnStats(items.slice(1), usage, true).keys()]).toEqual(['a2']);
    expect(turnStats(items, [], true).size).toBe(0);
  });

  it('reports no duration when a timestamp is missing', () => {
    const untimed = [text('p', 0, 'user'), text('a', 10)];
    expect(turnStats(untimed, [{ ...use('m', 10, 0), at: null }], true).get('a')?.durationMs).toBeNull();
  });

  it('puts the chip after the last item of the turn', () => {
    const blocks = groupFeed(items, turnStats(items, usage, true));
    expect(blocks.map((b) => (b.type === 'turn' ? `#${b.id}` : b.type))).toEqual(['item', 'tools', 'item', '#turn:a1', 'item', 'item', '#turn:a2']);
  });

  it('totals the loaded range once per call', () => {
    expect(usageTotals(usage)).toEqual({ input: 215, output: 107, cacheRead: 1000, cacheWrite: 200, calls: 2 });
  });

  it('formats tokens and time compactly', () => {
    expect([830, 1100, 12_400, 99_960, 245_300, 999_700, 1_250_000].map(compactTokens)).toEqual(['830', '1.1k', '12.4k', '100k', '245k', '1M', '1.3M']);
    expect([38_000, 252_000, 3_780_000].map(turnDuration)).toEqual(['38 s', '4 m 12 s', '1 h 3 m']);
    expect(turnLabel({ input: 12_400, output: 1100, cacheRead: 0, cacheWrite: 0, calls: 3, durationMs: 38_000 })).toBe('12.4k in · 1.1k out · 38 s');
    expect(turnLabel({ input: 12, output: 3, cacheRead: 0, cacheWrite: 0, calls: 1, durationMs: null })).toBe('12 in · 3 out');
  });

  it('keeps usage with merged chunks and drops it with trimmed items', () => {
    let state = mergeChunk(emptyFeed('s'), chunk(100, 200, [text('b', 100)], { usage: [use('m2', 150, 0)], ended: false }), 'tail');
    state = mergeChunk(state, chunk(200, 300, [text('c', 250)], { usage: [use('m3', 250, 0)], ended: true }), 'append');
    expect(state.ended).toBe(true);
    state = mergeChunk(state, chunk(300, 310, [], { results: [{ toolUseId: 'x', text: '', isError: false }] }), 'append');
    expect(state.ended).toBe(true);
    state = mergeChunk(state, chunk(0, 100, [text('a', 0)], { usage: [use('m1', 50, 0)] }), 'prepend');
    expect(state.usage.map((u) => u.messageId)).toEqual(['m1', 'm2', 'm3']);
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => text(`i${i}`, i * 10));
    const trimmed = mergeChunk(emptyFeed('s'), chunk(0, 99_999, many, { usage: [use('old', 0, 0), use('new', 20, 0)] }), 'tail');
    expect(trimmed.usage.map((u) => u.messageId)).toEqual(['new']);
  });
});

describe('agentActivity', () => {
  it('ends with the transcript, else follows the parent process', () => {
    expect(agentActivity(true, 'busy')).toBe('idle');
    expect(agentActivity(false, 'idle')).toBe('busy');
    expect(agentActivity(null, 'gone')).toBe('gone');
    expect(agentActivity(null, 'unknown')).toBe('unknown');
  });
});
