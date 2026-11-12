import { useCallback, useEffect, useRef, useState } from 'react';
import type { PtyId } from '@shared/ipc';
import type { ClaudeStatus } from '@shared/terminal';
import { bus } from '../bus';
import { downsample, encodeWav, VOICE_SAMPLE_RATE } from '../terminal/wav';
import { phraseToSend } from './phrases';
import { rms, Vad } from './vad';

/** The Claude tab the voice chat talks to. */
export interface VoiceTarget {
  ptyId: PtyId;
  status: ClaudeStatus | undefined;
  title: string;
}

export type VoicePhase =
  | 'off'
  | 'starting'
  | 'listening'
  | 'hearing'
  | 'transcribing'
  /** A phrase went to Claude; listening resumes once Claude has answered. */
  | 'claude'
  /** Listening is on hold: no Claude tab, or Claude works or waits for an answer in the terminal. */
  | 'paused'
  | 'error';

/** Audio kept from before the moment speech was detected, so the first syllable is not cut. */
const PREROLL_MS = 500;
/** A sent phrase that Claude never picks up (a slash command it finished at once) stops blocking after this. */
const PICKUP_TIMEOUT_MS = 8000;
const FRAME_SIZE = 4096;

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

export function pauseReason(target: VoiceTarget | null): string | null {
  if (!target) return 'Open a Claude tab to talk to it';
  if (target.status === 'waiting') return 'Claude waits for an answer in the terminal';
  if (target.status === 'busy' || target.status === 'shell') return 'Claude is working';
  if (target.status !== 'idle') return 'Claude Code is not running in this tab';
  return null;
}

/**
 * Hands-free conversation with a Claude tab: the microphone stays open, a pause of about 1.5 s
 * ends a phrase, the phrase is transcribed locally and typed into the tab with Enter. While Claude
 * works (or asks something in the terminal) nothing is sent; listening resumes when it is idle.
 */
export function useVoiceChat(target: VoiceTarget | null) {
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [lastSent, setLastSent] = useState<{ text: string; at: number } | null>(null);

  const audio = useRef<Audio | null>(null);
  const targetRef = useRef(target);
  const blocked = useRef(true);
  const sawBusy = useRef(false);
  const generation = useRef(0);

  const ready = pauseReason(target) === null;
  useEffect(() => {
    targetRef.current = target;
  }, [target]);
  // The audio callback reads this instead of React state.
  useEffect(() => {
    blocked.current = !on || transcribing || awaiting || !ready;
  }, [on, transcribing, awaiting, ready]);

  // After a phrase was sent: wait for Claude to start working and to be idle again.
  useEffect(() => {
    if (!awaiting) return;
    const status = target?.status;
    if (status === 'busy' || status === 'shell' || status === 'waiting') sawBusy.current = true;
    if (sawBusy.current && status === 'idle') {
      setAwaiting(false);
      return;
    }
    if (sawBusy.current) return;
    const timer = window.setTimeout(() => setAwaiting(false), PICKUP_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [awaiting, target?.status]);

  const close = useCallback(() => {
    generation.current += 1;
    const current = audio.current;
    audio.current = null;
    if (!current) return;
    current.processor.onaudioprocess = null;
    current.processor.disconnect();
    current.source.disconnect();
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => undefined);
  }, []);

  const send = useCallback(async (samples: Float32Array, rate: number, gen: number) => {
    setTranscribing(true);
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
      const current = targetRef.current;
      if (!text || !current || pauseReason(current) !== null) return;
      sawBusy.current = false;
      setAwaiting(true);
      setLastSent({ text, at: Date.now() });
      bus.emit('sendToPty', { ptyId: current.ptyId, text });
    } catch (err) {
      if (gen === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === generation.current) setTranscribing(false);
    }
  }, []);

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
      processor.onaudioprocess = (event) => {
        const frame = new Float32Array(event.inputBuffer.getChannelData(0));
        const loudness = rms(frame);
        setLevel(loudness);
        preroll.push(frame);
        while (preroll.length * frameMs > PREROLL_MS) preroll.shift();
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
        if (change === 'end' && phrase) {
          const samples = concat(phrase);
          phrase = null;
          setHearing(false);
          void send(samples, rate, gen);
        } else if (change === 'discard') {
          phrase = null;
          setHearing(false);
        }
      };
      source.connect(processor);
      processor.connect(context.destination);
      // Created after awaits, the context may start suspended (no user gesture left): resume it.
      if (context.state !== 'running') await context.resume();
      audio.current = { stream, context, source, processor };
      setOn(true);
    } catch (err) {
      if (gen === generation.current) {
        setError(micErrorMessage(err));
        close();
      }
    } finally {
      if (gen === generation.current) setStarting(false);
    }
  }, [close, send]);

  const stop = useCallback(() => {
    close();
    setOn(false);
    setStarting(false);
    setHearing(false);
    setTranscribing(false);
    setAwaiting(false);
    setLevel(0);
  }, [close]);

  const toggle = useCallback(() => {
    if (on || starting) stop();
    else void start();
  }, [on, starting, start, stop]);

  useEffect(() => close, [close]);

  const phase: VoicePhase = error && !on
    ? 'error'
    : starting
      ? 'starting'
      : !on
        ? 'off'
        : transcribing
          ? 'transcribing'
          : awaiting
            ? 'claude'
            : !ready
              ? 'paused'
              : hearing
                ? 'hearing'
                : 'listening';

  return { phase, level, error, lastSent, toggle, stop, dismissError: () => setError(null) };
}
