import { useEffect, useState } from 'react';
import type { SubagentInfo } from '@shared/claude';

const POLL_MS = 3000;
const EMPTY: SubagentInfo[] = [];

/**
 * Subagents of the given session, polled every three seconds while the window has focus.
 * Empty when there is no session or the folder does not exist yet.
 */
export function useSubagents(sessionId: string | null): SubagentInfo[] {
  // Keyed by session so switching tabs shows nothing until the new session's first poll lands.
  const [state, setState] = useState<{ sessionId: string; list: SubagentInfo[] }>({ sessionId: '', list: [] });
  useEffect(() => {
    if (!sessionId) return;
    const setList = (next: SubagentInfo[]): void =>
      setState((prev) => {
        const base = prev.sessionId === sessionId ? prev.list : [];
        return prev.sessionId === sessionId && sameList(base, next) ? prev : { sessionId, list: next };
      });
    const api = window.acode?.claude;
    if (!api) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      // A focus event while a request is out must not start a second polling chain.
      if (cancelled || inFlight) return;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!document.hasFocus()) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      inFlight = true;
      void api
        .subagents(sessionId)
        .then((next) => {
          if (!cancelled) setList(next);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
          if (!cancelled) timer = setTimeout(tick, POLL_MS);
        });
    };
    tick();
    const onFocus = (): void => tick();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [sessionId]);
  return sessionId && state.sessionId === sessionId ? state.list : EMPTY;
}

export function sameList(a: readonly SubagentInfo[], b: readonly SubagentInfo[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      y !== undefined &&
      x.id === y.id &&
      x.running === y.running &&
      x.model === y.model &&
      x.modelName === y.modelName &&
      x.label === y.label
    );
  });
}

/** Running agents first (already sorted by main); only those are shown in the header chip. */
export function runningAgents(list: readonly SubagentInfo[]): SubagentInfo[] {
  return list.filter((a) => a.running);
}
