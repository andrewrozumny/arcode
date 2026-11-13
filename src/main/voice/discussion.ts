/**
 * The discussion partner of the live chat: a long-lived headless Claude Code process per project
 * window (`claude -p` with stream-json in and out) that talks about the work in the user's Claude
 * Code session without touching it. It runs on the user's own Claude Code login and subscription,
 * may only read files (Read, Grep, Glob), loads no MCP servers and keeps no session on disk.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { DiscussionEvent, DiscussionModel } from '@shared/voice';
import { envForChild } from '../env';

export const DISCUSSION_TOOLS = 'Read,Grep,Glob';
/** Name of ARcode's lookup server for the partner (its tools are mcp__arcode__*). */
export const SESSION_SERVER = 'arcode';
/** Longest text of the user's own sent whole; longer ones are refused with a note, never cut. */
export const MAX_DISCUSSION_TEXT = 150_000;
/** Exchanges replayed to a restarted partner, and their size. */
const REPLAY_EXCHANGES = 12;
const REPLAY_ANSWER_CHARS = 1500;
const REPLAY_CHARS = 12_000;
/** How long a model switch over stdin may take before the process is restarted instead. */
const SET_MODEL_MS = 5000;

export const DISCUSSION_PROMPT = `You are the user's voice discussion partner inside ARcode, an editor where they work with Claude Code (an AI coding agent) on this project.
Your job is to talk with them about that work: what Claude Code is doing, the decisions it made, trade-offs, what to do next, and to think a task through with them before it goes to Claude Code. You are not Claude Code and you do not change anything: never write, edit or run code. You may read project files (Read, Grep, Glob) when that helps you answer.
Each user message starts with a <claude_code_session> block from ARcode: kind="full" is a brief of their Claude Code session (status, the current task, Claude Code's latest message, todos, errors, files changed, earlier prompts); kind="delta" is only what changed since your previous message; kind="none" says no session is open. Use it as context and do not repeat it back. Markers like [+N chars: session_turn(-2)] or tool_output("id") mean more exists: when the user asks about something the block does not show in full (an error, a log, a test run, what Claude Code did earlier, a subagent's report), look it up with the arcode tools (session_turn, tool_output, session_search, subagents, session_brief) before answering. Never guess and never ask the user to paste what you can look up.
Large documents: when asked to read, review or debrief a big file, Read it in parts (offset and limit) until you have covered all of it, then answer about the whole; if you stop early, say which part you covered. You can only read files inside this project; for a file elsewhere, say so in one sentence and ask the user to put it in the project.
An <earlier_discussion> block means you were restarted: it is your own conversation with the user so far. Continue it; do not greet again.
Your answers are read aloud: speak naturally and briefly, usually 1 to 4 sentences, in the language the user speaks. No Markdown, no lists, no code, no file paths unless they ask. Ask a short question back when it moves the discussion forward.
Handing over: when the user asks you, or agrees when you offer, to pass something to Claude Code, ARcode sends it for you (if Claude Code is busy, it waits in Claude Code's queue). Answer with one short spoken sentence saying you are handing it over, then the task inside <handover>...</handover>: a clear, self-contained instruction for Claude Code in the user's language (Markdown is fine inside the tags), with the context from your discussion that Claude Code needs. Everything inside the tags is typed into Claude Code and sent, and is not read aloud. Use the tags only then, at most once per answer. Never say you cannot send it.`;

/** Where the `claude` executable is: `ARCODE_CLAUDE`, else the usual install folders, else PATH. */
export async function locateClaude(env: Record<string, string | undefined>, home = os.homedir()): Promise<string | null> {
  const candidates = [
    env.ARCODE_CLAUDE,
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...(env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, 'claude')),
  ].filter((p): p is string => !!p);
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Next one.
    }
  }
  return null;
}

/** Where the partner reaches ARcode's lookup server; the token comes from ARCODE_MCP_TOKEN in its environment. */
export interface SessionServer {
  url: string;
  token: string;
}

export function discussionArgs(model: string, server: SessionServer | null = null): string[] {
  const lookup = server
    ? [
        '--mcp-config',
        JSON.stringify({
          mcpServers: { [SESSION_SERVER]: { type: 'http', url: server.url, headers: { Authorization: 'Bearer ${ARCODE_MCP_TOKEN}' }, alwaysLoad: true } },
        }),
        '--allowedTools',
        `mcp__${SESSION_SERVER}`,
      ]
    : [];
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--tools', DISCUSSION_TOOLS,
    '--strict-mcp-config',
    ...lookup,
    '--no-session-persistence',
    '--append-system-prompt', DISCUSSION_PROMPT,
  ];
}

/** Lines of `claude -p` output that are not part of an answer but matter to the discussion. */
export type ControlLine =
  | { type: 'model'; requestId: string; ok: boolean }
  | { type: 'compacted' }
  | { type: 'lookup'; ok: boolean };

export function controlLine(line: string): ControlLine | null {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (message.type === 'control_response') {
    const response = message.response as { subtype?: unknown; request_id?: unknown } | undefined;
    if (typeof response?.request_id !== 'string') return null;
    return { type: 'model', requestId: response.request_id, ok: response.subtype === 'success' };
  }
  if (message.type !== 'system') return null;
  if (message.subtype === 'compact_boundary') return { type: 'compacted' };
  if (message.subtype === 'init' && Array.isArray(message.mcp_servers)) {
    const server = (message.mcp_servers as { name?: unknown; status?: unknown }[]).find((s) => s.name === SESSION_SERVER);
    return server ? { type: 'lookup', ok: server.status === 'connected' } : null;
  }
  return null;
}

/** What the user and the partner said, as replayed to a restarted partner (newest kept within the budget). */
export function replayBlock(exchanges: readonly { user: string; partner: string }[]): string {
  const parts: string[] = [];
  let size = 0;
  for (let i = exchanges.length - 1; i >= 0 && parts.length < REPLAY_EXCHANGES; i--) {
    const e = exchanges[i];
    if (!e) continue;
    const answer = e.partner.length > REPLAY_ANSWER_CHARS ? `${e.partner.slice(0, REPLAY_ANSWER_CHARS)}…` : e.partner;
    const user = e.user.length > REPLAY_ANSWER_CHARS * 2 ? `${e.user.slice(0, REPLAY_ANSWER_CHARS * 2)}…` : e.user;
    const part = `User: ${user}\nYou: ${answer || '(no answer)'}`;
    if (size + part.length > REPLAY_CHARS && parts.length > 0) break;
    parts.unshift(part);
    size += part.length;
  }
  return parts.length ? `<earlier_discussion>\n${parts.join('\n\n')}\n</earlier_discussion>` : '';
}

/** The message written to the partner: brief, replay and the user's own text. */
export function partnerMessage(brief: string, replay: string, text: string): string {
  return [brief, replay, text].filter(Boolean).join('\n\n');
}

/** The discussion events a line of `claude -p` stream-json output carries. */
export function discussionEvents(line: string): DiscussionEvent[] {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (message.type === 'stream_event') {
    const event = message.event as { type?: unknown; delta?: { type?: unknown; text?: unknown } } | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      return [{ type: 'delta', text: event.delta.text }];
    }
    // A new assistant message (after a tool call) starts a new paragraph of the answer.
    if (event?.type === 'message_start') return [{ type: 'message' }];
    return [];
  }
  if (message.type === 'result') {
    if (message.subtype === 'success') return [{ type: 'done' }];
    const reason = typeof message.result === 'string' ? message.result : String(message.subtype ?? 'failed');
    return [{ type: 'error', message: `The discussion failed: ${reason.slice(0, 300)}` }];
  }
  return [];
}

export interface DiscussionOptions {
  /** ARcode's lookup server, when it runs. */
  server?: SessionServer | null;
  /** The partner compacted its own context: the next brief must be a full one. */
  onCompacted?(): void;
  env?: Record<string, string | undefined>;
}

export class Discussion {
  private child: ChildProcessWithoutNullStreams | null = null;
  /** Model the running process uses. */
  private model: DiscussionModel | null = null;
  private buffer = '';
  private stderr = '';
  /** The conversation so far, replayed when the process has to start again. */
  private exchanges: { user: string; partner: string }[] = [];
  private answer = '';
  private lookupWarned = false;
  private requests = 0;
  private readonly waiting = new Map<string, (ok: boolean) => void>();
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly projectRoot: string,
    private readonly emit: (event: DiscussionEvent) => void,
    private readonly options: DiscussionOptions = {},
  ) {
    this.env = options.env ?? process.env;
  }

  private async spawnChild(model: DiscussionModel): Promise<ChildProcessWithoutNullStreams> {
    const claude = await locateClaude(this.env);
    if (!claude) throw new Error('Claude Code was not found (set ARCODE_CLAUDE to its path)');
    const server = this.options.server ?? null;
    const env = { ...envForChild(this.env, { project: this.projectRoot }), ...(server ? { ARCODE_MCP_TOKEN: server.token } : {}) };
    const child = spawn(claude, discussionArgs(model, server), { cwd: this.projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.model = model;
    this.buffer = '';
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.line(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    const gone = (code: number | null): void => {
      if (this.child !== child) return;
      this.child = null;
      for (const resolve of this.waiting.values()) resolve(false);
      this.waiting.clear();
      if (code !== 0) {
        const detail = this.stderr.trim().split('\n').pop() ?? '';
        this.emit({ type: 'error', message: `The discussion stopped${detail ? `: ${detail}` : ''}` });
      }
    };
    child.on('exit', gone);
    child.on('error', (error) => {
      this.stderr += String(error);
      gone(1);
    });
    return child;
  }

  private line(line: string): void {
    const control = controlLine(line);
    if (control?.type === 'model') {
      this.waiting.get(control.requestId)?.(control.ok);
      this.waiting.delete(control.requestId);
      return;
    }
    if (control?.type === 'compacted') this.options.onCompacted?.();
    if (control?.type === 'lookup' && !control.ok && !this.lookupWarned) {
      this.lookupWarned = true;
      this.emit({ type: 'note', text: 'Session lookup is unavailable; the partner sees only the brief of the session.' });
    }
    for (const event of discussionEvents(line)) {
      if (event.type === 'delta') this.answer += event.text;
      if (event.type === 'done' || event.type === 'error') {
        const last = this.exchanges[this.exchanges.length - 1];
        if (last && !last.partner) last.partner = this.answer.trim();
        this.answer = '';
      }
      this.emit(event);
    }
  }

  /** Switches the running process to another model; false when it could not (it is then restarted). */
  private setModel(child: ChildProcessWithoutNullStreams, model: DiscussionModel): Promise<boolean> {
    const requestId = `model-${++this.requests}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve(false);
      }, SET_MODEL_MS);
      this.waiting.set(requestId, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_model', model } })}\n`);
    });
  }

  /** The process for `model`, and whether it is a new one (it then needs the whole context). */
  private async ready(model: DiscussionModel): Promise<{ child: ChildProcessWithoutNullStreams; fresh: boolean }> {
    if (this.child && this.model !== model) {
      if (await this.setModel(this.child, model)) this.model = model;
      else this.stop();
    }
    if (this.child) return { child: this.child, fresh: false };
    return { child: await this.spawnChild(model), fresh: true };
  }

  /**
   * Sends one message; the answer comes back as events. `brief` gives the session context for it:
   * the whole of it when the process is new.
   */
  async send(text: string, model: DiscussionModel, brief: (fresh: boolean) => Promise<string>): Promise<void> {
    if (text.length > MAX_DISCUSSION_TEXT) {
      throw new Error(`Too long (${text.length} characters): save it as a file in the project and ask the partner to read it`);
    }
    const { child, fresh } = await this.ready(model);
    const replay = fresh ? replayBlock(this.exchanges) : '';
    const content = partnerMessage(await brief(fresh), replay, text);
    this.exchanges.push({ user: text, partner: '' });
    if (this.exchanges.length > REPLAY_EXCHANGES * 2) this.exchanges.splice(0, this.exchanges.length - REPLAY_EXCHANGES * 2);
    this.answer = '';
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  }

  private stop(): void {
    const child = this.child;
    this.child = null;
    this.model = null;
    if (child && !child.killed) child.kill();
  }

  /** Ends the conversation; the next message starts a fresh one. */
  reset(): void {
    this.stop();
    this.exchanges = [];
    this.answer = '';
  }
}
