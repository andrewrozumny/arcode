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
  /** A task written for Claude Code (typed into its prompt, not read aloud). */
  handover?: boolean;
}

/** Lines of the Claude Code session sent with the first message, for context. */
const FIRST_UPDATE_ITEMS = 40;
/** Longest session update sent with one message; the oldest lines are dropped first. */
const MAX_UPDATE_CHARS = 8000;
const MAX_LINE_CHARS = 600;
const HANDOVER_REQUEST =
  'Hand this over to Claude Code now: write the task that follows from our discussion, as described in your instructions.';

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

/**
 * Splits streamed text into sentences ready to be read aloud. Text inside code fences is never
 * returned, even when a fence arrives in pieces.
 */
export class SentenceStream {
  private pending = '';
  private inFence = false;

  /** Adds streamed text; returns the sentences it completed. */
  push(text: string): string[] {
    this.pending += text;
    const out: string[] = [];
    for (;;) {
      if (this.inFence) {
        const close = this.pending.indexOf('```');
        if (close < 0) {
          // Keep only a possible partial fence marker at the end.
          this.pending = this.pending.slice(-2);
          return out;
        }
        this.pending = this.pending.slice(close + 3);
        this.inFence = false;
        continue;
      }
      const open = this.pending.indexOf('```');
      const end = /[.!?…]+["»)]?(?=\s)|\n\s*\n/.exec(open >= 0 ? this.pending.slice(0, open) : this.pending);
      if (end) {
        const cut = end.index + end[0].length;
        const sentence = this.pending.slice(0, cut).trim();
        this.pending = this.pending.slice(cut);
        if (sentence) out.push(sentence);
        continue;
      }
      if (open >= 0) {
        const before = this.pending.slice(0, open).trim();
        if (before) out.push(before);
        this.pending = this.pending.slice(open + 3);
        this.inFence = true;
        continue;
      }
      return out;
    }
  }

  /** The rest, at the end of an answer. */
  flush(): string[] {
    const rest = this.inFence ? '' : this.pending.trim();
    this.pending = '';
    this.inFence = false;
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
}

/**
 * A spoken discussion about the work in a Claude Code session, with a partner that does not touch
 * it. Each message carries what happened in the session since the previous one. `handOver` asks the
 * partner for the resulting task and types it into the Claude Code tab's prompt (not sent).
 */
export function useDiscussion({ projectRoot, sessionId, onSentence }: Options) {
  const [entries, setEntries] = useState<DiscussionEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const cursor = useRef<{ sessionId: string; offset: number } | null>(null);
  const stream = useRef(new SentenceStream());
  const handover = useRef<PtyId | null>(null);
  const answer = useRef('');
  const onSentenceRef = useRef(onSentence);
  useEffect(() => {
    onSentenceRef.current = onSentence;
  }, [onSentence]);

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
        const speaking = handover.current === null;
        if (event.type === 'delta') {
          answer.current += event.text;
          patchLast((e) => ({ ...e, text: e.text + event.text }));
          if (speaking) for (const sentence of stream.current.push(event.text)) onSentenceRef.current(sentence);
        } else if (event.type === 'message') {
          if (answer.current && !answer.current.endsWith('\n')) {
            answer.current += '\n\n';
            patchLast((e) => ({ ...e, text: `${e.text}\n\n` }));
          }
        } else if (event.type === 'done') {
          if (speaking) for (const sentence of stream.current.flush()) onSentenceRef.current(sentence);
          else stream.current.flush();
          patchLast((e) => ({ ...e, streaming: false }));
          setBusy(false);
          const pty = handover.current;
          handover.current = null;
          if (pty !== null && answer.current.trim()) {
            bus.emit('sendToPty', { ptyId: pty, text: answer.current.trim(), submit: false });
            bus.emit('focusPanel', { panel: 'terminal' });
            bus.emit('focusPty', { ptyId: pty });
          }
        } else {
          stream.current.flush();
          handover.current = null;
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
    async (text: string, shown: string, handoverTo: PtyId | null) => {
      answer.current = '';
      stream.current = new SentenceStream();
      handover.current = handoverTo;
      setBusy(true);
      setEntries((prev) => [
        ...prev,
        { id: nextId.current++, role: 'you', text: shown },
        { id: nextId.current++, role: 'partner', text: '', streaming: true, handover: handoverTo !== null },
      ]);
      try {
        await window.acode.voice.discuss(projectRoot, discussionMessage(await update(), text));
      } catch (error) {
        handover.current = null;
        setBusy(false);
        setEntries((prev) => [
          ...prev.map((e) => (e.streaming ? { ...e, streaming: false } : e)),
          { id: nextId.current++, role: 'error', text: error instanceof Error ? error.message : String(error) },
        ]);
      }
    },
    [projectRoot, update],
  );

  const send = useCallback((text: string) => void ask(text, text, null), [ask]);
  const handOver = useCallback((ptyId: PtyId) => void ask(HANDOVER_REQUEST, '→ Hand over to Claude Code', ptyId), [ask]);

  const reset = useCallback(() => {
    window.acode.voice.discussReset();
    cursor.current = null;
    handover.current = null;
    stream.current = new SentenceStream();
    setBusy(false);
    setEntries([]);
  }, []);

  return { entries, busy, send, handOver, reset };
}
