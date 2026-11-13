import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { bus } from '../bus';
import type { TerminalTab } from '../terminal/types';
import { loadDictationMode, saveDictationMode, VOICE_MODES } from './answer';
import type { DictationMode, VoiceMode } from './answer';
import { loadDiscussionModel, loadReadAloud, MODEL_LABEL, saveDiscussionModel, saveReadAloud, useDiscussion } from './discussion';
import type { HandoverTarget } from './discussion';
import { readScreen } from '../terminal/ptyScreens';
import { DISCUSSION_MODELS, TTS_ENGINES } from '@shared/voice';
import type { DiscussionModel, TtsEngine, TtsInfo, TtsUsage } from '@shared/voice';
import { ENGINE_LABEL, loadReadingChoice, readingVoice, saveReadingChoice, usageFraction, usageLabel } from './reading';
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

/** Outer size of the usage ring in CSS pixels: the 44 px button plus an 8 px gap on each side. */
const RING_SIZE = 60;
const RING_STROKE = 2;
/** Radius in whole pixels: the 2 px stroke covers exactly the pixels 28 to 30 from the centre, so it stays crisp. */
const RING_RADIUS = RING_SIZE / 2 - RING_STROKE / 2;

/**
 * The ElevenLabs allowance around the button, drawn at its real pixel size (no scaling): a faint
 * track that fills with the accent colour as characters are used, from the top, clockwise.
 */
export function UsageRing({ used }: { used: number }) {
  const centre = RING_SIZE / 2;
  const length = 2 * Math.PI * RING_RADIUS;
  // Round caps add half a stroke at each end: take them off the arc so a full ring meets exactly.
  const arc = Math.max(0, length * Math.min(1, used) - (used < 1 ? RING_STROKE : 0));
  return (
    <svg
      className="vc-usage-ring"
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
    >
      <circle cx={centre} cy={centre} r={RING_RADIUS} className="vc-usage-track" />
      {used > 0.002 && (
        <circle
          cx={centre}
          cy={centre}
          r={RING_RADIUS}
          className="vc-usage-used"
          strokeDasharray={`${arc} ${length}`}
          transform={`rotate(-90 ${centre} ${centre})`}
        />
      )}
    </svg>
  );
}

/**
 * "Claude is thinking": a small coral spark of eight rounded rays of different lengths that turns and
 * breathes. Shown while an answer has no text yet, and after a pause of more than a second in a
 * streaming answer (the partner reading a file); it goes away as soon as text comes.
 */
export function ThinkingSpark({ idle, textLength }: { idle: boolean; textLength: number }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (idle) return;
    // Text just arrived: hide the spark, and show it again only if nothing more comes for a while.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the streamed text
    setPaused(false);
    const timer = window.setTimeout(() => setPaused(true), 1200);
    return () => window.clearTimeout(timer);
  }, [idle, textLength]);
  if (!idle && !paused) return null;
  const rays = [
    [0, 7],
    [45, 4.6],
    [90, 6.2],
    [135, 4.2],
    [180, 7],
    [225, 4.6],
    [270, 6.2],
    [315, 4.2],
  ] as const;
  return (
    <span className={idle ? 'vc-thinking' : 'vc-thinking inline'} role="status" aria-label="Claude is thinking">
      <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
        {rays.map(([angle, length]) => (
          <line key={angle} x1="0" y1="-1.6" x2="0" y2={-length} transform={`rotate(${angle})`} />
        ))}
      </svg>
      {idle && <span className="vc-thinking-label">Thinking</span>}
    </span>
  );
}

/** Reading aloud on (sound waves) or off (a cross), for the discussion window's header. */
function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" />
      {on ? (
        <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      ) : (
        <path d="M10.5 6l4 4M14.5 6l-4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** Speech bubble: the live chat button. */
/** Heights of the waveform bars of the voice discussion icon, in a 24 px box. */
export const WAVE_BARS = [6, 12, 17, 11, 5] as const;

/**
 * The voice discussion icon: five rounded bars of a sound wave. `live` makes them move (while you
 * talk or an answer is read).
 */
export function WaveIcon({ size = 20, live = false }: { size?: number; live?: boolean }) {
  return (
    <svg className={live ? 'vc-wave live' : 'vc-wave'} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {WAVE_BARS.map((height, i) => {
        const x = 4 + i * 4;
        return <line key={x} x1={x} x2={x} y1={12 - height / 2} y2={12 + height / 2} style={{ animationDelay: `${i * -0.18}s` }} />;
      })}
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
export function VoiceChatButton({
  kind,
  projectRoot,
  tabs,
  activeTab,
  discussionSlot = null,
}: {
  kind: 'live' | 'dictation';
  projectRoot: string;
  tabs: readonly TerminalTab[];
  activeTab: TerminalTab | null;
  /** The discussion column on the right of the viewer: the discussion renders into it. */
  discussionSlot?: HTMLElement | null;
}) {
  const live = kind === 'live';
  const target = useMemo(() => voiceTarget(tabs, activeTab), [tabs, activeTab]);
  const [dictationMode, setDictationMode] = useState<DictationMode>(loadDictationMode);
  const mode: VoiceMode = live ? 'chat' : dictationMode;
  const [menuOpen, setMenuOpen] = useState(false);
  const [readingChoice, setReadingChoice] = useState<ReadingChoice>(loadReadingChoice);
  const [ttsInfo, setTtsInfo] = useState<TtsInfo | null>(null);
  const reading = useMemo(() => readingVoice(readingChoice, ttsInfo), [readingChoice, ttsInfo]);
  // Reading aloud can be switched off: the discussion goes on, the answers are only shown.
  const [readAloud, setReadAloud] = useState(loadReadAloud);
  const readAloudRef = useRef(readAloud);
  useEffect(() => {
    readAloudRef.current = readAloud;
  }, [readAloud]);
  // The live chat is a discussion with a partner that reads the Claude Code session but never writes to it.
  const sayRef = useRef<(text: string) => void>(() => undefined);
  const onSentence = useCallback((sentence: string) => {
    if (readAloudRef.current) sayRef.current(sentence);
  }, []);
  // Where a handed-over task goes, read when it is sent: the Claude tab, its status and any unsent text in its prompt.
  const targetForHandover = useRef<VoiceTarget | null>(null);
  useEffect(() => {
    targetForHandover.current = target;
  }, [target]);
  const handoverTarget = useCallback((): HandoverTarget | null => {
    const current = targetForHandover.current;
    if (!current) return null;
    return { ptyId: current.ptyId, status: current.status, draft: readScreen(current.ptyId)?.draft ?? '' };
  }, []);
  const [discussionModel, setDiscussionModel] = useState<DiscussionModel>(loadDiscussionModel);
  const discussion = useDiscussion({
    projectRoot,
    sessionId: target?.sessionId ?? null,
    onSentence,
    handoverTarget,
    model: discussionModel,
    enabled: live,
  });
  const sendRef = useRef(discussion.send);
  useEffect(() => {
    sendRef.current = discussion.send;
  }, [discussion.send]);
  const onPhrase = useCallback((text: string) => sendRef.current(text), []);
  const { phase, level, error, lastSent, reason, claudeWorking, on, say, toggle, stopSpeaking, dismissError } = useVoiceChat(
    target,
    mode,
    reading,
    kind,
    live ? onPhrase : undefined,
  );
  useEffect(() => {
    sayRef.current = say;
  }, [say]);
  const [draft, setDraft] = useState('');
  const toggleReadAloud = (): void => {
    const next = !readAloud;
    setReadAloud(next);
    saveReadAloud(next);
    if (!next) stopSpeaking();
  };
  const speakingNow = phase === 'speaking';

  // The ElevenLabs allowance, drawn as a ring around the live chat button while ElevenLabs reads.
  const showsUsage = live && reading.engine === 'elevenlabs';
  const [usage, setUsage] = useState<TtsUsage | null>(null);
  const [usageTick, setUsageTick] = useState(0);
  useEffect(() => {
    if (!showsUsage) return;
    const timer = window.setInterval(() => setUsageTick((n) => n + 1), 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [showsUsage]);
  // A finished reading has spent characters: read the usage again.
  const wasSpeaking = useRef(false);
  useEffect(() => {
    if (wasSpeaking.current && !speakingNow) setUsageTick((n) => n + 1);
    wasSpeaking.current = speakingNow;
  }, [speakingNow]);
  useEffect(() => {
    if (!showsUsage) return;
    let current = true;
    void window.acode.voice
      .ttsUsage()
      .then((next) => {
        if (current) setUsage(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [showsUsage, usageTick, menuOpen]);
  const usageText = showsUsage && usage ? `ElevenLabs: ${usageLabel(usage)}` : null;
  const chat = discussion.entries;
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = chatRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat, discussionSlot]);

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

  // Turning the discussion on also brings its column back when it is collapsed.
  const press = useCallback(() => {
    if (live && !on) bus.emit('discussionPanel', { visible: true });
    toggle();
  }, [live, on, toggle]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = live ? 'Space' : 'KeyD';
      if (event.code === key && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        press();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [press, live]);

  useEffect(() => {
    if (!lastSent) return;
    const left = lastSent.at + SENT_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), left + 20);
    return () => window.clearTimeout(timer);
  }, [lastSent]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
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
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const d = drag.current;
    if (!d || !live) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    d.moved = true;
    setOffset(clampOffset({ right: d.start.right - dx, bottom: d.start.bottom - dy }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLElement>, clickToggles: boolean): void => {
    const d = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!d) return;
    if (d.moved && offset) saveOffset(offset);
    else if (clickToggles) press();
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => endDrag(event, true);

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
          : working && mode === 'command'
            ? 'Claude is working; what you say now is queued'
            : null;
  const showBubble = phase !== 'off' || !!error;
  const shortcut = live ? 'Cmd+Shift+Space' : 'Cmd+Shift+D';
  const action = phase === 'speaking' ? 'Click to stop reading' : `Click to turn ${phase === 'off' || phase === 'error' ? 'on' : 'off'} (${shortcut})`;
  const extra = live ? 'right click for the voice, drag to move' : 'right click for the mode';
  const title = `${modeInfo?.label ?? ''}: ${LABEL[phase]}${note ? `, ${note}` : ''}. ${action}, ${extra}${target ? `. Talks to "${target.title}"` : ''}${usageText ? `. ${usageText}` : ''}`;
  // Ring grows with the voice so it is clear the microphone hears you.
  const ring = phase === 'listening' || phase === 'hearing' ? Math.min(1, level * 12) : 0;

  return (
    <div
      className={live ? 'vc-root vc-live' : 'vc-root vc-docked'}
      ref={rootRef}
      style={place ? { right: place.right, bottom: place.bottom } : undefined}
    >
      {live &&
        discussionSlot &&
        createPortal(
        <div className="vc-chat docked" role="log" aria-label="Discussion">
          <div className="vc-chat-head">
            <span className="vc-chat-title">Discussion{target ? ` · ${target.title}` : ''}</span>
            <span className="vc-model" role="radiogroup" aria-label="Discussion model">
              {DISCUSSION_MODELS.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={m === discussionModel}
                  className={m === discussionModel ? 'vc-model-option current' : 'vc-model-option'}
                  title={m === discussionModel ? `The partner runs on ${MODEL_LABEL[m]}` : `Switch to ${MODEL_LABEL[m]} (the discussion goes on)`}
                  onClick={() => {
                    if (m === discussionModel) return;
                    stopSpeaking();
                    setDiscussionModel(m);
                    saveDiscussionModel(m);
                    discussion.restartFor(m);
                  }}
                >
                  {MODEL_LABEL[m]}
                </button>
              ))}
            </span>
            {speakingNow && (
              <button type="button" className="vc-stop" title="Stop reading (the messages stay here)" onClick={stopSpeaking}>
                ■ Stop
              </button>
            )}
            <button
              type="button"
              className={readAloud ? 'vc-chat-tool' : 'vc-chat-tool off'}
              title={readAloud ? 'Reading aloud is on. Click to only show the messages' : 'Reading aloud is off. Click to read Claude\'s messages aloud'}
              aria-pressed={readAloud}
              onClick={toggleReadAloud}
            >
              <SpeakerIcon on={readAloud} />
            </button>
            <button
              type="button"
              className="vc-chat-tool"
              title={target ? `Send the task that follows from this discussion to "${target.title}"` : 'Open a Claude tab first'}
              disabled={!target || discussion.busy || chat.length === 0}
              onClick={() => discussion.handOver()}
            >
              → Claude Code
            </button>
            <button type="button" className="vc-chat-tool" title="Start a new discussion" disabled={chat.length === 0} onClick={() => {
              stopSpeaking();
              discussion.reset();
            }}>
              New
            </button>
            <button
              type="button"
              className="vc-chat-close"
              title="Collapse the discussion column"
              aria-label="Collapse the discussion column"
              onClick={() => bus.emit('discussionPanel', { visible: false })}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className="vc-chat-list" ref={chatRef}>
            {chat.length === 0 && (
              <div className="vc-chat-empty">
                Talk about what Claude Code is doing in this session. The partner sees what happened there, answers aloud and never changes anything.
              </div>
            )}
            {chat.map((entry) => (
              <div
                key={entry.id}
                className={`vc-chat-line vc-chat-${entry.role === 'partner' ? 'claude' : entry.role}${entry.streaming ? ' streaming' : ''}`}
              >
                {entry.text}
                {entry.streaming && <ThinkingSpark idle={!entry.text} textLength={entry.text.length} />}
                {entry.task && (
                  <div className={entry.taskSent ? 'vc-chat-task' : 'vc-chat-task unsent'}>
                    <div className="vc-chat-task-status">
                      {entry.taskStatus}
                      {!entry.taskSent && (
                        <button type="button" className="vc-task-send" onClick={() => discussion.sendTask(entry.id)}>
                          Send
                        </button>
                      )}
                    </div>
                    {entry.task}
                  </div>
                )}
              </div>
            ))}
          </div>
          <form
            className="vc-chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              setDraft('');
              discussion.send(text);
            }}
          >
            <input
              className="vc-chat-input"
              value={draft}
              placeholder="Or type here and press Enter"
              onChange={(event) => setDraft(event.target.value)}
            />
          </form>
        </div>
      ,
          discussionSlot,
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
          {usageText && <div className="vc-usage-line">{usageText}</div>}
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
          {speakingNow && (
            <button type="button" className="vc-stop" onClick={stopSpeaking} title="Stop reading">
              ■ Stop reading
            </button>
          )}
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
        className={`vc-button vc-${phase}${showsUsage && usage ? ' has-usage' : ''}`}
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
            press();
          }
        }}
      >
        <span className="vc-ring" aria-hidden="true" />
        {showsUsage && usage && <UsageRing used={usageFraction(usage)} />}
        {phase === 'transcribing' || phase === 'starting' ? <span className="vc-spinner" aria-hidden="true" /> : live ? <WaveIcon live={phase === 'hearing' || phase === 'speaking'} /> : <MicIcon />}
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
      </span>
    </div>
  );
}
