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
import type { DiscussionEvent } from '@shared/voice';
import { envForChild } from '../env';

export const DISCUSSION_TOOLS = 'Read,Grep,Glob';
export const DEFAULT_DISCUSSION_MODEL = 'sonnet';
/** Longest message (with its session update) sent in one turn. */
export const MAX_DISCUSSION_MESSAGE = 24_000;

export const DISCUSSION_PROMPT = `You are the user's voice discussion partner inside ARcode, an editor where they work with Claude Code (an AI coding agent) on this project.
Your job is to talk with them about that work: what Claude Code is doing, the decisions it made, trade-offs, what to do next. You are not Claude Code and you do not change anything: never write, edit or run code. You may read project files (Read, Grep, Glob) when that helps you answer.
Each user message may start with a <claude_code_session_update> block: what happened in their Claude Code session since their last message (their prompts, Claude Code's messages, the tools it ran). Use it as context; do not repeat it back.
Your answers are read aloud: speak naturally and briefly, usually 1 to 4 sentences, in the language the user speaks. No Markdown, no lists, no code, no file paths unless they ask. Ask a short question back when it moves the discussion forward.
When the user asks to hand the result over to Claude Code, answer with only the task for Claude Code: a clear, self-contained instruction in the user's language, written as Markdown, nothing else.`;

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

export function discussionArgs(model: string): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', model,
    '--tools', DISCUSSION_TOOLS,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--append-system-prompt', DISCUSSION_PROMPT,
  ];
}

export function discussionModel(env: Record<string, string | undefined>): string {
  const model = env.ARCODE_DISCUSSION_MODEL?.trim();
  return model && /^[a-z0-9._[\]-]{2,64}$/i.test(model) ? model : DEFAULT_DISCUSSION_MODEL;
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

export class Discussion {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderr = '';

  constructor(
    private readonly projectRoot: string,
    private readonly emit: (event: DiscussionEvent) => void,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child) return this.child;
    const claude = await locateClaude(this.env);
    if (!claude) throw new Error('Claude Code was not found (set ARCODE_CLAUDE to its path)');
    const child = spawn(claude, discussionArgs(discussionModel(this.env)), {
      cwd: this.projectRoot,
      env: envForChild(this.env, { project: this.projectRoot }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = '';
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) for (const event of discussionEvents(line)) this.emit(event);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000);
    });
    const gone = (code: number | null): void => {
      if (this.child !== child) return;
      this.child = null;
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

  /** Sends one message; the answer comes back as events. */
  async send(text: string): Promise<void> {
    const child = await this.start();
    const message = { type: 'user', message: { role: 'user', content: text.slice(0, MAX_DISCUSSION_MESSAGE) } };
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Ends the conversation; the next message starts a fresh one. */
  reset(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
  }
}
