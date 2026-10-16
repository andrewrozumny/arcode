import { useEffect, useState } from 'react';
import type { SessionSummary } from '@shared/claude';
import { bus } from '../bus';
import { formatAge, formatCount } from '../format';
import { matchesQuery } from './model';
import { claudeApi } from './api';

/** Past sessions of the project, newest first. Resume opens a terminal tab that continues one. */
export function SessionsView({ root }: { root: string }) {
  const [query, setQuery] = useState('');
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    claudeApi().sessions(root).then(
      (list) => {
        if (!live) return;
        setSessions(list);
        setError(null);
      },
      (err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      live = false;
    };
  }, [root, tick]);

  const resume = (session: SessionSummary): void => {
    bus.emit('focusPanel', { panel: 'terminal' });
    bus.emit('resumeClaude', { sessionId: session.sessionId, name: session.firstPrompt ?? 'Claude' });
  };

  const visible = (sessions ?? []).filter((s) => matchesQuery([s.firstPrompt, s.sessionId], query));

  return (
    <>
      <div className="cl-toolbar">
        <input
          className="cl-search"
          type="search"
          value={query}
          placeholder="Filter sessions"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="cl-btn" onClick={() => setTick((t) => t + 1)}>
          Refresh
        </button>
      </div>
      {error && <div className="cl-notice">{error}</div>}
      {!error && sessions === null && <div className="cl-notice">Loading…</div>}
      {sessions?.length === 0 && <div className="cl-notice">No past sessions in this project yet.</div>}
      {sessions && sessions.length > 0 && visible.length === 0 && (
        <div className="cl-notice">Nothing matches “{query.trim()}”.</div>
      )}
      <div className="cl-list">
        {visible.map((s) => (
          <div key={s.sessionId} className="cl-row">
            <div className="cl-row-main">
              <span className="cl-name" title={s.firstPrompt ?? undefined}>
                {s.firstPrompt ?? 'Untitled session'}
              </span>
              <button type="button" className="cl-btn primary" onClick={() => resume(s)}>
                Resume
              </button>
            </div>
            <div className="cl-path">
              {formatAge(s.lastActiveAt)} · {formatCount(s.messages)} messages · {s.sessionId.slice(0, 8)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
