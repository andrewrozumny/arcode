import { afterEach, describe, expect, it, vi } from 'vitest';
import { handoverCheck, loadDiscussionModel, saveDiscussionModel, SentenceStream, splitHandover } from './discussion';

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

describe('handoverCheck', () => {
  const target = (status: string | undefined, draft = '') => ({ ptyId: 1, status, draft });

  it('sends to an idle Claude Code with an empty prompt', () => {
    expect(handoverCheck(target('idle'))).toEqual({ send: true, queued: false });
    expect(handoverCheck(target('idle', '   '))).toEqual({ send: true, queued: false });
  });

  it('puts the task in the queue of a busy Claude Code', () => {
    expect(handoverCheck(target('busy'))).toEqual({ send: true, queued: true });
  });

  it('holds the task back, with the reason, when it would not land as a new message', () => {
    expect(handoverCheck(null)).toEqual({ send: false, reason: 'Not sent: open a Claude tab first' });
    expect(handoverCheck(target('shell'))).toEqual({ send: false, reason: 'Not sent: a shell command is running in that tab' });
    expect(handoverCheck(target('waiting'))).toEqual({ send: false, reason: 'Not sent: Claude Code is waiting for an answer' });
    expect(handoverCheck(target(undefined))).toEqual({ send: false, reason: 'Not sent: Claude Code is not running in that tab' });
    expect(handoverCheck(target('idle', 'мой черновик'))).toEqual({ send: false, reason: "Not sent: there is unsent text in Claude Code's prompt" });
  });
});
