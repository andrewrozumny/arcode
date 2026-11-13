/**
 * The `arcode` MCP server of the discussion partner: Streamable HTTP (plain JSON responses) on
 * 127.0.0.1 inside the main process, so it needs no separate program and always knows which
 * session each window is on. Every partner process gets its own bearer token; the token decides
 * which window's session the lookup tools read. Nothing is reachable without a token.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isJsonRpcMessage, type JsonRpcMessage } from '../ide/mcp';
import { callSessionTool, SESSION_TOOLS, type SessionSource } from './sessionTools';

const MAX_BODY = 1024 * 1024;
const PROTOCOL = '2025-03-26';

/** Answers one JSON-RPC message for a source; undefined for notifications. */
export async function handleSessionMcp(msg: JsonRpcMessage, source: SessionSource): Promise<object | undefined> {
  const { id, method } = msg;
  if (id === undefined || id === null) return undefined;
  const ok = (result: unknown): object => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): object => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'arcode', version: '1' },
        instructions: "Look up the user's Claude Code session: its turns, tool outputs, a search, its subagents.",
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: SESSION_TOOLS });
    case 'tools/call': {
      const name = typeof msg.params?.name === 'string' ? msg.params.name : '';
      const args = msg.params?.arguments;
      if (!SESSION_TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const text = await callSessionTool(name, args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}, source);
        return ok({ content: [{ type: 'text', text }] });
      } catch (error) {
        return ok({ content: [{ type: 'text', text: error instanceof Error ? error.message : 'The lookup failed' }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => {
      size += part.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      parts.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export class SessionMcpServer {
  private server: Server | null = null;
  private starting: Promise<number> | null = null;
  private readonly sources = new Map<string, SessionSource>();

  /** Starts the server once; resolves to its port. */
  start(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
    return this.starting;
  }

  /** A new token for a source; the partner sends it as `Authorization: Bearer <token>`. */
  register(source: SessionSource): string {
    const token = randomBytes(24).toString('hex');
    this.sources.set(token, source);
    return token;
  }

  unregister(token: string): void {
    this.sources.delete(token);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.starting = null;
    this.sources.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = req.headers.authorization ?? '';
    const source = auth.startsWith('Bearer ') ? this.sources.get(auth.slice(7)) : undefined;
    if (!source) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const body = await readBody(req);
    let msg: unknown;
    try {
      msg = body === null ? null : JSON.parse(body);
    } catch {
      msg = undefined;
    }
    if (!isJsonRpcMessage(msg)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
      return;
    }
    const answer = await handleSessionMcp(msg, source);
    if (!answer) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  }
}
