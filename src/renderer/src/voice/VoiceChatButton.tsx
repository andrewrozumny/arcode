import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TerminalTab } from '../terminal/types';
import { loadDictationMode, saveDictationMode, VOICE_MODES } from './answer';
import type { DictationMode, VoiceMode } from './answer';
import { useChatStream } from './chatStream';
import { TTS_ENGINES } from '@shared/voice';
import type { TtsEngine, TtsInfo } from '@shared/voice';
import { ENGINE_LABEL, loadReadingChoice, readingVoice, saveReadingChoice } from './reading';
import type { ReadingChoice } from './reading';
import { useVoiceChat } from './useVoiceChat';
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
      ? { ptyId: tab.ptyId, status: tab.claudeStatus, title: tab.title, sessionId: tab.claude?.sessionId ?? null }
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
  speaking: 'Reading the answer',
  paused: 'Paused',
  error: 'Voice chat error',
};

/** Small mark on the button: which mode it is in. */
function ModeMark({ mode }: { mode: VoiceMode }) {
  if (mode === 'dictate') {
    return (
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2 2.5h8M6 2.5v7.5M4.5 10h3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (mode === 'command') {
    return (
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M10 2v4.5H3M5 4.5 3 6.5l2 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1.5 4.5h2l3-2.5v8l-3-2.5h-2zM8.5 4a2.5 2.5 0 0 1 0 4M9.8 2.5a4.5 4.5 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Speech bubble: the live chat button. */
function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" fill="currentColor" />
      <path d="M8.5 9.5h.01M12 9.5h.01M15.5 9.5h.01" stroke="var(--bg-panel)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M8.5 21h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A voice button. Both kinds only listen while this ARcode window is the active one, and only one
 * of them has the microphone at a time.
 * - `live`: the floating live chat (Cmd+Shift+Space). Talk, Claude answers aloud message by message,
 *   and a window next to it shows the conversation as it goes. Its mark picks the reading voice. Drag it anywhere.
 * - `dictation`: sits in the corner of the terminal, next to Claude's prompt (Cmd+Shift+D). Its
 *   mark picks between typing into the prompt and sending each phrase.
 */
export function VoiceChatButton({ kind, tabs, activeTab }: { kind: 'live' | 'dictation'; tabs: readonly TerminalTab[]; activeTab: TerminalTab | null }) {
  const live = kind === 'live';
  const target = useMemo(() => voiceTarget(tabs, activeTab), [tabs, activeTab]);
  const [dictationMode, setDictationMode] = useState<DictationMode>(loadDictationMode);
  const mode: VoiceMode = live ? 'chat' : dictationMode;
  const [menuOpen, setMenuOpen] = useState(false);
  const [readingChoice, setReadingChoice] = useState<ReadingChoice>(loadReadingChoice);
  const [ttsInfo, setTtsInfo] = useState<TtsInfo | null>(null);
  const reading = useMemo(() => readingVoice(readingChoice, ttsInfo), [readingChoice, ttsInfo]);
  const { phase, level, error, lastSent, reason, claudeWorking, on, say, toggle, dismissError } = useVoiceChat(target, mode, reading, kind);
  const chat = useChatStream(live ? (target?.sessionId ?? null) : null, live && on, say);
  const [chatOpen, setChatOpen] = useState(true);
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = chatRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat, chatOpen]);

  // Which reading engines work here: asked once, and again whenever the menu opens (a key may have been added).
  const infoAsked = useRef(false);
  useEffect(() => {
    if (infoAsked.current && !menuOpen) return;
    infoAsked.current = true;
    let live = true;
    void window.acode.voice
      .ttsInfo()
      .then((info) => {
        if (live) setTtsInfo(info);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [menuOpen]);

  const pickReading = (engine: TtsEngine, voice?: string): void => {
    const next: ReadingChoice = { engine, voices: voice ? { ...readingChoice.voices, [engine]: voice } : readingChoice.voices };
    setReadingChoice(next);
    saveReadingChoice(next);
  };
  const cloud = mode === 'chat' && reading.engine === 'elevenlabs';
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const pickMode = (next: DictationMode): void => {
    setDictationMode(next);
    saveDictationMode(next);
    setMenuOpen(false);
  };
  const [offset, setOffset] = useState<Offset | null>(() => (live ? loadOffset() : { right: 0, bottom: 0 }));
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
      const key = live ? 'Space' : 'KeyD';
      if (event.code === key && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggle, live]);

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
      if (!live) {
        drag.current = { x: event.clientX, y: event.clientY, start: offset, moved: false };
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, start: offset, moved: false };
    },
    [offset, live],
  );
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    if (!d || !live) return;
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
  const place = live ? clampOffset(offset) : null;
  const modeInfo = VOICE_MODES.find((m) => m.mode === mode) ?? VOICE_MODES[1];
  const sent = lastSent && now - lastSent.at < SENT_MS ? lastSent.text : null;
  const working = claudeWorking && (phase === 'listening' || phase === 'hearing' || phase === 'claude');
  const note =
    phase === 'error'
      ? error
      : phase === 'paused'
        ? reason
        : sent && phase !== 'off'
          ? sent
          : working && mode !== 'dictate'
            ? 'Claude is working; what you say now is queued'
            : null;
  const showBubble = phase !== 'off' || !!error;
  const shortcut = live ? 'Cmd+Shift+Space' : 'Cmd+Shift+D';
  const action = phase === 'speaking' ? 'Click to stop reading' : `Click to turn ${phase === 'off' || phase === 'error' ? 'on' : 'off'} (${shortcut})`;
  const extra = live ? 'right click for the voice, drag to move' : 'right click for the mode';
  const title = `${modeInfo?.label ?? ''}: ${LABEL[phase]}${note ? `, ${note}` : ''}. ${action}, ${extra}${target ? `. Talks to "${target.title}"` : ''}`;
  // Ring grows with the voice so it is clear the microphone hears you.
  const ring = phase === 'listening' || phase === 'hearing' ? Math.min(1, level * 12) : 0;

  return (
    <div
      className={live ? 'vc-root vc-live' : 'vc-root vc-docked'}
      ref={rootRef}
      style={place ? { right: place.right, bottom: place.bottom } : undefined}
    >
      {live && on && chatOpen && (
        <div className="vc-chat" role="log" aria-label="Live chat">
          <div className="vc-chat-head">
            <span>Live chat{target ? ` · ${target.title}` : ''}</span>
            <button type="button" className="vc-chat-close" title="Hide the chat window" onClick={() => setChatOpen(false)}>
              ×
            </button>
          </div>
          <div className="vc-chat-list" ref={chatRef}>
            {chat.length === 0 && <div className="vc-chat-empty">Say something; Claude's answers appear here and are read aloud.</div>}
            {chat.map((entry) => (
              <div key={entry.id} className={`vc-chat-line vc-chat-${entry.role}`}>
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      )}
      {menuOpen && (
        <div className="vc-menu" role="menu" aria-label={live ? 'Reading voice' : 'Dictation mode'}>
          {!live && VOICE_MODES.filter((m) => m.mode !== 'chat').map((m) => (
            <button
              key={m.mode}
              type="button"
              role="menuitemradio"
              aria-checked={m.mode === mode}
              className={m.mode === mode ? 'vc-menu-item current' : 'vc-menu-item'}
              onClick={() => pickMode(m.mode as DictationMode)}
            >
              <span className="vc-menu-mark">
                <ModeMark mode={m.mode} />
              </span>
              <span className="vc-menu-text">
                <span className="vc-menu-label">{m.label}</span>
                <span className="vc-menu-hint">{m.hint}</span>
              </span>
            </button>
          ))}
          {live && <div className="vc-menu-section">Read Claude's messages with</div>}
          {live && !chatOpen && on && (
            <button type="button" className="vc-menu-item" onClick={() => {
                setChatOpen(true);
                setMenuOpen(false);
              }}
            >
              <span className="vc-menu-text">
                <span className="vc-menu-label">Show the chat window</span>
              </span>
            </button>
          )}
          {live && TTS_ENGINES.map((engine) => {
            const info = ttsInfo?.[engine];
            const current = reading.engine === engine;
            return (
              <div key={engine} className={current ? 'vc-engine current' : 'vc-engine'}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  className="vc-engine-name"
                  disabled={!info?.available}
                  title={info?.available ? undefined : info?.reason}
                  onClick={() => pickReading(engine)}
                >
                  {ENGINE_LABEL[engine]}
                  {!info?.available && <span className="vc-menu-hint"> · not set up</span>}
                </button>
                {current && info && info.voices.length > 1 && (
                  <select
                    className="vc-voice-select"
                    value={reading.voice}
                    aria-label="Voice"
                    onChange={(event) => pickReading(engine, event.target.value)}
                  >
                    {info.voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                        {v.description ? ` (${v.description})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showBubble && (
        <div className={`vc-bubble vc-${phase}`} role="status">
          <span className="vc-bubble-label">
            {modeInfo?.label} · {LABEL[phase]}
          </span>
          {note && <span className="vc-bubble-note">{note}</span>}
          {error && phase !== 'error' && (
            <button type="button" className="vc-bubble-error" onClick={dismissError} title="Dismiss">
              {error}
            </button>
          )}
        </div>
      )}
      <span className="vc-anchor">
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
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen((v) => !v);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
      >
        <span className="vc-ring" aria-hidden="true" />
        {phase === 'transcribing' || phase === 'starting' ? <span className="vc-spinner" aria-hidden="true" /> : live ? <ChatIcon /> : <MicIcon />}
      </button>
      <button
        type="button"
        className={`vc-mode vc-mode-${mode}`}
        title={live ? 'Reading voice' : `Mode: ${modeInfo?.label ?? ''}. Click to change`}
        aria-label={live ? 'Reading voice' : `Voice mode: ${modeInfo?.label ?? ''}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <ModeMark mode={mode} />
      </button>
      {cloud && (
        <span className="vc-cloud" title="Answers are read by ElevenLabs: their text (without code) goes to the cloud">
          cloud
        </span>
      )}
      </span>
    </div>
  );
}
