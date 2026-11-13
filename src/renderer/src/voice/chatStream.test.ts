import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@shared/claude';
import { appendEntries, chatEntries, splitFirstRead } from './chatStream';

const base = (id: string) => ({ id, at: null, offset: 0 });

describe('chatEntries', () => {
  it('turns prompts, text and tool calls into chat lines', () => {
    const items: FeedItem[] = [
      { ...base('u'), kind: 'user', text: ' Запусти тесты ', images: 0 },
      { ...base('a'), kind: 'assistant', text: 'Запускаю.' },
      { ...base('t'), kind: 'tool', name: 'Bash', summary: 'pnpm test', input: '', detail: null },
      { ...base('n'), kind: 'notice', text: 'compacted' },
      { ...base('c'), kind: 'command', text: '/model opus' },
    ];
    expect(chatEntries(items).map(({ id, role, text }) => ({ id, role, text }))).toEqual([
      { id: 'u', role: 'you', text: 'Запусти тесты' },
      { id: 'a', role: 'claude', text: 'Запускаю.' },
      { id: 't', role: 'action', text: 'pnpm test' },
      { id: 'c', role: 'you', text: '/model opus' },
    ]);
  });
});

describe('appendEntries', () => {
  it('skips lines already shown and keeps the newest', () => {
    const a = { id: 'a', role: 'claude' as const, text: 'a' };
    const b = { id: 'b', role: 'claude' as const, text: 'b' };
    expect(appendEntries([a], [a, b])).toEqual([a, b]);
    const many = Array.from({ length: 70 }, (_, i) => ({ id: String(i), role: 'action' as const, text: '' }));
    const kept = appendEntries([], many);
    expect(kept).toHaveLength(60);
    expect(kept[0]?.id).toBe('10');
  });
});

describe('splitFirstRead', () => {
  const line = (id: string, at: string | null) => ({ id, role: 'claude' as const, text: id, at });
  const since = Date.parse('2026-11-13T10:00:00Z');

  it('treats lines written since the chat was turned on as new', () => {
    const entries = [line('old1', '2026-11-13T09:00:00Z'), line('old2', '2026-11-13T09:59:00Z'), line('new', '2026-11-13T10:00:05Z')];
    expect(splitFirstRead(entries, since)).toEqual({ context: [entries[0], entries[1]], fresh: [entries[2]] });
  });

  it('keeps only the last lines of an older conversation as context', () => {
    const entries = Array.from({ length: 6 }, (_, i) => line(String(i), '2026-11-13T09:00:00Z'));
    const { context, fresh } = splitFirstRead(entries, since);
    expect(context.map((e) => e.id)).toEqual(['2', '3', '4', '5']);
    expect(fresh).toEqual([]);
  });
});
