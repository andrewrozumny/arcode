import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedItem } from '@shared/claude';
import { discussionMessage, loadDiscussionModel, saveDiscussionModel, SentenceStream, sessionUpdate, splitHandover } from './discussion';

const base = (id: string) => ({ id, at: null, offset: 0 });

describe('SentenceStream', () => {
  it('returns sentences as they complete across pieces', () => {
    const s = new SentenceStream();
    expect(s.push('Привет. Как')).toEqual(['Привет.']);
    expect(s.push(' дела? Хорошо')).toEqual(['Как дела?']);
    expect(s.flush()).toEqual(['Хорошо']);
  });

  it('never returns code, even when a fence arrives in pieces', () => {
    const s = new SentenceStream();
    expect(s.push('Вот пример: ``')).toEqual([]);
    expect(s.push('`ts\nconst a = 1. b();\n`')).toEqual(['Вот пример:']);
    expect(s.push('``\nГотово. ')).toEqual(['Готово.']);
    expect(s.flush()).toEqual([]);
  });

  it('drops an unfinished code block at the end', () => {
    const s = new SentenceStream();
    s.push('Смотри ```js\nlet x;');
    expect(s.flush()).toEqual([]);
  });

  it('ends a sentence at a blank line', () => {
    const s = new SentenceStream();
    expect(s.push('Первый абзац без точки\n\nВторой')).toEqual(['Первый абзац без точки']);
  });
});

describe('sessionUpdate', () => {
  it('describes prompts, messages and tool calls of the session', () => {
    const items: FeedItem[] = [
      { ...base('u'), kind: 'user', text: 'Сделай кнопку', images: 0 },
      { ...base('a'), kind: 'assistant', text: 'Делаю кнопку Stop.' },
      { ...base('t'), kind: 'tool', name: 'Edit', summary: 'VoiceChatButton.tsx', input: '', detail: null },
      { ...base('n'), kind: 'notice', text: 'compacted' },
    ];
    expect(sessionUpdate(items)).toBe(
      'User to Claude Code: Сделай кнопку\nClaude Code: Делаю кнопку Stop.\nClaude Code used Edit: VoiceChatButton.tsx',
    );
  });

  it('keeps the newest lines within the budget', () => {
    const items: FeedItem[] = Array.from({ length: 40 }, (_, i) => ({ ...base(String(i)), kind: 'assistant' as const, text: `${i} ${'x'.repeat(500)}` }));
    const update = sessionUpdate(items);
    expect(update.length).toBeLessThanOrEqual(8000);
    expect(update.endsWith(`39 ${'x'.repeat(500)}`)).toBe(true);
    expect(update.startsWith('Claude Code: 0 ')).toBe(false);
  });
});

describe('discussionMessage', () => {
  it('puts the session update before what the user said', () => {
    expect(discussionMessage('', 'привет')).toBe('привет');
    expect(discussionMessage('Claude Code: done', 'что дальше?')).toBe(
      '<claude_code_session_update>\nClaude Code: done\n</claude_code_session_update>\n\nчто дальше?',
    );
  });
});

describe('handover', () => {
  it('never reads the handed-over task aloud, even when the tag arrives in pieces', () => {
    const s = new SentenceStream();
    expect(s.push('Передаю в Claude Code. <hand')).toEqual(['Передаю в Claude Code.']);
    expect(s.push('over>Сделай кнопку. Потом тесты.</hand')).toEqual([]);
    expect(s.push('over> Готово.')).toEqual([]);
    expect(s.flush()).toEqual(['Готово.']);
  });

  it('splits an answer into what is said and the task', () => {
    expect(splitHandover('Передаю.\n<handover>\n## Задача\nСделай X\n</handover>')).toEqual({ said: 'Передаю.', task: '## Задача\nСделай X' });
    expect(splitHandover('Просто ответ.')).toEqual({ said: 'Просто ответ.', task: null });
    // An answer cut off inside the tags still hands over what arrived.
    expect(splitHandover('Передаю. <handover>Сделай X')).toEqual({ said: 'Передаю.', task: 'Сделай X' });
  });
});

describe('discussion model storage', () => {
  afterEach(() => vi.unstubAllGlobals());
  const storage = (initial: Record<string, string>) => {
    const data = { ...initial };
    vi.stubGlobal('localStorage', { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => (data[k] = v) });
    return data;
  };

  it('remembers Sonnet or Opus and ignores anything else', () => {
    const data = storage({});
    expect(loadDiscussionModel()).toBe('sonnet');
    saveDiscussionModel('opus');
    expect(loadDiscussionModel()).toBe('opus');
    data['arcode.voiceChat.discussionModel'] = 'haiku';
    expect(loadDiscussionModel()).toBe('sonnet');
  });

  it('uses Sonnet without storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadDiscussionModel()).toBe('sonnet');
  });
});
