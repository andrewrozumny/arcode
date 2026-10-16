import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { AtMentionedPayload, IdeBridgeStartOptions, IdeHost, SelectionChangedPayload } from '@shared/ide';
import { defaultLockDir, generateAuthToken, removeLock, writeLock } from './lock';
import { createMcpHandler, isJsonRpcMessage } from './mcp';

export interface IdeBridgeOptions {
  /** Directory for lock files. Defaults to ~/.claude/ide (or $CLAUDE_CONFIG_DIR/ide). */
  lockDir?: string;
  pingIntervalMs?: number;
  onClientConnected?(pid: number | undefined): void;
  /** Called when an authenticated client socket closes; `clientCount` is already updated. */
  onClientDisconnected?(): void;
  log?(message: string): void;
}

const AUTH_HEADER = 'x-claude-code-ide-authorization';

export class IdeBridge {
  port = 0;
  authToken = '';

  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private lockFile: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private alive = new WeakMap<WebSocket, boolean>();
  private exitHandler = (): void => {
    if (this.lockFile) removeLock(this.lockFile);
  };

  constructor(
    private host: IdeHost,
    private options: IdeBridgeOptions = {},
  ) {}

  get clientCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  async start(opts: IdeBridgeStartOptions): Promise<void> {
    if (this.http) throw new Error('IdeBridge already started');
    this.authToken = generateAuthToken();
    const http = createServer((_req, res) => {
      res.writeHead(426).end();
    });
    const wss = new WebSocketServer({
      server: http,
      path: '/',
      // Only the "mcp" subprotocol is accepted; anything else fails the handshake.
      handleProtocols: (protocols) => (protocols.has('mcp') ? 'mcp' : false),
      verifyClient: (info: { req: IncomingMessage }) =>
        String(info.req.headers['sec-websocket-protocol'] ?? '')
          .split(',')
          .map((s) => s.trim())
          .includes('mcp'),
    });
    wss.on('connection', (ws, req) => this.onConnection(ws, req.headers[AUTH_HEADER]));
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => resolve());
    });
    this.http = http;
    this.wss = wss;
    this.port = (http.address() as AddressInfo).port;

    this.lockFile = writeLock(this.options.lockDir ?? defaultLockDir(), this.port, {
      workspaceFolders: opts.workspaceFolders,
      pid: opts.pid ?? process.pid,
      ideName: opts.ideName ?? 'Acode',
      transport: 'ws',
      runningInWindows: false,
      authToken: this.authToken,
    });
    process.on('exit', this.exitHandler);

    this.pingTimer = setInterval(() => this.pingAll(), this.options.pingIntervalMs ?? 5000);
    this.pingTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    process.off('exit', this.exitHandler);
    if (this.lockFile) removeLock(this.lockFile);
    this.lockFile = null;
    const { wss, http } = this;
    this.wss = null;
    this.http = null;
    if (wss) {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
    if (http) await new Promise<void>((r) => http.close(() => r()));
  }

  notifySelectionChanged(payload: SelectionChangedPayload): void {
    this.broadcast('selection_changed', payload);
  }

  notifyAtMentioned(payload: AtMentionedPayload): void {
    const params: AtMentionedPayload = { filePath: payload.filePath };
    if (payload.lineStart !== undefined && payload.lineEnd !== undefined) {
      params.lineStart = payload.lineStart;
      params.lineEnd = payload.lineEnd;
    }
    this.broadcast('at_mentioned', params);
  }

  private broadcast(method: string, params: object): void {
    if (!this.wss) return;
    const data = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
  }

  private pingAll(): void {
    if (!this.wss) return;
    for (const c of this.wss.clients) {
      if (this.alive.get(c) === false) {
        c.terminate();
        continue;
      }
      this.alive.set(c, false);
      c.ping();
    }
  }

  private onConnection(ws: WebSocket, header: string | string[] | undefined): void {
    if (typeof header !== 'string' || header !== this.authToken) {
      ws.close(1008, 'Invalid or missing authentication token');
      return;
    }
    this.alive.set(ws, true);
    ws.on('pong', () => this.alive.set(ws, true));
    const handle = createMcpHandler(this.host, {
      onIdeConnected: (pid) => {
        this.options.log?.(`ide_connected pid=${pid ?? 'unknown'}`);
        this.options.onClientConnected?.(pid);
      },
    });
    ws.on('message', (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }
      // Valid JSON is not necessarily a message: `null` used to throw here, in the main process.
      if (!isJsonRpcMessage(msg)) {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
        return;
      }
      this.options.log?.(`<- ${msg.method ?? 'response'}`);
      void handle(msg).then((res) => {
        if (res && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
      });
    });
    ws.on('close', () => this.options.onClientDisconnected?.());
    ws.on('error', () => ws.terminate());
  }
}
