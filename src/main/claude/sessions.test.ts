import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSessions, parseTranscript } from './sessions';

const ID_OLD = '11111111-aaaa-4aaa-8aaa-111111111111';
const ID_NEW = '22222222-bbbb-4bbb-8bbb-222222222222';
const ID_EMPTY = '33333333-cccc-4ccc-8ccc-333333333333';

const user = (text: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', timestamp: '2026-10-08T10:00:00.000Z', message: { content: text }, ...extra });
const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T10:00:05.000Z', message: { content: [{ type: 'text', text }] } });

describe('parseTranscript', () => {
  it('takes the first typed prompt, the first timestamp and counts user and assistant entries', () => {
    const text = [user('Fix the login bug'), assistant('Sure'), user('thanks')].join('\n') + '\n';
    expect(parseTranscript(text)).toEqual({
      firstPrompt: 'Fix the login bug',
      startedAt: '2026-10-08T10:00:00.000Z',
      messages: 3,
    });
  });

  it('skips slash-command wrappers, meta entries and tool results', () => {
    const text = [
      user('<command-name>/clear</command-name>'),
      user('caveat: ignore', { isMeta: true }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      user('Real question'),
    ].join('\n');
    expect(parseTranscript(text).firstPrompt).toBe('Real question');
  });

  it('collapses whitespace and cuts long prompts', () => {
    const long = 'word '.repeat(100);
    const prompt = parseTranscript(user(`  line one\n\n  line two ${long}`)).firstPrompt ?? '';
    expect(prompt.startsWith('line one line two word')).toBe(true);
    expect(prompt.length).toBe(160);
    expect(prompt.endsWith('…')).toBe(true);
  });

  it('ignores malformed lines and reports nulls for an empty transcript', () => {
    expect(parseTranscript('not json\n\n')).toEqual({ firstPrompt: null, startedAt: null, messages: 0 });
  });
});

describe('listSessions', () => {
  function projectHome(files: { id: string; text: string; mtime: number }[]): { home: string; root: string } {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-sessions-'));
    const root = '/work/app';
    const dir = join(home, '.claude', 'projects', '-work-app');
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const file = join(dir, `${f.id}.jsonl`);
      writeFileSync(file, f.text);
      // utimesSync takes seconds; the fixtures are written in milliseconds.
      utimesSync(file, f.mtime / 1000, f.mtime / 1000);
    }
    return { home, root };
  }

  it('lists sessions newest first and skips ones without a typed prompt', async () => {
    const { home, root } = projectHome([
      { id: ID_OLD, text: user('Old task') + '\n', mtime: 1_000_000_000 },
      { id: ID_NEW, text: [user('New task'), assistant('done')].join('\n'), mtime: 2_000_000_000 },
      { id: ID_EMPTY, text: user('<command-name>/help</command-name>'), mtime: 3_000_000_000 },
    ]);
    const sessions = await listSessions(root, home);
    expect(sessions.map((s) => s.sessionId)).toEqual([ID_NEW, ID_OLD]);
    expect(sessions[0]).toMatchObject({ firstPrompt: 'New task', messages: 2 });
    expect(sessions[0]?.lastActiveAt).toBe(new Date(2_000_000_000).toISOString());
  });

  it('returns nothing when the project has no transcripts', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-sessions-none-'));
    expect(await listSessions('/nowhere/app', home)).toEqual([]);
  });

  it('ignores files whose name is not a session id', async () => {
    const { home, root } = projectHome([
      { id: ID_OLD, text: user('Kept') + '\n', mtime: 1_000_000_000 },
      { id: 'not-a-session', text: user('Dropped') + '\n', mtime: 2_000_000_000 },
    ]);
    expect((await listSessions(root, home)).map((s) => s.sessionId)).toEqual([ID_OLD]);
  });

  it('keeps newest-first order across read batches', async () => {
    const files = Array.from({ length: 21 }, (_, i) => ({
      id: `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-111111111111`,
      text: (i % 5 === 0 ? user('<command-name>/help</command-name>') : user(`Task ${i}`)) + '\n',
      mtime: 1_000_000_000 + i * 1000,
    }));
    const { home, root } = projectHome(files);
    const expected = files
      .filter((_, i) => i % 5 !== 0)
      .reverse()
      .map((f) => f.id);
    expect((await listSessions(root, home)).map((s) => s.sessionId)).toEqual(expected);
  });
});
