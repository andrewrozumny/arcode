import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TerminalTab } from '../terminal/types';
import { pauseReason, useVoiceChat } from './useVoiceChat';
import type { VoicePhase, VoiceTarget } from './useVoiceChat';
import './voice.css';

const SIZE = 44;
const MARGIN = 8;
const DRAG_PX = 4;
const STORAGE_KEY = 'arcode.voiceChat.position';
/** How long the last sent phrase stays next to the button. */
const SENT_MS = 4000;

/** Distance of the button from the window's right and bottom edges, so it stays put on resize. */
interface Offset {
  right: number;
  bottom: number;
}

function loadOffset(): Offset | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;
    if (raw && typeof raw === 'object' && 'right' in raw && 'bottom' in raw) {
      const { right, bottom } = raw as Record<string, unknown>;
      if (typeof right === 'number' && typeof bottom === 'number' && Number.isFinite(right) && Number.isFinite(bottom)) {
        return { right, bottom };
      }
    }
  } catch {
    // No storage, or a broken value: fall back to the default spot.
  }
  return null;
}

function saveOffset(offset: Offset): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // Position is a convenience; losing it is fine.
  }
}

/** Default spot: just above the arCode mark in the bottom right corner of the viewer. */
function defaultOffset(): Offset {
  const pane = document.querySelector('.viewer-pane')?.getBoundingClientRect();
  if (!pane) return { right: 40, bottom: 260 };
  // The mark is 36 px wide, 22 px from the pane's right edge and 18 px from its bottom.
  return {
    right: window.innerWidth - pane.right + 22 + (36 - SIZE) / 2,
    bottom: window.innerHeight - pane.bottom + 18 + 36 + 10,
  };
}

function clampOffset(offset: Offset): Offset {
  return {
    right: Math.min(Math.max(MARGIN, offset.right), window.innerWidth - SIZE - MARGIN),
    bottom: Math.min(Math.max(MARGIN, offset.bottom), window.innerHeight - SIZE - MARGIN),
  };
}

/** The tab to talk to: the active tab when it is a Claude tab, else the last Claude tab with a terminal. */
export function voiceTarget(tabs: readonly TerminalTab[], activeTab: TerminalTab | null): VoiceTarget | null {
  const pick = (tab: TerminalTab | null | undefined): VoiceTarget | null =>
    tab && tab.kind === 'claude' && tab.ptyId !== undefined && !tab.exited
      ? { ptyId: tab.ptyId, status: tab.claudeStatus, title: tab.title }
      : null;
  return pick(activeTab) ?? pick([...tabs].reverse().find((t) => pick(t) !== null));
}

const LABEL: Record<VoicePhase, string> = {
  off: 'Talk to Claude',
  starting: 'Opening the microphone',
  listening: 'Listening',
  hearing: 'Hearing you',
  transcribing: 'Recognising',
  claude: 'Claude is answering',
  paused: 'Paused',
  error: 'Voice chat error',
};

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M8.5 21h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Floating microphone for a spoken conversation with Claude. Click (or Cmd+Shift+Space) turns it on
 * and off; drag it anywhere in the window. While on it listens, sends each phrase after a pause to
 * the Claude tab and waits for Claude to finish before listening again.
 */
export function VoiceChatButton({ tabs, activeTab }: { tabs: readonly TerminalTab[]; activeTab: TerminalTab | null }) {
  const target = useMemo(() => voiceTarget(tabs, activeTab), [tabs, activeTab]);
  const { phase, level, error, lastSent, toggle, dismissError } = useVoiceChat(target);
  const [offset, setOffset] = useState<Offset | null>(loadOffset);
  const drag = useRef<{ x: number; y: number; start: Offset; moved: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The default spot depends on the layout, so it is measured once the window is laid out.
  useEffect(() => {
    if (offset) return;
    const frame = requestAnimationFrame(() => setOffset(defaultOffset()));
    return () => cancelAnimationFrame(frame);
  }, [offset]);

  // Keep the button inside the window when it shrinks.
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = (): void => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Space' && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggle]);

  useEffect(() => {
    if (!lastSent) return;
    const left = lastSent.at + SENT_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), left + 20);
    return () => window.clearTimeout(timer);
  }, [lastSent]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !offset) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, start: offset, moved: false };
    },
    [offset],
  );
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    d.moved = true;
    setOffset(clampOffset({ right: d.start.right - dx, bottom: d.start.bottom - dy }));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!d) return;
    if (d.moved && offset) saveOffset(offset);
    else toggle();
  };

  if (!offset) return null;
  const place = clampOffset(offset);
  const reason = phase === 'paused' ? pauseReason(target) : null;
  const sent = lastSent && now - lastSent.at < SENT_MS ? lastSent.text : null;
  const note = phase === 'error' ? error : (reason ?? (phase === 'claude' && sent ? sent : null));
  const showBubble = phase !== 'off' || !!error;
  const title = `${LABEL[phase]}${note ? `: ${note}` : ''}. Click to turn ${phase === 'off' || phase === 'error' ? 'on' : 'off'} (Cmd+Shift+Space), drag to move${target ? `. Talks to "${target.title}"` : ''}`;
  // Ring grows with the voice so it is clear the microphone hears you.
  const ring = phase === 'listening' || phase === 'hearing' ? Math.min(1, level * 12) : 0;

  return (
    <div className="vc-root" style={{ right: place.right, bottom: place.bottom }}>
      {showBubble && (
        <div className={`vc-bubble vc-${phase}`} role="status">
          <span className="vc-bubble-label">{LABEL[phase]}</span>
          {note && <span className="vc-bubble-note">{note}</span>}
          {error && phase !== 'error' && (
            <button type="button" className="vc-bubble-error" onClick={dismissError} title="Dismiss">
              {error}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className={`vc-button vc-${phase}`}
        style={{ ['--vc-ring' as string]: String(ring) }}
        title={title}
        aria-label={title}
        aria-pressed={phase !== 'off' && phase !== 'error'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="vc-ring" aria-hidden="true" />
        {phase === 'transcribing' || phase === 'starting' ? <span className="vc-spinner" aria-hidden="true" /> : <MicIcon />}
      </button>
    </div>
  );
}
