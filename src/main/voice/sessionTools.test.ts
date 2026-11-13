import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { handleSessionMcp, SessionMcpServer } from './sessionMcp';
import { callSessionTool, NO_SESSION, PAGE_CHARS, type SessionSource } from './sessionTools';

const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const LOG = Array.from({ length: 3000 }, (_, i) => `line ${i}: ok`).join('\n') + '\nFATAL: database timeout';

function transcriptHome(): string {
  const home = mkdtempSync(join(os.tmpdir(), 'arcode-tools-'));
  const dir = join(home, '.claude', 'projects', '-repo');
  mkdirSync(dir, { recursive: true });
  let n = 0;
  const rec = (value: Record<string, unknown>) => JSON.stringify({ uuid: `u${++n}`, timestamp: '2026-11-13T10:00:00.000Z', cwd: '/repo', ...value });
  const lines = [
    rec({ type: 'user', message: { role: 'user', content: 'Сделай логин' } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Сделал логин.' }] } }),
    rec({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary: login built earlier' } }),
    rec({ type: 'user', message: { role: 'user', content: 'Запусти тесты' } }),
    rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }] } }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: LOG, is_error: true }] } }),
    rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Тесты упали на таймауте базы.' }] } }),
  ];
  writeFileSync(join(dir, `${SESSION}.jsonl`), `${lines.join('\n')}\n`);
  return home;
}

const home = transcriptHome();
const source = (sessionId: string | null = SESSION): SessionSource => ({ home, sessionId: () => sessionId, brief: async () => '<brief>' });

describe('lookup tools', () => {
  it('returns the whole output of a tool call in pages that cover it without gaps', async () => {
    const first = await callSessionTool('tool_output', { id: 'toolu_1' }, source());
    expect(first).toContain('Call: Bash {"command":"npm test"}');
    expect(first).toContain('Result (error):');
    expect(first).toContain('line 0: ok');
    const next = /offset (\d+)\)/.exec(first)?.[1];
    expect(Number(next)).toBe(PAGE_CHARS);
    let all = '';
    for (let offset = 0; offset < LOG.length; offset += PAGE_CHARS) {
      const pageText = await callSessionTool('tool_output', { id: 'toolu_1', offset }, source());
      all += pageText.slice(pageText.indexOf('\n', pageText.indexOf('Result')) + 1).replace(/\n\n\[characters[\s\S]*$/, '');
    }
    expect(all).toBe(LOG);
    expect(await callSessionTool('tool_output', { id: 'toolu_1', tail: true }, source())).toContain('FATAL: database timeout');
    expect(await callSessionTool('tool_output', { id: 'toolu_x' }, source())).toContain('No tool call with id toolu_x');
    expect(await callSessionTool('tool_output', { id: '../../etc' }, source())).toContain('Give the id');
  });

  it('shows a turn counted back from the latest, with tool ids', async () => {
    const latest = await callSessionTool('session_turn', { turn: -1 }, source());
    expect(latest).toContain('User: Запусти тесты');
    expect(latest).toContain('[tool Bash id="toolu_1"]');
    expect(latest).toContain('[whole: tool_output("toolu_1")]');
    expect(latest).toContain('Тесты упали');
    const before = await callSessionTool('session_turn', { turn: -2 }, source());
    expect(before).toContain('User: Сделай логин');
    expect(before).not.toContain('Запусти тесты');
    expect(await callSessionTool('session_turn', { turn: -9 }, source())).toContain('Only 2 turns');
    expect(await callSessionTool('session_turn', { turn: 1 }, source())).toContain('Count turns back');
  });

  it('searches prompts, messages and outputs, newest first, with the turn of each hit', async () => {
    const hits = await callSessionTool('session_search', { query: 'database timeout' }, source());
    expect(hits).toContain('turn -1 · output · tool_output("toolu_1")');
    const login = await callSessionTool('session_search', { query: 'логин' }, source());
    expect(login.indexOf('turn -2 · message')).toBeLessThan(login.indexOf('turn -2 · prompt'));
    expect(await callSessionTool('session_search', { query: 'логин', scope: 'outputs' }, source())).toContain('No match');
    expect(await callSessionTool('session_search', { query: 'x' }, source())).toContain('at least two');
  });

  it('answers without a session, and lists no subagents', async () => {
    expect(await callSessionTool('session_turn', { turn: -1 }, source(null))).toBe(NO_SESSION);
    expect(await callSessionTool('session_brief', {}, source())).toBe('<brief>');
    expect(await callSessionTool('subagents', {}, source())).toContain('no subagents');
  });
});

describe('lookup server', () => {
  const server = new SessionMcpServer();
  afterAll(() => server.stop());

  it('speaks MCP: initialize, tools/list, tools/call; notifications get no answer', async () => {
    expect(await handleSessionMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, source())).toMatchObject({
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'arcode' } },
    });
    const list = (await handleSessionMcp({ id: 2, method: 'tools/list' }, source())) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['session_brief', 'session_turn', 'tool_output', 'session_search', 'subagents']);
    expect(await handleSessionMcp({ id: 3, method: 'tools/call', params: { name: 'session_brief' } }, source())).toMatchObject({
      result: { content: [{ type: 'text', text: '<brief>' }] },
    });
    expect(await handleSessionMcp({ id: 4, method: 'tools/call', params: { name: 'rm' } }, source())).toMatchObject({ error: { code: -32602 } });
    expect(await handleSessionMcp({ method: 'notifications/initialized' }, source())).toBeUndefined();
  });

  it('serves only requests with a registered token', async () => {
    const port = await server.start();
    const token = server.register(source());
    const post = (auth: string | null, body: string) =>
      fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body });
    expect((await post(null, '{"id":1,"method":"ping"}')).status).toBe(401);
    expect((await post('Bearer wrong', '{"id":1,"method":"ping"}')).status).toBe(401);
    const ok = await post(`Bearer ${token}`, '{"jsonrpc":"2.0","id":1,"method":"ping"}');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect((await post(`Bearer ${token}`, 'null')).status).toBe(400);
    expect((await post(`Bearer ${token}`, '{"method":"notifications/initialized"}')).status).toBe(202);
    server.unregister(token);
    expect((await post(`Bearer ${token}`, '{"id":1,"method":"ping"}')).status).toBe(401);
  });
});
