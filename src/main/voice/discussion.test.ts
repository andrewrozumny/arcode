import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscussionEvent } from '@shared/voice';
import { controlLine, Discussion, discussionArgs, discussionEvents, locateClaude, MAX_DISCUSSION_TEXT, partnerMessage, replayBlock } from './discussion';

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

  it('gives the partner ARcode\'s lookup server, its tools allowed, the token left to the environment', () => {
    const args = discussionArgs('sonnet', { url: 'http://127.0.0.1:4000/mcp', token: 'secret' });
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}');
    expect(config.mcpServers.arcode).toEqual({ type: 'http', url: 'http://127.0.0.1:4000/mcp', headers: { Authorization: 'Bearer ${ARCODE_MCP_TOKEN}' }, alwaysLoad: true });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__arcode');
    expect(args).toContain('--strict-mcp-config');
    expect(args.join(' ')).not.toContain('secret');
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

describe('controlLine', () => {
  const line = (value: unknown) => JSON.stringify(value);

  it('reads model switch answers, compactions and the lookup server status', () => {
    expect(controlLine(line({ type: 'control_response', response: { subtype: 'success', request_id: 'm1' } }))).toEqual({ type: 'model', requestId: 'm1', ok: true });
    expect(controlLine(line({ type: 'control_response', response: { subtype: 'error', request_id: 'm2' } }))).toEqual({ type: 'model', requestId: 'm2', ok: false });
    expect(controlLine(line({ type: 'system', subtype: 'compact_boundary' }))).toEqual({ type: 'compacted' });
    expect(controlLine(line({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'arcode', status: 'failed' }] }))).toEqual({ type: 'lookup', ok: false });
    expect(controlLine(line({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'arcode', status: 'connected' }] }))).toEqual({ type: 'lookup', ok: true });
    expect(controlLine(line({ type: 'system', subtype: 'init', mcp_servers: [] }))).toBe(null);
    expect(controlLine('nope')).toBe(null);
  });
});

describe('replayBlock', () => {
  it('replays the newest exchanges within the budget, oldest first', () => {
    const exchanges = Array.from({ length: 30 }, (_, i) => ({ user: `q${i}`, partner: `a${i}` }));
    const block = replayBlock(exchanges);
    expect(block.startsWith('<earlier_discussion>\nUser: q18\nYou: a18')).toBe(true);
    expect(block.endsWith('User: q29\nYou: a29\n</earlier_discussion>')).toBe(true);
    expect(replayBlock([])).toBe('');
  });

  it('clips long answers', () => {
    expect(replayBlock([{ user: 'q', partner: 'x'.repeat(5000) }]).length).toBeLessThan(1600);
  });

  it('puts the brief and the replay before the user\'s own text', () => {
    expect(partnerMessage('<brief>', '', 'hi')).toBe('<brief>\n\nhi');
    expect(partnerMessage('', '<replay>', 'hi')).toBe('<replay>\n\nhi');
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
  const message = JSON.parse(line);
  const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
  if (message.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: process.env.FAKE_SET_MODEL || 'success', request_id: message.request_id } });
    return;
  }
  const text = message.message.content;
  n += 1;
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
    const briefs: boolean[] = [];
    const brief = async (fresh: boolean) => {
      briefs.push(fresh);
      return fresh ? '<full>' : '<delta>';
    };
    const run = async (setModel: string) => {
      events.length = 0;
      briefs.length = 0;
      const discussion = new Discussion(dir, (e) => events.push(e), { env: { ARCODE_CLAUDE: fake, PATH: process.env.PATH, FAKE_SET_MODEL: setModel } });
      await discussion.send('first', 'sonnet', brief);
      await done(1);
      await discussion.send('second', 'sonnet', brief);
      await done(2);
      await discussion.send('third', 'opus', brief);
      await done(3);
      discussion.reset();
      return events.filter((e): e is Extract<DiscussionEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text).join('');
    };
    // One process answers all three: the model is switched in place and the counter goes on.
    expect(await run('success')).toBe('answer 1: <full>\n\nfirstanswer 2: <delta>\n\nsecondanswer 3: <delta>\n\nthird');
    expect(briefs).toEqual([true, false, false]);
    // When the switch fails the process starts again and gets the full brief and the conversation so far.
    const restarted = await run('error');
    expect(briefs).toEqual([true, false, true]);
    expect(restarted).toContain('answer 1: <full>\n\n<earlier_discussion>\nUser: first\nYou: answer 1: <full>');
    expect(restarted.endsWith('</earlier_discussion>\n\nthird')).toBe(true);
  });

  it('refuses a message longer than the cap instead of cutting it', async () => {
    const discussion = new Discussion('/tmp', () => undefined, { env: { ARCODE_CLAUDE: '/nonexistent' } });
    await expect(discussion.send('x'.repeat(MAX_DISCUSSION_TEXT + 1), 'sonnet', async () => '')).rejects.toThrow(/Too long/);
  });
});
