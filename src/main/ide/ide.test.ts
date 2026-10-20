import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { IdeHost, OpenDiffResult } from '@shared/ide';
import { createIdeBridge, ideEnv } from './index';
import { TOOLS } from './mcp';

let dir: string;
let bridge: ReturnType<typeof createIdeBridge>;
let diffResolve: ((r: OpenDiffResult) => void) | null;
const opened: string[] = [];
let connectedPid: number | undefined;

interface Rpc {
  result: {
    content: { type: string; text: string }[];
    tools: { name: string; inputSchema: { required: string[] } }[];
    protocolVersion: string;
    serverInfo: { name: string };
    capabilities: { tools: unknown };
  };
  error: { code: number };
  method: string;
  params: unknown;
}

function resolveDiff(r: OpenDiffResult): void {
  if (!diffResolve) throw new Error('no pending diff');
  diffResolve(r);
}

const host: IdeHost = {
  openDiff: () => new Promise((r) => (diffResolve = r)),
  closeTab: () => undefined,
  closeAllDiffTabs: () => undefined,
  openFile: (req) => {
    opened.push(req.filePath);
  },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'acode-ide-'));
  opened.length = 0;
  connectedPid = undefined;
  bridge = createIdeBridge(host, {
    lockDir: dir,
    onClientConnected: (pid) => (connectedPid = pid),
  });
  await bridge.start({ workspaceFolders: ['/work/proj'], ideName: 'ARcode', pid: 4242 });
});

afterEach(async () => {
  await bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

function connect(opts: { token?: string; protocols?: string[] } = {}): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${bridge.port}`, opts.protocols ?? ['mcp'], {
    headers: { 'x-claude-code-ide-authorization': opts.token ?? bridge.authToken },
  });
}

const open = (ws: WebSocket) => new Promise<void>((r) => ws.once('open', () => r()));
const next = (ws: WebSocket) => new Promise<Rpc>((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
async function rpc(ws: WebSocket, id: number, method: string, params?: object) {
  const p = next(ws);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return p;
}

describe('IDE bridge', () => {
  it('closes with 1008 on a wrong token', async () => {
    const ws = connect({ token: 'nope' });
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    expect(code).toBe(1008);
  });

  it('refuses a handshake without the mcp subprotocol', async () => {
    const ws = connect({ protocols: [] });
    const err = await new Promise<Error>((r) => ws.once('error', r));
    expect(err).toBeTruthy();
  });

  it('answers JSON that is not a message with Invalid Request and keeps the connection', async () => {
    const ws = connect();
    await open(ws);
    for (const payload of ['null', '42', '"text"', '[1]']) {
      const reply = next(ws);
      ws.send(payload);
      expect((await reply).error.code).toBe(-32600);
    }
    expect((await rpc(ws, 1, 'ping')).result).toEqual({});
    ws.close();
  });

  it('answers initialize, tools/list, ping and unknown methods', async () => {
    const ws = connect();
    await open(ws);
    expect(ws.protocol).toBe('mcp');
    const init = await rpc(ws, 0, 'initialize', { protocolVersion: '2025-03-26' });
    expect(init.result.protocolVersion).toBe('2024-11-05');
    expect(init.result.serverInfo.name).toBe('ARcode');
    expect(init.result.capabilities.tools).toBeTruthy();
    const list = await rpc(ws, 1, 'tools/list');
    const names = list.result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'openDiff',
        'close_tab',
        'closeAllDiffTabs',
        'openFile',
        'getDiagnostics',
        'open_files',
        'get_all_opened_file_paths',
        'reformat_file',
      ]),
    );
    expect(list.result.tools).toEqual(TOOLS);
    const diff = list.result.tools.find((t) => t.name === 'openDiff');
    expect(diff?.inputSchema.required).toEqual(['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name']);
    expect((await rpc(ws, 2, 'ping')).result).toEqual({});
    expect((await rpc(ws, 3, 'bogus/method')).error.code).toBe(-32601);
    ws.close();
  });

  it('reports ide_connected', async () => {
    const ws = connect();
    await open(ws);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ide_connected', params: { pid: 777 } }));
    await rpc(ws, 1, 'ping');
    expect(connectedPid).toBe(777);
    ws.close();
  });

  it('openDiff resolves saved, rejected, closed', async () => {
    const ws = connect();
    await open(ws);
    const args = {
      old_file_path: '/a.ts',
      new_file_path: '/a.ts',
      new_file_contents: 'x',
      tab_name: 't',
    };
    const call = (id: number) => rpc(ws, id, 'tools/call', { name: 'openDiff', arguments: args });

    let p = call(1);
    await new Promise((r) => setTimeout(r, 20));
    resolveDiff({ result: 'saved', contents: 'final text' });
    expect((await p).result.content).toEqual([
      { type: 'text', text: 'FILE_SAVED' },
      { type: 'text', text: 'final text' },
    ]);

    p = call(2);
    await new Promise((r) => setTimeout(r, 20));
    resolveDiff({ result: 'rejected' });
    expect((await p).result.content).toEqual([{ type: 'text', text: 'DIFF_REJECTED' }]);

    p = call(3);
    await new Promise((r) => setTimeout(r, 20));
    resolveDiff({ result: 'closed' });
    expect((await p).result.content).toEqual([{ type: 'text', text: 'TAB_CLOSED' }]);
    ws.close();
  });

  it('openFile returns OK and reaches the host', async () => {
    const ws = connect();
    await open(ws);
    const r = await rpc(ws, 1, 'tools/call', {
      name: 'openFile',
      arguments: { filePath: '/x/y.ts', preview: false, selectToEndOfLine: false, makeFrontmost: true },
    });
    expect(r.result.content).toEqual([{ type: 'text', text: 'OK' }]);
    expect(opened).toEqual(['/x/y.ts']);
    const d = await rpc(ws, 2, 'tools/call', { name: 'getDiagnostics', arguments: {} });
    expect(d.result.content[0]?.text).toBe('[]');
    ws.close();
  });

  it('broadcasts selection_changed and at_mentioned to all clients', async () => {
    const a = connect();
    const b = connect();
    await Promise.all([open(a), open(b)]);
    const payload = {
      selection: { start: { line: 1, character: 2 }, end: { line: 3, character: 0 } },
      text: 'hello',
      filePath: '/x/y.ts',
    };
    const pa = next(a);
    const pb = next(b);
    bridge.notifySelectionChanged(payload);
    for (const m of await Promise.all([pa, pb])) {
      expect(m).toEqual({ jsonrpc: '2.0', method: 'selection_changed', params: payload });
    }
    const pm = next(a);
    bridge.notifyAtMentioned({ filePath: '/x/y.ts', lineStart: 4, lineEnd: 9 });
    expect((await pm).params).toEqual({ filePath: '/x/y.ts', lineStart: 4, lineEnd: 9 });
    a.close();
    b.close();
  });

  it('writes a 0600 lock file and removes it on stop', async () => {
    const file = join(dir, `${bridge.port}.lock`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(json)).toEqual([
      'workspaceFolders',
      'pid',
      'ideName',
      'transport',
      'runningInWindows',
      'authToken',
    ]);
    expect(json).toMatchObject({
      workspaceFolders: ['/work/proj'],
      pid: 4242,
      ideName: 'ARcode',
      transport: 'ws',
      runningInWindows: false,
      authToken: bridge.authToken,
    });
    expect(bridge.authToken).toMatch(/^[A-Za-z0-9_-]{86}$/);
    await bridge.stop();
    expect(existsSync(file)).toBe(false);
  });

  it('exports pty env', () => {
    expect(ideEnv(123)).toEqual({
      CLAUDE_CODE_SSE_PORT: '123',
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
    });
  });
});
