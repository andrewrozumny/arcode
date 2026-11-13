import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscussionEvent } from '@shared/voice';
import { Discussion, discussionArgs, discussionEvents, locateClaude } from './discussion';

describe('discussionEvents', () => {
  const line = (value: unknown) => JSON.stringify(value);

  it('reads text deltas, new messages and the end of an answer', () => {
    expect(discussionEvents(line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'При' } } }))).toEqual([
      { type: 'delta', text: 'При' },
    ]);
    expect(discussionEvents(line({ type: 'stream_event', event: { type: 'message_start' } }))).toEqual([{ type: 'message' }]);
    expect(discussionEvents(line({ type: 'result', subtype: 'success' }))).toEqual([{ type: 'done' }]);
  });

  it('reports failures and ignores everything else', () => {
    expect(discussionEvents(line({ type: 'result', subtype: 'error_during_execution' }))).toEqual([
      { type: 'error', message: 'The discussion failed: error_during_execution' },
    ]);
    expect(discussionEvents(line({ type: 'system', subtype: 'init' }))).toEqual([]);
    expect(discussionEvents('not json')).toEqual([]);
  });
});

describe('discussion setup', () => {
  it('runs read-only, without MCP servers or a saved session', () => {
    const args = discussionArgs('sonnet');
    expect(args).toEqual(expect.arrayContaining(['-p', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence']));
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
  });

  it('passes the chosen model', () => {
    const args = discussionArgs('opus');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
  });

  it('finds claude in the usual folders', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'arcode-claude-home-'));
    (await import('node:fs')).mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const path = join(home, '.local', 'bin', 'claude');
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
    expect(await locateClaude({ PATH: '' }, home)).toBe(path);
    expect(await locateClaude({ PATH: '' }, '/nonexistent')).toBe(null);
  });
});

describe('Discussion', () => {
  it('sends messages to one long-lived process and streams the answers back', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'arcode-discuss-'));
    const fake = join(dir, 'claude');
    // A stand-in for `claude -p` with stream-json: answers each message with two deltas and a result.
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const readline = require('node:readline');
let n = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const text = JSON.parse(line).message.content;
  n += 1;
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
  out({ type: 'stream_event', event: { type: 'message_start' } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer ' + n + ': ' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text } } });
  out({ type: 'result', subtype: 'success' });
});
`,
    );
    chmodSync(fake, 0o755);
    const events: DiscussionEvent[] = [];
    const done = (count: number) =>
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (events.filter((e) => e.type === 'done').length >= count) {
            clearInterval(check);
            resolve();
          }
        }, 20);
      });
    const discussion = new Discussion(dir, (e) => events.push(e), { ARCODE_CLAUDE: fake, PATH: process.env.PATH });
    await discussion.send('first', 'sonnet');
    await done(1);
    await discussion.send('second', 'sonnet');
    await done(2);
    // Another model starts a new process: the counter starts over.
    await discussion.send('third', 'opus');
    await done(3);
    discussion.reset();
    const text = events.filter((e): e is Extract<DiscussionEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text).join('');
    // The same process answered the first two: the counter went on.
    expect(text).toBe('answer 1: firstanswer 2: secondanswer 1: third');
  });
});
