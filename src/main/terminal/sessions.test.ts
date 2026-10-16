import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClaudeSessionWatcher,
  findOwnerPty,
  parseSessionFile,
  readModelInfo,
} from './sessions';
import { findSessionTranscript } from '../claude/transcripts';

/** Model of a session's transcript, found by id the way the watcher finds it. */
async function readSessionModelInfo(sessionId: string, home: string) {
  const file = await findSessionTranscript(sessionId, home);
  return file ? readModelInfo(file) : null;
}
import { expandPath } from './linkPaths';

describe('parseSessionFile', () => {
  it('reads a live-process record', () => {
    const text = JSON.stringify({
      pid: 39417,
      sessionId: 'abc',
      cwd: '/work/app',
      name: 'orbit-api',
      status: 'waiting',
      waitingFor: 'permission',
    });
    expect(parseSessionFile(text)).toEqual({
      pid: 39417,
      sessionId: 'abc',
      cwd: '/work/app',
      name: 'orbit-api',
      status: 'waiting',
      waitingFor: 'permission',
      model: null,
      modelName: null,
    });
  });

  it('falls back to idle for unknown statuses and nulls for missing fields', () => {
    expect(parseSessionFile('{"pid":5,"status":"weird"}')).toEqual({
      pid: 5,
      sessionId: null,
      cwd: null,
      name: null,
      status: 'idle',
      waitingFor: null,
      model: null,
      modelName: null,
    });
  });

  it('rejects malformed input', () => {
    expect(parseSessionFile('not json')).toBeNull();
    expect(parseSessionFile('{"status":"busy"}')).toBeNull();
    expect(parseSessionFile('[]')).toBeNull();
    expect(parseSessionFile('{"pid":-1}')).toBeNull();
  });
});

describe('findOwnerPty', () => {
  const parents = new Map([
    [300, 200],
    [200, 100],
    [100, 1],
  ]);
  const parentOf = (pid: number): Promise<number | null> => Promise.resolve(parents.get(pid) ?? null);

  it('walks up to the shell that owns the process', async () => {
    expect(await findOwnerPty(300, new Map([[100, 7]]), parentOf)).toBe(7);
  });

  it('returns the pty when the pid is the shell itself', async () => {
    expect(await findOwnerPty(100, new Map([[100, 7]]), parentOf)).toBe(7);
  });

  it('returns null for unrelated processes', async () => {
    expect(await findOwnerPty(300, new Map([[999, 1]]), parentOf)).toBeNull();
  });
});

describe('findSessionTranscript', () => {
  it('finds a transcript in any project folder', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-home-'));
    const id = '123e4567-e89b-12d3-a456-426614174000';
    mkdirSync(join(home, '.claude', 'projects', '-work-app'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-work-app', `${id}.jsonl`), '{}\n');
    expect(await findSessionTranscript(id, home)).toBe(join(home, '.claude', 'projects', '-work-app', `${id}.jsonl`));
    expect(await findSessionTranscript('123e4567-e89b-12d3-a456-426614174999', home)).toBeNull();
    expect(await findSessionTranscript('../etc/passwd', home)).toBeNull();
  });
});

describe('readSessionModelInfo', () => {
  const id = '223e4567-e89b-12d3-a456-426614174000';
  const assistant = (model: string): string => JSON.stringify({ type: 'assistant', message: { model } });

  function transcriptHome(lines: string[]): string {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-model-'));
    mkdirSync(join(home, '.claude', 'projects', '-work-app'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', '-work-app', `${id}.jsonl`), lines.join('\n') + '\n');
    return home;
  }

  it('returns the model of the latest assistant turn', async () => {
    const home = transcriptHome([
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistant('claude-haiku-5-5'),
      assistant('claude-opus-5-5'),
    ]);
    expect((await readSessionModelInfo(id, home))?.model ?? null).toBe('claude-opus-5-5');
  });

  it('skips synthetic messages', async () => {
    const home = transcriptHome([assistant('claude-haiku-5-5'), assistant('<synthetic>')]);
    expect((await readSessionModelInfo(id, home))?.model ?? null).toBe('claude-haiku-5-5');
  });

  it('prefers a later /model switch record over an older assistant turn', async () => {
    const home = transcriptHome([
      assistant('claude-haiku-5-5'),
      JSON.stringify({
        type: 'user',
        attachment: { type: 'model', identity: { modelId: 'claude-fable-5-1', marketingName: 'Fable 5.1' } },
      }),
    ]);
    expect(await readSessionModelInfo(id, home)).toMatchObject({ model: 'claude-fable-5-1', modelName: 'Fable 5.1' });
    expect((await readSessionModelInfo(id, home))?.model ?? null).toBe('claude-fable-5-1');
  });

  it('returns null when the transcript has no model', async () => {
    const home = transcriptHome([JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
    expect((await readSessionModelInfo(id, home))?.model ?? null).toBeNull();
    expect((await readSessionModelInfo('323e4567-e89b-12d3-a456-426614174000', home))?.model ?? null).toBeNull();
  });
});

describe('expandPath', () => {
  it('resolves relative, home and absolute paths', () => {
    expect(expandPath('src/a.ts', '/work/app', '/Users/me')).toBe('/work/app/src/a.ts');
    expect(expandPath('~/notes/a.md', '/work/app', '/Users/me')).toBe('/Users/me/notes/a.md');
    expect(expandPath('/etc/hosts', '/work/app', '/Users/me')).toBe('/etc/hosts');
    expect(expandPath('../x.ts', '/work/app', '/Users/me')).toBe('/work/x.ts');
  });
});

describe('ClaudeSessionWatcher', () => {
  it('walks the process tree of a foreign session once, not on every status change', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'acode-reg-'));
    const file = join(dir, `${process.pid}.json`);
    const write = (status: string): void =>
      writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: null, status }));
    const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
    let walks = 0;
    const statuses: string[] = [];
    write('idle');
    const watcher = new ClaudeSessionWatcher({
      dir,
      shells: () => new Map(),
      onChange: (event) => statuses.push(event.status),
      parentOf: () => {
        walks++;
        return Promise.resolve(null);
      },
    });
    watcher.start();
    try {
      await wait(300);
      write('busy');
      await wait(400);
      write('idle');
      await wait(400);
      expect(statuses).toEqual(['idle', 'busy', 'idle']);
      expect(walks).toBe(1);
    } finally {
      watcher.stop();
    }
  });
});
