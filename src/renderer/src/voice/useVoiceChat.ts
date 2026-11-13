import { useCallback, useEffect, useRef, useState } from 'react';
import type { PtyId } from '@shared/ipc';
import type { ClaudeStatus } from '@shared/terminal';
import type { TtsEngine } from '@shared/voice';
import { bus } from '../bus';
import { downsample, encodeWav, VOICE_SAMPLE_RATE } from '../terminal/wav';
import { dictationText } from './answer';
import type { VoiceMode } from './answer';
import { phraseToSend } from './phrases';
import { speakableText, speechChunks } from './speakable';
import { rms, Vad } from './vad';

/** The Claude tab the voice chat talks to. */
export interface VoiceTarget {
  ptyId: PtyId;
  status: ClaudeStatus | undefined;
  title: string;
  /** Session of the tab, to read Claude's answer from its transcript in conversation mode. */
  sessionId: string | null;
}

export type VoicePhase =
  | 'off'
  | 'starting'
  | 'listening'
  | 'hearing'
  | 'transcribing'
  /** A phrase went to Claude; listening resumes once Claude has answered. */
  | 'claude'
  /** Claude's answer is being read aloud. */
  | 'speaking'
  /** Listening is on hold: ARcode is in the background, no Claude tab, or Claude is busy or asks something. */
  | 'paused'
  | 'error';

/** Audio kept from before the moment speech was detected, so the first syllable is not cut. */
const PREROLL_MS = 500;
/** A sent phrase that Claude never picks up (a slash command it finished at once) stops blocking after this. */
const PICKUP_TIMEOUT_MS = 8000;
const FRAME_SIZE = 4096;
/** Talking over the read-out answer stops it: this loud for this long. */
const BARGE_IN_LEVEL = 0.06;
const BARGE_IN_MS = 450;

interface Audio {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
}

function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access denied. Allow ARcode in System Settings > Privacy & Security > Microphone';
  }
  if (name === 'NotFoundError') return 'No microphone found';
  return `Could not open the microphone: ${error instanceof Error ? error.message : String(error)}`;
}

function concat(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Why a phrase cannot go to Claude right now, or null when it can. While Claude works (a subagent,
 * a long tool) a phrase goes out like a typed message: Claude Code queues it. Only a question Claude
 * asks in the terminal blocks, since any typed text would become its answer.
 */
export function pauseReason(target: VoiceTarget | null, focused = true): string | null {
  if (!focused) return 'ARcode is in the background';
  if (!target) return 'Open a Claude tab to talk to it';
  if (target.status === 'waiting') return 'Claude waits for an answer in the terminal';
  if (target.status !== 'idle' && target.status !== 'busy' && target.status !== 'shell') return 'Claude Code is not running in this tab';
  return null;
}

function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = (): void => setFocused(true);
    const off = (): void => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);
  return focused;
}

/**
 * Hands-free voice for a Claude tab. The microphone stays open while the mode is on, but phrases
 * are only taken while this ARcode window is the active window; a pause of about 1.5 s ends a
 * phrase, which is transcribed locally. Then, by mode:
 * - dictate: the text is typed into Claude's prompt without Enter, phrases joined with spaces;
 * - command: the text is sent with Enter, and listening waits until Claude has answered;
 * - chat: like command, then Claude's final message is read aloud without code; talking over it
 *   (or a click) stops the reading.
 */
/** Which engine and voice read answers aloud in conversation mode. */
export interface ReadingVoice {
  engine: TtsEngine;
  voice: string;
}

/**
 * `owner` names the button using the microphone: when one button starts listening, the others stop,
 * so dictation and the live chat never both hear the same phrase.
 */
export function useVoiceChat(
  target: VoiceTarget | null,
  mode: VoiceMode,
  reading: ReadingVoice,
  owner: string,
  /** Takes each phrase instead of a Claude tab (the live chat's discussion); only window focus pauses it. */
  onPhrase?: (text: string) => void,
) {
  const focused = useWindowFocus();
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [hearing, setHearing] = useState(false);
  /** Phrases being transcribed; dictation keeps listening meanwhile, so there can be several. */
  const [pending, setPending] = useState(0);
  const transcribing = pending > 0;
  const [awaiting, setAwaiting] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [lastSent, setLastSent] = useState<{ text: string; at: number } | null>(null);

  const audio = useRef<Audio | null>(null);
  const targetRef = useRef(target);
  const modeRef = useRef(mode);
  const readingRef = useRef(reading);
  const blocked = useRef(true);
  const focusedRef = useRef(focused);
  /** Set on blur: the phrase being spoken was said while ARcode was active, so it still goes out. */
  const flush = useRef(false);
  const speakingRef = useRef(false);
  const sawBusy = useRef(false);
  /** Claude's messages waiting to be read aloud, in order. */
  const speechQueue = useRef<string[]>([]);
  /** Dictated text sits in Claude's prompt, so the next phrase is joined with a space. */
  const dictating = useRef(false);
  const generation = useRef(0);
  /** Bumped to cancel the reading in progress. */
  const speechRun = useRef(0);
  const playing = useRef<AudioBufferSourceNode | null>(null);

  const onPhraseRef = useRef(onPhrase);
  useEffect(() => {
    onPhraseRef.current = onPhrase;
  }, [onPhrase]);
  const reason = onPhrase ? (focused ? null : 'ARcode is in the background') : pauseReason(target, focused);
  useEffect(() => {
    targetRef.current = target;
    modeRef.current = mode;
    readingRef.current = reading;
    focusedRef.current = focused;
  }, [target, mode, reading, focused]);
  // The audio callback reads this instead of React state.
  useEffect(() => {
    // Listening goes on while phrases are transcribed and while Claude works; transcriptions finish in order.
    blocked.current = !on || speaking || reason !== null;
  }, [on, speaking, reason]);
  useEffect(() => {
    if (!focused) flush.current = true;
  }, [focused]);

  // Dictation: once Claude starts working the prompt was submitted, so the next phrase starts fresh.
  const status = target?.status;
  useEffect(() => {
    if (status !== 'idle') dictating.current = false;
  }, [status, target?.ptyId]);

  const stopSpeaking = useCallback(() => {
    speechQueue.current = [];
    speechRun.current += 1;
    speakingRef.current = false;
    try {
      playing.current?.stop();
    } catch {
      // Already stopped.
    }
    playing.current = null;
    setSpeaking(false);
  }, []);

  /** Reads text aloud through the microphone's audio context, chunk by chunk, rendering the next one while one plays. */
  const speak = useCallback(async (text: string) => {
    const context = audio.current?.context;
    const chunks = speechChunks(text);
    if (!context || chunks.length === 0) return;
    const run = ++speechRun.current;
    speakingRef.current = true;
    setSpeaking(true);
    try {
      const { engine, voice } = readingRef.current;
      const render = (piece: string) => window.acode.voice.speak({ text: piece, engine, voice });
      let next = render(chunks[0] ?? '');
      for (let i = 0; i < chunks.length; i++) {
        const result = await next;
        if (run !== speechRun.current) return;
        if (i + 1 < chunks.length) next = render(chunks[i + 1] ?? '');
        if (!result.ok) {
          setError(result.message);
          return;
        }
        const buffer = await context.decodeAudioData(result.audio.slice().buffer);
        if (run !== speechRun.current) return;
        await new Promise<void>((resolve) => {
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.onended = () => resolve();
          playing.current = source;
          source.start();
        });
        if (run !== speechRun.current) return;
      }
    } catch (err) {
      if (run === speechRun.current) setError(`Could not read the answer aloud: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (run === speechRun.current) {
        speakingRef.current = false;
        playing.current = null;
        setSpeaking(false);
      }
    }
  }, []);

  /**
   * Queues one of Claude's messages to be read aloud (conversation mode reads each message as it
   * arrives, not only the last one of a turn). Code, tables and paths are left out.
   */
  const say = useCallback(
    (markdown: string) => {
      if (!audio.current || modeRef.current !== 'chat') return;
      const text = speakableText(markdown);
      if (!text) return;
      speechQueue.current.push(text);
      if (speakingRef.current) return;
      void (async () => {
        let next: string | undefined;
        while ((next = speechQueue.current.shift()) !== undefined) {
          await speak(next);
          // A barge-in or a click cleared the queue.
          if (!audio.current) break;
        }
      })();
    },
    [speak],
  );

  // After a phrase was sent: wait for Claude to start working and to be idle again.
  useEffect(() => {
    if (!awaiting) return;
    if (status === 'busy' || status === 'shell' || status === 'waiting') sawBusy.current = true;
    if (sawBusy.current && status === 'idle') {
      setAwaiting(false);
      return;
    }
    if (sawBusy.current) return;
    const timer = window.setTimeout(() => setAwaiting(false), PICKUP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [awaiting, status]);

  const close = useCallback(() => {
    generation.current += 1;
    stopSpeaking();
    const current = audio.current;
    audio.current = null;
    if (!current) return;
    current.processor.onaudioprocess = null;
    current.processor.disconnect();
    current.source.disconnect();
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => undefined);
  }, [stopSpeaking]);

  /** Phrases go out one after another, in the order they were said. */
  const outbox = useRef<Promise<void>>(Promise.resolve());
  const deliverNow = useCallback((text: string) => {
    if (onPhraseRef.current) {
      setLastSent({ text, at: Date.now() });
      onPhraseRef.current(text);
      return;
    }
    const current = targetRef.current;
    const currentMode = modeRef.current;
    // The phrase may have been finished after ARcode lost focus (it was said before): only the target matters now.
    if (!current || pauseReason(current, true) !== null) return;
    setLastSent({ text, at: Date.now() });
    if (currentMode === 'dictate') {
      bus.emit('sendToPty', { ptyId: current.ptyId, text: dictationText(text, dictating.current), submit: false });
      dictating.current = true;
      return;
    }
    if (currentMode === 'chat') {
      sawBusy.current = current.status === 'busy' || current.status === 'shell';
      setAwaiting(true);
    }
    bus.emit('sendToPty', { ptyId: current.ptyId, text });
  }, []);
  const deliver = useCallback(
    (text: string): Promise<void> => {
      const next = outbox.current.then(() => deliverNow(text));
      outbox.current = next.catch(() => undefined);
      return next;
    },
    [deliverNow],
  );

  const transcribe = useCallback(
    async (samples: Float32Array, rate: number, gen: number) => {
      setPending((n) => n + 1);
      try {
        const wav = encodeWav(downsample(samples, rate, VOICE_SAMPLE_RATE), VOICE_SAMPLE_RATE);
        const result = await window.acode.voice.transcribe(wav);
        if (gen !== generation.current) return;
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setError(null);
        const text = phraseToSend(result.text);
        if (text) await deliver(text);
      } catch (err) {
        if (gen === generation.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (gen === generation.current) setPending((n) => Math.max(0, n - 1));
      }
    },
    [deliver],
  );

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    const gen = ++generation.current;
    try {
      if (!(await window.acode.voice.requestMic())) throw new DOMException('denied', 'NotAllowedError');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (gen !== generation.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(FRAME_SIZE, 1, 1);
      const rate = context.sampleRate;
      const frameMs = (FRAME_SIZE / rate) * 1000;
      const vad = new Vad();
      const preroll: Float32Array[] = [];
      let phrase: Float32Array[] | null = null;
      let loudMs = 0;
      const sendPhrase = (): void => {
        if (!phrase) return;
        const samples = concat(phrase);
        phrase = null;
        setHearing(false);
        void transcribe(samples, rate, gen);
      };
      processor.onaudioprocess = (event) => {
        const frame = new Float32Array(event.inputBuffer.getChannelData(0));
        const loudness = rms(frame);
        setLevel(loudness);
        preroll.push(frame);
        while (preroll.length * frameMs > PREROLL_MS) preroll.shift();
        // ARcode just lost focus: a phrase in progress was said while it was active, so it goes out.
        if (flush.current) {
          flush.current = false;
          if (phrase && vad.speaking) sendPhrase();
          phrase = null;
          vad.reset();
        }
        // Talking over the answer stops the reading; the speech is picked up as the next phrase.
        if (speakingRef.current) {
          loudMs = focusedRef.current && loudness > BARGE_IN_LEVEL ? loudMs + frameMs : 0;
          if (loudMs >= BARGE_IN_MS) {
            loudMs = 0;
            stopSpeaking();
          }
          return;
        }
        if (blocked.current) {
          if (phrase) setHearing(false);
          phrase = null;
          vad.reset();
          return;
        }
        const change = vad.feed(loudness, frameMs);
        if (change === 'start') {
          phrase = [...preroll];
          setHearing(true);
        } else if (phrase) {
          phrase.push(frame);
        }
        if (change === 'end') sendPhrase();
        else if (change === 'discard') {
          phrase = null;
          setHearing(false);
        }
      };
      source.connect(processor);
      processor.connect(context.destination);
      // Created after awaits, the context may start suspended (no user gesture left): resume it.
      if (context.state !== 'running') await context.resume();
      audio.current = { stream, context, source, processor };
      dictating.current = false;
      setOn(true);
      bus.emit('voiceOwner', { owner });
    } catch (err) {
      if (gen === generation.current) {
        setError(micErrorMessage(err));
        close();
      }
    } finally {
      if (gen === generation.current) setStarting(false);
    }
  }, [close, transcribe, stopSpeaking, owner]);

  const stop = useCallback(() => {
    close();
    setOn(false);
    setStarting(false);
    setHearing(false);
    setPending(0);
    setAwaiting(false);
    setLevel(0);
  }, [close]);

  /** A click while Claude's answer is read only stops the reading; otherwise it turns the voice chat on or off. */
  const toggle = useCallback(() => {
    if (speakingRef.current) stopSpeaking();
    else if (on || starting) stop();
    else void start();
  }, [on, starting, start, stop, stopSpeaking]);

  // Leaving conversation mode stops a reading in progress.
  useEffect(() => {
    if (mode !== 'chat' && speakingRef.current) stopSpeaking();
  }, [mode, stopSpeaking]);

  useEffect(() => close, [close]);

  // Another button took the microphone: this one stops listening.
  useEffect(() => bus.on('voiceOwner', ({ owner: other }) => {
    if (other !== owner && audio.current) stop();
  }), [owner, stop]);

  const phase: VoicePhase = error && !on
    ? 'error'
    : starting
      ? 'starting'
      : !on
        ? 'off'
        : speaking
          ? 'speaking'
          : reason !== null
            ? 'paused'
            : hearing
              ? 'hearing'
              : transcribing
                ? 'transcribing'
                : awaiting
                  ? 'claude'
                  : 'listening';
  /** Claude works on what was said; listening goes on, so more can be added (it is queued). */
  const claudeWorking = on && (target?.status === 'busy' || target?.status === 'shell');

  return { phase, level, error, lastSent, reason, claudeWorking, on, say, toggle, stop, stopSpeaking, dismissError: () => setError(null) };
}
