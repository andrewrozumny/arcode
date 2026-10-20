import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSubagents, stoppedAgents, transcriptFacts } from './subagents';

const SESSION = '44444444-dddd-4ddd-8ddd-444444444444';

const assistant = (model: string, stop: string | null, ts: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, stop_reason: stop, content: [] } });
const user = (ts: string): string => JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'go' } });

function home(agents: { id: string; lines: string[]; meta?: Record<string, unknown>; ageMs?: number }[]): string {
  const root = mkdtempSync(join(os.tmpdir(), 'acode-subagents-'));
  const dir = join(root, '.claude', 'projects', '-work-app', SESSION, 'subagents');
  mkdirSync(dir, { recursive: true });
  for (const agent of agents) {
    const file = join(dir, `agent-${agent.id}.jsonl`);
    writeFileSync(file, agent.lines.join('\n') + '\n');
    if (agent.meta) writeFileSync(join(dir, `agent-${agent.id}.meta.json`), JSON.stringify(agent.meta));
    if (agent.ageMs !== undefined) {
      const t = (Date.now() - agent.ageMs) / 1000;
      utimesSync(file, t, t);
    }
  }
  return root;
}

describe('transcriptFacts', () => {
  it('takes the first timestamp, the latest model and whether the last turn closed', () => {
    const head = [JSON.stringify({ type: 'fork-context-ref' }), user('2026-10-09T10:00:00.000Z')].join('\n');
    const tail = [assistant('claude-haiku-5-5', 'tool_use', '2026-10-09T10:00:01.000Z'), assistant('claude-opus-5-5', 'end_turn', '2026-10-09T10:00:09.000Z')].join('\n');
    expect(transcriptFacts(head, tail)).toEqual({
      model: 'claude-opus-5-5',
      modelName: null,
      startedAt: '2026-10-09T10:00:00.000Z',
      closed: true,
      lastAt: '2026-10-09T10:00:09.000Z',
    });
  });

  it('treats the hand-back tool result and an interrupt as a closed turn, ignoring trailing attachments', () => {
    const handBack = JSON.stringify({ type: 'user', timestamp: '2026-10-09T10:00:05.000Z', toolEndsTurn: true, message: { content: [{ type: 'tool_result' }] } });
    const reminder = JSON.stringify({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } });
    expect(transcriptFacts('', [assistant('claude-opus-5-5', 'tool_use', '2026-10-09T10:00:04.000Z'), handBack, reminder].join('\n'))).toMatchObject({
      closed: true,
      lastAt: '2026-10-09T10:00:05.000Z',
    });
    const interrupted = JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    expect(transcriptFacts('', interrupted).closed).toBe(true);
    const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    expect(transcriptFacts('', [assistant('claude-opus-5-5', 'tool_use', 't'), toolResult, reminder].join('\n')).closed).toBe(false);
  });

  it('prefers a /model switch record and reports an open turn', () => {
    const tail = [
      assistant('claude-haiku-5-5', 'end_turn', '2026-10-09T10:00:01.000Z'),
      JSON.stringify({ type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-fable-5-1', marketingName: 'Fable 5.1' } } }),
      assistant('claude-fable-5-1', null, '2026-10-09T10:00:02.000Z'),
    ].join('\n');
    expect(transcriptFacts('', tail)).toMatchObject({ model: 'claude-fable-5-1', modelName: 'Fable 5.1', closed: false });
  });
});

describe('listSubagents', () => {
  it('lists running agents first with label, type and model; quiet open transcripts count as finished', async () => {
    const root = home([
      {
        id: 'done1',
        lines: [user('2026-10-09T09:00:00.000Z'), assistant('claude-sonnet-5-5', 'end_turn', '2026-10-09T09:01:00.000Z')],
        meta: { agentType: 'general-purpose', description: 'Finished one', model: 'inherit' },
        ageMs: 60_000,
      },
      {
        id: 'live1',
        lines: [user('2026-10-09T09:05:00.000Z'), assistant('claude-opus-5-5', null, '2026-10-09T09:05:01.000Z')],
        meta: { agentType: 'fork', description: 'Still working', model: 'inherit', toolUseId: 'toolu_live' },
        ageMs: 5_000,
      },
      {
        id: 'stale1',
        lines: [user('2026-10-09T08:00:00.000Z'), assistant('claude-opus-5-5', null, '2026-10-09T08:00:01.000Z')],
        ageMs: 20 * 60_000,
      },
    ]);
    const list = await listSubagents(SESSION, root);
    expect(list.map((a) => [a.id, a.running])).toEqual([
      ['live1', true],
      ['done1', false],
      ['stale1', false],
    ]);
    expect(list[0]).toMatchObject({ label: 'Still working', agentType: 'fork', model: 'claude-opus-5-5', startedAt: '2026-10-09T09:05:00.000Z', toolUseId: 'toolu_live' });
    expect(list[2]).toMatchObject({ label: null, agentType: null, toolUseId: null });
  });

  it('marks agents the parent was notified about as stopped unless they ran again afterwards', async () => {
    const root = home([
      { id: 'killed1', lines: [user('2026-10-09T09:00:00.000Z'), assistant('claude-opus-5-5', 'tool_use', '2026-10-09T09:00:01.000Z')], ageMs: 5_000 },
      { id: 'resumed1', lines: [user('2026-10-09T09:00:00.000Z'), assistant('claude-opus-5-5', 'tool_use', '2026-10-09T09:30:00.000Z')], ageMs: 5_000 },
    ]);
    const note = (id: string, status: string, ts: string): string =>
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` });
    writeFileSync(
      join(root, '.claude', 'projects', '-work-app', `${SESSION}.jsonl`),
      [note('killed1', 'killed', '2026-10-09T09:00:02.000Z'), note('resumed1', 'completed', '2026-10-09T09:10:00.000Z')].join('\n') + '\n',
    );
    const list = await listSubagents(SESSION, root);
    expect(Object.fromEntries(list.map((a) => [a.id, a.running]))).toEqual({ killed1: false, resumed1: true });
  });

  it('returns nothing for unknown or malformed session ids', async () => {
    const root = home([]);
    expect(await listSubagents('55555555-eeee-4eee-8eee-555555555555', root)).toEqual([]);
    expect(await listSubagents('../x', root)).toEqual([]);
  });
});

describe('stoppedAgents', () => {
  it('keeps the latest stop time per agent and skips running statuses', () => {
    const line = (ts: string, body: string): string =>
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: body });
    const copy = JSON.stringify({
      type: 'queue-operation',
      operation: 'remove',
      timestamp: '2026-10-09T12:00:00.000Z',
      content: '<task-notification><task-id>a1</task-id><status>failed</status></task-notification>',
    });
    const tail = [
      copy,
      line('2026-10-09T10:00:00.000Z', '<task-notification><task-id>a1</task-id><status>completed</status></task-notification>'),
      line('2026-10-09T11:00:00.000Z', '<task-notification><task-id>a1</task-id><status>failed</status></task-notification>'),
      line('2026-10-09T11:00:00.000Z', '<task-notification><task-id>a2</task-id><status>running</status></task-notification>'),
    ].join('\n');
    expect([...stoppedAgents(tail)]).toEqual([['a1', '2026-10-09T11:00:00.000Z']]);
  });
});
