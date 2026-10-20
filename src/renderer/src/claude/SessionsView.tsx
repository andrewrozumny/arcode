import { useEffect, useState } from 'react';
import type { SessionSummary } from '@shared/claude';
import { bus } from '../bus';
import { formatAge, formatCount, formatLocalTime } from '../format';
import { Icon } from './FeedIcons';
import { matchesQuery } from './model';
import { openSessionFeed } from './openFeed';
import { usePanel } from './panelData';
import { sessionBuckets, sessionTitle } from './panelModel';
import { CopyButton, EmptyState, NoMatches, Notice, Toolbar } from './ui';

export function resumeSession(session: SessionSummary): void {
  bus.emit('focusPanel', { panel: 'terminal' });
  bus.emit('resumeClaude', { sessionId: session.sessionId, name: sessionTitle(session).slice(0, 40) });
}

export function newClaudeTab(): void {
  bus.emit('focusPanel', { panel: 'terminal' });
  bus.emit('newClaude');
}

/** Clock for relative times, ticking once a minute rather than reading Date.now() during render. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** One past session: its title (saved or first prompt), when it was active, Open and Resume buttons. */
export function SessionRow({ session, now, latest }: { session: SessionSummary; now: number; latest?: boolean }) {
  const started = session.startedAt ? `started ${formatLocalTime(session.startedAt)}` : null;
  return (
    <div className="cl-item session">
      <div className="cl-item-head">
        <span className="cl-item-icon">
          <Icon name="chat" />
        </span>
        <div className="cl-item-body">
          <div className="cl-item-title">
            <span className={session.title || session.firstPrompt ? 'cl-name' : 'cl-name untitled'} title={session.firstPrompt ?? undefined}>
              {sessionTitle(session)}
            </span>
            {latest && <span className="cl-badge accent">Latest</span>}
          </div>
          <div className="cl-item-meta plain">
            <span title={formatLocalTime(session.lastActiveAt)}>{formatAge(session.lastActiveAt, now)}</span>
            <span className="cl-dot">·</span>
            {formatCount(session.messages)} messages
            {started && (
              <>
                <span className="cl-dot">·</span>
                {started}
              </>
            )}
          </div>
        </div>
        <div className="cl-item-actions">
          <CopyButton text={session.sessionId} label="Copy session id" />
          <button
            type="button"
            className="cl-btn"
            onClick={() => openSessionFeed(session.sessionId, sessionTitle(session))}
            title="Read this session in a viewer tab"
          >
            <Icon name="chat" />
            Open
          </button>
          <button type="button" className="cl-btn resume" onClick={() => resumeSession(session)} title="Continue this session in a new Claude tab">
            <Icon name="play" />
            Resume
          </button>
        </div>
      </div>
    </div>
  );
}

/** Past sessions of the project, newest first, grouped by day. Resume opens a terminal tab that continues one. */
export function SessionsView() {
  const { sessions } = usePanel();
  const [query, setQuery] = useState('');
  const now = useMinuteClock();
  const list = sessions.data ?? [];
  const visible = list.filter((s) => matchesQuery([s.title, s.firstPrompt, s.sessionId], query));
  const newest = list[0]?.sessionId;

  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Filter sessions by what you asked">
        <button type="button" className="cl-btn" onClick={newClaudeTab}>
          <Icon name="plus" />
          New Claude tab
        </button>
      </Toolbar>
      {sessions.error && <Notice tone="error">Could not read sessions: {sessions.error}</Notice>}
      {!sessions.error && sessions.data === null && <Notice>Loading…</Notice>}
      {sessions.data?.length === 0 && (
        <EmptyState
          icon="chat"
          title="No sessions in this project yet"
          action={
            <button type="button" className="cl-btn primary" onClick={newClaudeTab}>
              <Icon name="plus" />
              Start Claude
            </button>
          }
        >
          <p>Every conversation you have with Claude Code in this folder is saved as a session. They show up here so you can find one by what you asked and resume it.</p>
        </EmptyState>
      )}
      {list.length > 0 && visible.length === 0 && <NoMatches query={query} onClear={() => setQuery('')} />}
      {sessionBuckets(visible, now).map((bucket) => (
        <section key={bucket.label} className="cl-group">
          <h3 className="cl-group-title">
            {bucket.label} <span className="cl-count">{bucket.sessions.length}</span>
          </h3>
          <div className="cl-list">
            {bucket.sessions.map((s) => (
              <SessionRow key={s.sessionId} session={s} now={now} latest={s.sessionId === newest} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
