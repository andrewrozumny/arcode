import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscussionLogRecord } from '@shared/voice';
import { DiscussionHistory, excludeFromGit, formatRecord, historyFileName, historyHeader, logRecord } from './history';

const tmp = (): string => mkdtempSync(join(os.tmpdir(), 'arcode-history-'));
const START = '2026-11-13T12:05:00.000Z';
const record = (over: Partial<DiscussionLogRecord> = {}): DiscussionLogRecord => ({
  conversation: START,
  kind: 'you',
  at: Date.parse(START),
  model: 'sonnet',
  text: 'Привет',
  ...over,
});

describe('history file', () => {
  it('is named by the start of the conversation, in local time', () => {
    expect(historyFileName(new Date(2026, 10, 13, 14, 5))).toBe('2026-11-13_14-05.md');
  });

  it('starts with the date, the project and the model', () => {
    const header = historyHeader(new Date(2026, 10, 13, 14, 5), '/work/orbit-api', 'opus');
    expect(header).toBe('# Discussion 2026-11-13 14:05\n\n- Project: orbit-api (/work/orbit-api)\n- Model: Opus\n\n');
  });
});

describe('formatRecord', () => {
  const at = new Date(2026, 10, 13, 14, 5, 9).getTime();

  it('labels what the user and the partner said, with the time', () => {
    expect(formatRecord(record({ at, text: 'Что дальше?' }))).toBe('**Ты** · 14:05:09\n\nЧто дальше?\n\n');
    expect(formatRecord(record({ at, kind: 'partner', text: 'Прогони гейты.' }))).toBe('**Собеседник** · 14:05:09\n\nПрогони гейты.\n\n');
  });

  it('keeps a handed-over task as its own block with its status', () => {
    const text = formatRecord(record({ at, kind: 'partner', text: 'Передаю.', task: '## Задача\n\n- пункт', taskStatus: 'Sent to Claude Code' }));
    expect(text).toBe('**Собеседник** · 14:05:09\n\nПередаю.\n\nTask for Claude Code (Sent to Claude Code):\n\n> ## Задача\n>\n> - пункт\n\n');
  });

  it('records errors, notes and later task statuses', () => {
    expect(formatRecord(record({ at, kind: 'error', text: 'The discussion stopped' }))).toBe('**Error** · 14:05:09\n\n> The discussion stopped\n\n');
    expect(formatRecord(record({ at, kind: 'note', text: 'Switched to Opus' }))).toBe('_14:05:09 · Switched to Opus_\n\n');
    expect(formatRecord(record({ at, kind: 'task', text: '## Задача', taskStatus: 'Sent to Claude Code' }))).toBe('_14:05:09 · task: Sent to Claude Code_\n\n');
  });
});

describe('logRecord', () => {
  it('accepts a well-formed record and caps the model to the known ones', () => {
    expect(logRecord({ conversation: START, kind: 'you', at: 1, model: 'haiku', text: 'x' })).toEqual(record({ at: 1, text: 'x' }));
  });

  it('refuses malformed records', () => {
    expect(() => logRecord({ conversation: '../../etc', kind: 'you', text: 'x' })).toThrow();
    expect(() => logRecord({ conversation: START, kind: 'other', text: 'x' })).toThrow();
    expect(() => logRecord(null)).toThrow();
  });
});

describe('excludeFromGit', () => {
  it('adds .arcode/ to .git/info/exclude once', async () => {
    const root = tmp();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    writeFileSync(join(root, '.git', 'info', 'exclude'), '# existing\n*.log');
    await excludeFromGit(root);
    await excludeFromGit(root);
    const text = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(text.startsWith('# existing\n*.log\n')).toBe(true);
    expect(text.match(/^\.arcode\/$/gm)).toHaveLength(1);
  });

  it('follows a worktree .git file to the main repository', async () => {
    const main = tmp();
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const root = tmp();
    writeFileSync(join(root, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);
    await excludeFromGit(root);
    expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('.arcode/');
  });

  it('does nothing outside a repository', async () => {
    const root = tmp();
    await excludeFromGit(root);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('DiscussionHistory', () => {
  it('writes one file per conversation and appends records in order', async () => {
    const root = tmp();
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    const history = new DiscussionHistory(root);
    await Promise.all([
      history.append(record({ text: 'первый' })),
      history.append(record({ kind: 'partner', text: 'ответ' })),
      history.append(record({ text: 'второй' })),
    ]);
    const second = '2026-11-13T12:30:00.000Z';
    await history.append(record({ conversation: second, text: 'новый разговор' }));
    const files = readdirSync(join(root, '.arcode', 'discussions')).sort();
    expect(files).toHaveLength(2);
    const first = readFileSync(join(root, '.arcode', 'discussions', files[0] ?? ''), 'utf8');
    expect(first.indexOf('первый')).toBeLessThan(first.indexOf('ответ'));
    expect(first.indexOf('ответ')).toBeLessThan(first.indexOf('второй'));
    expect(first).not.toContain('новый разговор');
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.arcode/');
  });

  it('never writes outside the project, even through a symlinked .arcode', async () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, '.arcode'));
    await expect(new DiscussionHistory(root).append(record())).rejects.toThrow(/escapes the project root/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('does not overwrite a file of another conversation that started the same minute', async () => {
    const root = tmp();
    await new DiscussionHistory(root).append(record({ text: 'one' }));
    await new DiscussionHistory(root).append(record({ conversation: '2026-11-13T12:05:30.000Z', text: 'two' }));
    expect(readdirSync(join(root, '.arcode', 'discussions')).sort()).toHaveLength(2);
  });
});
