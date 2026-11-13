import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedItem } from '@shared/claude';
import type { PtyId } from '@shared/ipc';
import { bus } from '../bus';

/** One message of the discussion window. */
export interface DiscussionEntry {
  id: number;
  role: 'you' | 'partner' | 'error';
  text: string;
  /** The partner is still writing it. */
  streaming?: boolean;
  /** The task the partner handed over to Claude Code (shown under the answer, never read aloud). */
  task?: string;
  /** What happened to the task: sent to the Claude tab, or why it could not be. */
  taskStatus?: string;
}

/** Lines of the Claude Code session sent with the first message, for context. */
const FIRST_UPDATE_ITEMS = 40;
/** Longest session update sent with one message; the oldest lines are dropped first. */
const MAX_UPDATE_CHARS = 8000;
const MAX_LINE_CHARS = 600;
const HANDOVER_REQUEST = 'Hand the result of our discussion over to Claude Code now.';
const HANDOVER = /<handover>([\s\S]*?)(?:<\/handover>|$)/;

/** An answer split into what is said and the task handed over to Claude Code, if any. */
export function splitHandover(answer: string): { said: string; task: string | null } {
  const match = HANDOVER.exec(answer);
  if (!match) return { said: answer.trim(), task: null };
  const said = (answer.slice(0, match.index) + answer.slice(match.index + match[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  const task = (match[1] ?? '').trim();
  return { said, task: task || null };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What happened in the Claude Code session, as plain lines for the discussion partner. */
export function sessionUpdate(items: readonly FeedItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'user' && item.text.trim()) lines.push(`User to Claude Code: ${clip(item.text.trim(), MAX_LINE_CHARS)}`);
    else if (item.kind === 'command') lines.push(`User ran: ${clip(item.text, 200)}`);
    else if (item.kind === 'assistant' && item.text.trim()) lines.push(`Claude Code: ${clip(item.text.trim(), MAX_LINE_CHARS)}`);
    else if (item.kind === 'tool') lines.push(`Claude Code used ${item.name}: ${clip(item.summary, 200)}`);
  }
  // Keep the newest lines within the budget.
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (size + line.length + 1 > MAX_UPDATE_CHARS) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  return kept.join('\n');
}

/** The message sent to the partner: the session update (when there is one), then what the user said. */
export function discussionMessage(update: string, text: string): string {
  return update ? `<claude_code_session_update>\n${update}\n</claude_code_session_update>\n\n${text}` : text;
}

/** Parts of an answer that are never read aloud: code blocks and the task handed over to Claude Code. */
const SILENT: readonly { open: string; close: string }[] = [
  { open: '```', close: '```' },
  { open: '<handover>', close: '</handover>' },
];
/** Longest marker, so a marker split across two pieces of the stream is still recognised. */
const MARKER_TAIL = Math.max(...SILENT.flatMap((m) => [m.open.length, m.close.length])) - 1;

/**
 * Splits streamed text into sentences ready to be read aloud. Text inside code fences or handover
 * tags is never returned, even when a marker arrives in pieces.
 */
export class SentenceStream {
  private pending = '';
  private closing: string | null = null;

  /** Adds streamed text; returns the sentences it completed. */
  push(text: string): string[] {
    this.pending += text;
    const out: string[] = [];
    for (;;) {
      if (this.closing) {
        const close = this.pending.indexOf(this.closing);
        if (close < 0) {
          // Keep only what could be the start of the closing marker.
          this.pending = this.pending.slice(-MARKER_TAIL);
          return out;
        }
        this.pending = this.pending.slice(close + this.closing.length);
        this.closing = null;
        continue;
      }
      let open = -1;
      let marker: (typeof SILENT)[number] | null = null;
      for (const m of SILENT) {
        const at = this.pending.indexOf(m.open);
        if (at >= 0 && (open < 0 || at < open)) {
          open = at;
          marker = m;
        }
      }
      // A marker may still be arriving: never speak the last few characters that could start one.
      const speakable = open >= 0 ? this.pending.slice(0, open) : this.pending;
      const end = /[.!?…]+["»)]?(?=\s)|\n\s*\n/.exec(speakable);
      if (end) {
        const cut = end.index + end[0].length;
        const sentence = this.pending.slice(0, cut).trim();
        this.pending = this.pending.slice(cut);
        if (sentence) out.push(sentence);
        continue;
      }
      if (open >= 0 && marker) {
        const before = this.pending.slice(0, open).trim();
        if (before) out.push(before);
        this.pending = this.pending.slice(open + marker.open.length);
        this.closing = marker.close;
        continue;
      }
      return out;
    }
  }

  /** The rest, at the end of an answer. */
  flush(): string[] {
    // Drop a marker that never completed (`<hand` at the very end).
    const rest = this.closing ? '' : this.pending.replace(/<\/?[a-z]*$|`{1,2}$/i, '').trim();
    this.pending = '';
    this.closing = null;
    return rest ? [rest] : [];
  }
}

const READ_ALOUD_KEY = 'arcode.voiceChat.readAloud';

/** Whether the partner's answers are read aloud (on unless switched off). */
export function loadReadAloud(): boolean {
  try {
    return localStorage.getItem(READ_ALOUD_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function saveReadAloud(on: boolean): void {
  try {
    localStorage.setItem(READ_ALOUD_KEY, on ? 'on' : 'off');
  } catch {
    // A convenience; losing it is fine.
  }
}

interface Options {
  projectRoot: string;
  /** Session of the Claude Code tab the discussion is about. */
  sessionId: string | null;
  /** Each complete sentence of an answer, as it streams (for reading aloud). */
  onSentence(sentence: string): void;
  /** The Claude tab a handed-over task goes to, when there is one. */
  handoverTarget(): PtyId | null;
}

/**
 * A spoken discussion about the work in a Claude Code session, with a partner that does not touch
 * it. Each message carries what happened in the session since the previous one. `handOver` asks the
 * partner for the resulting task and types it into the Claude Code tab's prompt (not sent).
 */
export function useDiscussion({ projectRoot, sessionId, onSentence, handoverTarget }: Options) {
  const [entries, setEntries] = useState<DiscussionEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const cursor = useRef<{ sessionId: string; offset: number } | null>(null);
  const stream = useRef(new SentenceStream());
  const answer = useRef('');
  const onSentenceRef = useRef(onSentence);
  const targetRef = useRef(handoverTarget);
  useEffect(() => {
    onSentenceRef.current = onSentence;
    targetRef.current = handoverTarget;
  }, [onSentence, handoverTarget]);

  const patchLast = useCallback((change: (entry: DiscussionEntry) => DiscussionEntry) => {
    setEntries((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'partner') return prev;
      return [...prev.slice(0, -1), change(last)];
    });
  }, []);

  useEffect(
    () =>
      window.acode.voice.onDiscussion((event) => {
        if (event.type === 'delta') {
          answer.current += event.text;
          // The window shows what is said; a handover task appears once the answer is complete.
          const said = splitHandover(answer.current).said;
          patchLast((e) => ({ ...e, text: said }));
          for (const sentence of stream.current.push(event.text)) onSentenceRef.current(sentence);
        } else if (event.type === 'message') {
          if (answer.current && !answer.current.endsWith('\n')) answer.current += '\n\n';
        } else if (event.type === 'done') {
          for (const sentence of stream.current.flush()) onSentenceRef.current(sentence);
          const { said, task } = splitHandover(answer.current);
          let handed: Pick<DiscussionEntry, 'task' | 'taskStatus'> = {};
          if (task) {
            const pty = targetRef.current();
            if (pty !== null) bus.emit('sendToPty', { ptyId: pty, text: task });
            handed = { task, taskStatus: pty === null ? 'Not sent: open a Claude tab first' : 'Sent to Claude Code' };
          }
          patchLast((e) => ({ ...e, text: said, streaming: false, ...handed }));
          setBusy(false);
        } else {
          stream.current.flush();
          setBusy(false);
          setEntries((prev) => [
            ...prev.map((e) => (e.streaming ? { ...e, streaming: false } : e)),
            { id: nextId.current++, role: 'error', text: event.message },
          ]);
        }
      }),
    [patchLast],
  );

  /** What happened in the session since the last message (the recent part of it, the first time). */
  const update = useCallback(async (): Promise<string> => {
    if (!sessionId) return '';
    try {
      const last = cursor.current;
      const chunk =
        last && last.sessionId === sessionId
          ? await window.acode.claude.feed({ sessionId, from: last.offset })
          : await window.acode.claude.feed({ sessionId });
      if (!chunk.found) return '';
      cursor.current = { sessionId, offset: chunk.end };
      const items = last && last.sessionId === sessionId && !chunk.reset ? chunk.items : chunk.items.slice(-FIRST_UPDATE_ITEMS);
      return sessionUpdate(items);
    } catch {
      return '';
    }
  }, [sessionId]);

  const ask = useCallback(
    async (text: string, shown: string) => {
      answer.current = '';
      stream.current = new SentenceStream();
      setBusy(true);
      setEntries((prev) => [
        ...prev,
        { id: nextId.current++, role: 'you', text: shown },
        { id: nextId.current++, role: 'partner', text: '', streaming: true },
      ]);
      try {
        await window.acode.voice.discuss(projectRoot, discussionMessage(await update(), text));
      } catch (error) {
        setBusy(false);
        setEntries((prev) => [
          ...prev.map((e) => (e.streaming ? { ...e, streaming: false } : e)),
          { id: nextId.current++, role: 'error', text: error instanceof Error ? error.message : String(error) },
        ]);
      }
    },
    [projectRoot, update],
  );

  const send = useCallback((text: string) => void ask(text, text), [ask]);
  const handOver = useCallback(() => void ask(HANDOVER_REQUEST, '→ Hand over to Claude Code'), [ask]);

  const reset = useCallback(() => {
    window.acode.voice.discussReset();
    cursor.current = null;
    stream.current = new SentenceStream();
    setBusy(false);
    setEntries([]);
  }, []);

  return { entries, busy, send, handOver, reset };
}
