import { useCallback, useEffect, useRef, useState } from 'react';
import type { FeedChunk, FeedRequest } from '@shared/claude';
import { claudeApi } from './api';
import { applyChunk, canLoadEarlier } from './feedModel';
import type { FeedState } from './feedModel';

/** Live poll interval while the feed is visible and the window has focus. */
const POLL_MS = 1000;
/** Poll interval while the feed is visible but the window is in the background. */
const IDLE_POLL_MS = 4000;
/** Retry delay after a failed read (the transcript may not exist yet). */
const RETRY_MS = 3000;

/** Key of the feed state: the session, or `<session>/<agent>` for one of its subagents. */
export function feedKey(sessionId: string, agentId: string | null): string {
  return agentId ? `${sessionId}/${agentId}` : sessionId;
}

/**
 * Feed of one session (or of one of its subagents when `agentId` is set): the transcript tail on
 * first use, then the bytes appended since the last read, polled while `visible`. Each poll is a
 * stat plus a read of the new bytes in main.
 */
export function useFeed(sessionId: string | null, visible: boolean, agentId: string | null = null) {
  const key = sessionId ? feedKey(sessionId, agentId) : null;
  const [state, setState] = useState<FeedState | null>(null);
  /** Session whose "load earlier" read is in flight; another session's read does not block this one. */
  const [loadingFor, setLoadingFor] = useState<string | null>(null);
  const loadingEarlier = key !== null && loadingFor === key;
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const apply = useCallback((sid: string, chunk: FeedChunk, mode: 'tail' | 'append' | 'prepend') => {
    setState((prev) => {
      const next = applyChunk(prev, sid, chunk, mode);
      stateRef.current = next;
      return next;
    });
  }, []);

  // Live reads: the tail first, then appends. Stops while the tab is hidden; keeps what it has.
  useEffect(() => {
    if (!sessionId || !key || !visible) return;
    const base: FeedRequest = agentId ? { sessionId, agentId } : { sessionId };
    const api = claudeApi();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number): void => {
      if (!cancelled) timer = setTimeout(tick, ms);
    };
    const tick = (): void => {
      timer = undefined;
      const current = stateRef.current;
      const loaded = current?.sessionId === key && current.loaded && current.found;
      const request: FeedRequest = loaded ? { ...base, from: current.end } : base;
      void api
        .feed(request)
        .then((chunk) => {
          if (cancelled) return;
          apply(key, chunk, loaded ? 'append' : 'tail');
          // More appended than one read covers: continue right away.
          if (chunk.found && chunk.end < chunk.size && chunk.end > (request.from ?? chunk.end)) schedule(0);
          else schedule(!chunk.found ? RETRY_MS : document.hasFocus() ? POLL_MS : IDLE_POLL_MS);
        })
        .catch(() => schedule(RETRY_MS));
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, agentId, key, visible, apply]);

  const loadEarlier = useCallback(() => {
    const current = stateRef.current;
    if (!sessionId || !key || !current || current.sessionId !== key || !canLoadEarlier(current) || loadingEarlier) return;
    setLoadingFor(key);
    const request: FeedRequest = agentId ? { sessionId, agentId, before: current.start } : { sessionId, before: current.start };
    void claudeApi()
      .feed(request)
      .then((chunk) => apply(key, chunk, 'prepend'))
      .catch(() => undefined)
      .finally(() => setLoadingFor((prev) => (prev === key ? null : prev)));
  }, [apply, loadingEarlier, sessionId, agentId, key]);

  const current = state && state.sessionId === key ? state : null;
  return { state: current, loadEarlier, loadingEarlier };
}
