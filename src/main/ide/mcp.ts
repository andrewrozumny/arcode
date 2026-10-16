import type { IdeHost } from '@shared/ide';

export const PROTOCOL_VERSION = '2024-11-05';

type Id = string | number | null;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC message must be an object; `null`, arrays and primitives are invalid requests. */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const str = { type: 'string' };
const bool = { type: 'boolean' };

export const TOOLS: ToolDef[] = [
  {
    name: 'openDiff',
    description: 'Opens a diff in the IDE',
    inputSchema: {
      type: 'object',
      properties: { old_file_path: str, new_file_path: str, new_file_contents: str, tab_name: str },
      required: ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name'],
    },
  },
  {
    name: 'close_tab',
    description: 'Closes a tab in the IDE, given either the tab_name used in openDiff or the\nabsolute file path.',
    inputSchema: { type: 'object', properties: { tab_name: str }, required: ['tab_name'] },
  },
  {
    name: 'closeAllDiffTabs',
    description: 'Closes all diff tabs in the IDE',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'openFile',
    description: 'Opens the specified file in the IDE',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: str,
        preview: bool,
        startText: str,
        endText: str,
        selectToEndOfLine: bool,
        makeFrontmost: bool,
      },
      required: ['filePath', 'preview', 'selectToEndOfLine', 'makeFrontmost'],
    },
  },
  {
    name: 'open_files',
    description: 'Opens the specified files in the IDE using their absolute file paths.',
    inputSchema: {
      type: 'object',
      properties: { file_paths: { type: 'array' } },
      required: ['file_paths'],
    },
  },
  {
    name: 'get_all_opened_file_paths',
    description:
      'Gets a list of the absolute file paths that are currently open (usually as tabs) in the IDE. Returns \na list of absolute file paths separated by newline symbol.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reformat_file',
    description: 'Reformats the specified file (entire file) in the IDE given an absolute file path.',
    inputSchema: { type: 'object', properties: { file_path: str }, required: ['file_path'] },
  },
  {
    name: 'getDiagnostics',
    description: 'Gets diagnostic info.',
    inputSchema: { type: 'object', properties: { uri: str } },
  },
];

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const text = (...t: string[]): ToolResult => ({ content: t.map((x) => ({ type: 'text', text: x })) });

export interface McpHooks {
  onIdeConnected?(pid: number | undefined): void;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

async function callTool(host: IdeHost, name: string, args: Record<string, unknown>): Promise<ToolResult | undefined> {
  switch (name) {
    case 'openDiff': {
      try {
        const r = await host.openDiff({
          oldFilePath: asString(args.old_file_path),
          newFilePath: asString(args.new_file_path),
          newFileContents: asString(args.new_file_contents),
          tabName: asString(args.tab_name),
        });
        if (r.result === 'saved') return text('FILE_SAVED', r.contents);
        if (r.result === 'closed') return text('TAB_CLOSED');
        return text('DIFF_REJECTED');
      } catch {
        return { ...text('Error opening diff'), isError: true };
      }
    }
    case 'close_tab':
      await host.closeTab(asString(args.tab_name));
      return text('OK');
    case 'closeAllDiffTabs':
      await host.closeAllDiffTabs();
      return text('OK');
    case 'openFile':
      await host.openFile({
        filePath: asString(args.filePath),
        makeFrontmost: args.makeFrontmost !== false,
      });
      return text('OK');
    case 'open_files': {
      const paths = Array.isArray(args.file_paths)
        ? args.file_paths.filter((p): p is string => typeof p === 'string')
        : [];
      for (const filePath of paths) await host.openFile({ filePath, makeFrontmost: false });
      return text(JSON.stringify({ file_paths: paths }));
    }
    case 'get_all_opened_file_paths':
      return text('');
    case 'reformat_file':
      return text('OK');
    case 'getDiagnostics':
      return text('[]');
    default:
      return undefined;
  }
}

/** Per-connection JSON-RPC handler. Returns the response object, or undefined for notifications. */
export function createMcpHandler(host: IdeHost, hooks: McpHooks = {}) {
  return async function handle(msg: JsonRpcMessage): Promise<object | undefined> {
    const { id, method } = msg;
    const hasId = id !== undefined && id !== null;
    const ok = (result: unknown): object => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): object => ({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message },
    });

    if (typeof method !== 'string') return hasId ? fail(-32600, 'Invalid Request') : undefined;

    if (!hasId) {
      if (method === 'ide_connected') {
        const pid = msg.params?.pid;
        hooks.onIdeConnected?.(typeof pid === 'number' ? pid : undefined);
      }
      return undefined;
    }

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'Acode', version: '0.0.1' },
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = asString(msg.params?.name);
        const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
        try {
          const r = await callTool(host, name, args);
          return r ? ok(r) : fail(-32602, `Unknown tool: ${name}`);
        } catch (error) {
          return fail(-32603, error instanceof Error ? error.message : 'Internal error');
        }
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}
