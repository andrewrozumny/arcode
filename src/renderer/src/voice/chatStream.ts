import { useEffect, useRef, useState } from 'react';
import type { FeedItem } from '@shared/claude';

/** One line of the live chat window. */
export interface ChatEntry {
  id: string;
  role: 'you' | 'claude' | 'action';
  text: string;
  /** Time of the transcript record, when it has one. */
  at?: string | null;
}

/** How often the transcript is read for new messages while the live chat is on. */
const POLL_MS = 800;
/** Lines kept in the window. */
const MAX_ENTRIES = 60;
/** Messages of the conversation shown when the chat opens, for context (they are not read aloud). */
const CONTEXT_ENTRIES = 4;

/** Feed items as chat lines: prompts, Claude's text, and one short line per tool call. */
export function chatEntries(items: readonly FeedItem[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const item of items) {
    const at = item.at;
    if (item.kind === 'user' && item.text.trim()) out.push({ id: item.id, role: 'you', text: item.text.trim(), at });
    else if (item.kind === 'command') out.push({ id: item.id, role: 'you', text: item.text, at });
    else if (item.kind === 'assistant') out.push({ id: item.id, role: 'claude', text: item.text.trim(), at });
    else if (item.kind === 'tool') out.push({ id: item.id, role: 'action', text: item.summary || item.name, at });
  }
  return out;
}

const READ_ALOUD_KEY = 'arcode.voiceChat.readAloud';

/** Whether the live chat reads Claude's messages aloud (on unless switched off). */
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

/** Clock skew allowed between the transcript's times and this window's clock. */
const SKEW_MS = 2000;

/**
 * The first read of a session: lines written since the chat was turned on are new (a fresh session
 * only gets its transcript with the first message), older ones are the last few lines of context.
 */
export function splitFirstRead(entries: readonly ChatEntry[], since: number): { context: ChatEntry[]; fresh: ChatEntry[] } {
  const isFresh = (e: ChatEntry): boolean => !!e.at && Date.parse(e.at) >= since - SKEW_MS;
  const firstFresh = entries.findIndex(isFresh);
  if (firstFresh < 0) return { context: entries.slice(-CONTEXT_ENTRIES), fresh: [] };
  return { context: entries.slice(0, firstFresh).slice(-CONTEXT_ENTRIES), fresh: entries.slice(firstFresh) };
}

/** Appends lines, dropping ones already shown (a re-read range) and keeping the newest MAX_ENTRIES. */
export function appendEntries(current: readonly ChatEntry[], next: readonly ChatEntry[]): ChatEntry[] {
  if (next.length === 0) return current as ChatEntry[];
  const seen = new Set(current.map((e) => e.id));
  const merged = [...current, ...next.filter((e) => !seen.has(e.id))];
  return merged.length > MAX_ENTRIES ? merged.slice(-MAX_ENTRIES) : merged;
}

/**
 * The live chat's view of a session: while `active`, reads what is appended to the transcript and
 * hands each new message of Claude to `onClaude` (to be read aloud). Opening shows the last few
 * lines for context without reading them.
 */
export function useChatStream(sessionId: string | null, active: boolean, onClaude: (text: string) => void): ChatEntry[] {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const onClaudeRef = useRef(onClaude);
  useEffect(() => {
    onClaudeRef.current = onClaude;
  }, [onClaude]);

  useEffect(() => {
    if (!active || !sessionId) return;
    let live = true;
    let cursor: number | null = null;
    const since = Date.now();
    const announce = (entries: readonly ChatEntry[]): void => {
      for (const entry of entries) if (entry.role === 'claude') onClaudeRef.current(entry.text);
    };
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        if (cursor === null) {
          const tail = await window.acode.claude.feed({ sessionId });
          // No transcript yet (a fresh session gets one with its first message): try again.
          if (!live || !tail.found) return;
          cursor = tail.end;
          const { context, fresh } = splitFirstRead(chatEntries(tail.items), since);
          setEntries([...context, ...fresh]);
          announce(fresh);
        } else {
          const chunk = await window.acode.claude.feed({ sessionId, from: cursor });
          if (!live) return;
          cursor = chunk.end;
          // A rewritten transcript starts over from its tail; nothing old is read aloud.
          const fresh = chatEntries(chunk.items);
          setEntries((prev) => appendEntries(chunk.reset ? [] : prev, chunk.reset ? fresh.slice(-CONTEXT_ENTRIES) : fresh));
          if (!chunk.reset) announce(fresh);
        }
      } catch {
        // No transcript yet, or it moved: try again on the next tick.
      } finally {
        if (live) timer = window.setTimeout(() => void poll(), POLL_MS);
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, sessionId]);

  return entries;
}
