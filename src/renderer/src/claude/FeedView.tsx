import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FeedItem } from '@shared/claude';
import { ToolCard } from './FeedCards';
import { Icon } from './FeedIcons';
import { FeedMarkdown } from './FeedMarkdown';
import { canLoadEarlier, endsMidTurn, groupFeed, lastPromptAt, runningCall, taskList, taskNotices } from './feedModel';
import { FeedContext, ToolGroup } from './FeedTool';
import type { FeedContextValue } from './FeedTool';
import { phraseText, toolPhrase } from './feedTools';
import type { ToolItem } from './feedTools';
import { useFeed } from './useFeed';
import { useSessionActivity } from './useSessionActivity';
import logoUrl from '../../../../design/empty-mark.svg';
import './feed.css';

/** Distance from the bottom, in pixels, that still counts as "at the bottom" for auto-scroll. */
const STICK_PX = 48;
/** Prompts longer than this are clamped until expanded. */
const LONG_PROMPT_CHARS = 1200;

function clock(at: string | null): string {
  if (!at) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "Today 14:05", "Yesterday 09:12" or "Mon, Oct 13 14:05", for dividers. */
function dividerTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const time = clock(at);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

function Thumbs({ thumbs, images }: { thumbs: readonly string[]; images: number }) {
  const [zoom, setZoom] = useState<string | null>(null);
  const rest = images - thumbs.length;
  return (
    <div className="fd-thumbs">
      {thumbs.map((src, i) => (
        <button key={i} type="button" className="fd-thumb" onClick={() => setZoom(zoom === src ? null : src)} title="Show larger">
          <img src={src} alt={`Attached image ${i + 1}`} />
        </button>
      ))}
      {rest > 0 && (
        <span className="fd-chip">
          <Icon name="image" />
          {rest === 1 ? '1 image' : `${rest} images`}
        </span>
      )}
      {zoom && (
        <button type="button" className="fd-zoom" onClick={() => setZoom(null)} title="Close">
          <img src={zoom} alt="Attached image" />
        </button>
      )}
    </div>
  );
}

function UserTurn({ text, images, thumbs, at }: { text: string; images: number; thumbs: readonly string[]; at: string | null }) {
  const long = text.length > LONG_PROMPT_CHARS || text.split('\n').length > 24;
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="fd-user">
      <div className="fd-bubble">
        {images > 0 && <Thumbs thumbs={thumbs} images={images} />}
        {text && <div className={`fd-user-text${long && !expanded ? ' clamped' : ''}`}>{text}</div>}
        {long && (
          <button type="button" className="fd-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      <span className="fd-time">{clock(at)}</span>
    </div>
  );
}

/** "just now", "5m ago", "3h ago", else the clock time. */
export function relativeTime(at: string | null, now: number): string {
  if (!at) return '';
  const then = Date.parse(at);
  if (Number.isNaN(then)) return '';
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return dividerTime(at);
}

/** Under an assistant message: copy its Markdown and when it was written; shown on hover. */
function MessageMeta({ text, at, now }: { text: string; at: string | null; now: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fd-meta">
      <button
        type="button"
        className={`fd-meta-btn${copied ? ' copied' : ''}`}
        title="Copy message"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} />
      </button>
      <span title={at ? new Date(at).toLocaleString() : undefined}>{relativeTime(at, now)}</span>
    </div>
  );
}

const Item = memo(function Item({ item, root, now }: { item: Exclude<FeedItem, ToolItem>; root: string; now: number }) {
  switch (item.kind) {
    case 'user':
      return <UserTurn text={item.text} images={item.images} thumbs={item.thumbs ?? []} at={item.at} />;
    case 'assistant':
      return (
        <div className="fd-assistant">
          <FeedMarkdown text={item.text} root={root} />
          <MessageMeta text={item.text} at={item.at} now={now} />
        </div>
      );
    case 'command':
      return (
        <div className="fd-user command">
          <div className="fd-bubble">
            <code>{item.text}</code>
          </div>
          <span className="fd-time">{clock(item.at)}</span>
        </div>
      );
    case 'notice':
      return (
        <div className={`fd-notice${item.task ? ' task' : ''}`}>
          <span>{item.text}</span>
        </div>
      );
  }
});

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The pulsing spark under the last message while the session is mid-turn, with the time since the
 * turn started and what runs now; "Waiting for you" when Claude needs an answer or a permission.
 */
function Working({ label, waiting, since }: { label: string | null; waiting: string | null; since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const start = since ? Date.parse(since) : Number.NaN;
  const time = Number.isNaN(start) ? null : elapsed(now - start);
  return (
    <div className={`fd-working${waiting !== null ? ' waiting' : ''}`}>
      <span className="fd-working-mark">
        <Icon name="spark" />
      </span>
      <span className="fd-working-text">{waiting !== null ? `Waiting for you${waiting ? `: ${waiting}` : ''}` : 'Working'}</span>
      {time && <span className="fd-working-detail">{time}</span>}
      {label && waiting === null && <span className="fd-working-detail">· {label}</span>}
    </div>
  );
}

interface Props {
  projectRoot: string;
  /** Session to show: the active Claude tab's, or the last one this window showed. */
  sessionId: string | null;
  /** True while the feed tab is the visible viewer tab; live reads pause otherwise. */
  visible: boolean;
  /** Shown under the empty-state text when there is no session. */
  empty?: ReactNode;
}

/** The pinned "Claude" viewer tab: a readable live view of the active Claude session. */
export function FeedView({ projectRoot, sessionId, visible, empty }: Props) {
  const { state, loadEarlier, loadingEarlier } = useFeed(sessionId, visible);
  const status = useSessionActivity(sessionId);
  const items = state?.items;
  const results = state?.results;
  const blocks = useMemo(() => groupFeed(items ?? []), [items]);
  const notices = useMemo(() => taskNotices(items ?? []), [items]);
  const tasks = useMemo(() => taskList(items ?? [], results ?? {}), [items, results]);
  const context = useMemo<FeedContextValue>(
    () => ({ root: projectRoot, results: results ?? {}, notices, activity: status.activity }),
    [projectRoot, results, notices, status.activity],
  );

  // Relative times under messages refresh twice a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Mid-turn: the live process says so, or (before its first status) the transcript ends mid-turn.
  const working = status.activity === 'busy' || status.activity === 'waiting' || (status.activity === 'unknown' && endsMidTurn(items ?? []));
  const running = useMemo(
    () => (working && items && results ? runningCall(items, results, notices, status.activity) : null),
    [working, items, results, notices, status.activity],
  );
  const current = running ? phraseText(toolPhrase(running, undefined), true) : null;
  const turnStart = useMemo(() => (working && items ? lastPromptAt(items) : null), [working, items]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prepend = useRef<{ start: number; fromBottom: number } | null>(null);
  const showList = Boolean(sessionId && state?.loaded && state.found && (state.items.length > 0 || state.start > 0));

  // A new session starts at the bottom; a scroll anchor saved for "load earlier" belongs to the old one.
  useEffect(() => {
    stick.current = true;
    prepend.current = null;
  }, [sessionId]);

  // Keep the bottom in view while it is in view: new items, highlighted code, expanded tools.
  useEffect(() => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(list);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [showList]);

  // After "load earlier" keep the same messages on screen instead of jumping.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const saved = prepend.current;
    if (!scroller || !state) return;
    if (saved && state.start < saved.start) {
      scroller.scrollTop = scroller.scrollHeight - saved.fromBottom;
      prepend.current = null;
    } else if (stick.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [state]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  const onLoadEarlier = (): void => {
    const el = scrollRef.current;
    if (el && state) prepend.current = { start: state.start, fromBottom: el.scrollHeight - el.scrollTop };
    loadEarlier();
  };

  let message: ReactNode = null;
  if (!sessionId) {
    message = (
      <>
        <p className="fd-empty-text">No Claude session in this window yet. Start Claude in the terminal and its conversation shows up here.</p>
        {empty}
      </>
    );
  } else if (!state || !state.loaded) message = <p className="fd-empty-text">Loading…</p>;
  else if (!state.found) message = <p className="fd-empty-text">Waiting for the session's first message…</p>;
  else if (!showList) message = <p className="fd-empty-text">No messages yet.</p>;

  return (
    <div className="fd-root">
      {!message && <img className="fd-logo" src={logoUrl} alt="" draggable={false} />}
      {message ? (
        <div className="fd-empty">{message}</div>
      ) : (
        <div className="fd-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="fd-list" ref={listRef}>
            {state && canLoadEarlier(state) && (
              <button type="button" className="fd-earlier" onClick={onLoadEarlier} disabled={loadingEarlier}>
                {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
              </button>
            )}
            <FeedContext.Provider value={context}>
              {blocks.map((block) => {
                switch (block.type) {
                  case 'tools':
                    return <ToolGroup key={block.id} items={block.items} />;
                  case 'card':
                    return <ToolCard key={block.item.id} item={block.item} tasks={tasks} />;
                  case 'divider':
                    return (
                      <div key={block.id} className="fd-divider">
                        <span>{dividerTime(block.at)}</span>
                      </div>
                    );
                  default:
                    return <Item key={block.item.id} item={block.item} root={projectRoot} now={now} />;
                }
              })}
            </FeedContext.Provider>
            {working && <Working label={current} since={turnStart} waiting={status.activity === 'waiting' ? (status.waitingFor ?? '') : null} />}
          </div>
        </div>
      )}
    </div>
  );
}
