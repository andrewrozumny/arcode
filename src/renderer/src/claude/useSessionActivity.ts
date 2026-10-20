import { useEffect, useState } from 'react';
import type { PtyId } from '@shared/ipc';
import type { ClaudeStatusEvent } from '@shared/terminal';
import { terminalApi } from '../terminal/api';
import type { SessionActivity } from './feedModel';

export interface SessionStatus {
  activity: SessionActivity;
  /** What Claude waits for (a permission prompt...), while `activity` is `waiting`. */
  waitingFor: string | null;
  /** Pty of this window that runs the session's Claude process, when there is one. */
  ptyId: PtyId | null;
}

function fromEvent(event: ClaudeStatusEvent): SessionStatus {
  const ptyId = event.ptyId;
  switch (event.status) {
    case 'busy':
      return { activity: 'busy', waitingFor: null, ptyId };
    case 'waiting':
      return { activity: 'waiting', waitingFor: event.waitingFor, ptyId };
    case 'idle':
      return { activity: 'idle', waitingFor: null, ptyId };
    default:
      return { activity: 'gone', waitingFor: null, ptyId: null };
  }
}

const UNKNOWN: SessionStatus = { activity: 'unknown', waitingFor: null, ptyId: null };

/**
 * Live status of the Claude process that runs `sessionId`, from the same events that drive the
 * terminal tab badges. `gone` when no running process has that session.
 */
export function useSessionActivity(sessionId: string | null): SessionStatus {
  const [status, setStatus] = useState<{ sessionId: string | null; value: SessionStatus }>({ sessionId, value: UNKNOWN });

  useEffect(() => {
    if (!sessionId) return;
    const api = terminalApi();
    let live = false;
    const off = api.onClaudeStatus((event) => {
      if (event.sessionId !== sessionId) return;
      live = true;
      setStatus({ sessionId, value: fromEvent(event) });
    });
    void api
      .claudeSnapshot()
      .then((events) => {
        if (live) return;
        const event = events.find((e) => e.sessionId === sessionId);
        setStatus({ sessionId, value: event ? fromEvent(event) : { activity: 'gone', waitingFor: null, ptyId: null } });
      })
      .catch(() => undefined);
    return off;
  }, [sessionId]);

  return status.sessionId === sessionId ? status.value : UNKNOWN;
}
