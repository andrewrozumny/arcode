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

/**
 * Feed of one session: the transcript tail on first use, then the bytes appended since the last
 * read, polled while `visible`. Each poll is a stat plus a read of the new bytes in main.
 */
export function useFeed(sessionId: string | null, visible: boolean) {
  const [state, setState] = useState<FeedState | null>(null);
  /** Session whose "load earlier" read is in flight; another session's read does not block this one. */
  const [loadingFor, setLoadingFor] = useState<string | null>(null);
  const loadingEarlier = sessionId !== null && loadingFor === sessionId;
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
    if (!sessionId || !visible) return;
    const api = claudeApi();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number): void => {
      if (!cancelled) timer = setTimeout(tick, ms);
    };
    const tick = (): void => {
      timer = undefined;
      const current = stateRef.current;
      const loaded = current?.sessionId === sessionId && current.loaded && current.found;
      const request: FeedRequest = loaded ? { sessionId, from: current.end } : { sessionId };
      void api
        .feed(request)
        .then((chunk) => {
          if (cancelled) return;
          apply(sessionId, chunk, loaded ? 'append' : 'tail');
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
  }, [sessionId, visible, apply]);

  const loadEarlier = useCallback(() => {
    const current = stateRef.current;
    if (!current || !canLoadEarlier(current) || loadingEarlier) return;
    const sid = current.sessionId;
    setLoadingFor(sid);
    void claudeApi()
      .feed({ sessionId: sid, before: current.start })
      .then((chunk) => apply(sid, chunk, 'prepend'))
      .catch(() => undefined)
      .finally(() => setLoadingFor((prev) => (prev === sid ? null : prev)));
  }, [apply, loadingEarlier]);

  const current = state && state.sessionId === sessionId ? state : null;
  return { state: current, loadEarlier, loadingEarlier };
}
