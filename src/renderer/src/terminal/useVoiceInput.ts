import { useCallback, useEffect, useRef, useState } from 'react';
import { encodeWav, VOICE_SAMPLE_RATE } from './wav';

/** Longest recording; it stops by itself after this. */
export const MAX_RECORDING_SECONDS = 5 * 60;
/** Compressed recording size cap (opus at the default bitrate stays far below it). */
const MAX_RECORDING_BYTES = 20 * 1024 * 1024;

export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; seconds: number }
  | { kind: 'transcribing' };

interface Recording {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  bytes: number;
  cancelled: boolean;
  timer: number;
}

function preferredMimeType(): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
}

/** Decodes the recording and renders it to 16 kHz mono, then encodes a WAV. */
async function toWav(blob: Blob): Promise<Uint8Array> {
  const decoded = await new OfflineAudioContext(1, 1, VOICE_SAMPLE_RATE).decodeAudioData(await blob.arrayBuffer());
  const length = Math.max(1, Math.ceil(decoded.duration * VOICE_SAMPLE_RATE));
  const context = new OfflineAudioContext(1, length, VOICE_SAMPLE_RATE);
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return encodeWav(rendered.getChannelData(0), VOICE_SAMPLE_RATE);
}

function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access denied. Allow ARcode in System Settings > Privacy & Security > Microphone';
  }
  if (name === 'NotFoundError') return 'No microphone found. Connect one and try again';
  return `Could not start recording: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Records from the microphone and transcribes locally (whisper.cpp in main). `onText` gets the
 * recognised text; failures land in `error` with a concrete fix.
 */
export function useVoiceInput(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const recording = useRef<Recording | null>(null);
  const busy = useRef(false);
  /** Esc pressed while the microphone was still being opened. */
  const cancelStart = useRef(false);
  const mounted = useRef(true);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);

  const finish = useCallback(async (current: Recording): Promise<void> => {
    window.clearInterval(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
    recording.current = null;
    if (current.cancelled || !mounted.current) {
      busy.current = false;
      if (mounted.current) setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'transcribing' });
    try {
      const blob = new Blob(current.chunks, { type: current.recorder.mimeType });
      if (blob.size === 0) throw new Error('The recording is empty');
      const result = await window.acode.voice.transcribe(await toWav(blob));
      if (!mounted.current) return;
      if (!result.ok) setError(result.message);
      else if (result.text === '') setError('No speech recognised');
      else onTextRef.current(result.text);
    } catch (failure) {
      if (mounted.current) setError(`Transcription failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally {
      busy.current = false;
      if (mounted.current) setState({ kind: 'idle' });
    }
  }, []);

  const stop = useCallback((cancel = false): void => {
    const current = recording.current;
    if (!current) {
      if (cancel && busy.current) cancelStart.current = true;
      return;
    }
    current.cancelled ||= cancel;
    if (current.recorder.state !== 'inactive') current.recorder.stop();
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    cancelStart.current = false;
    setError(null);
    setState({ kind: 'starting' });
    let stream: MediaStream;
    try {
      if (!(await window.acode.voice.requestMic())) {
        throw new DOMException('Microphone access denied', 'NotAllowedError');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (failure) {
      busy.current = false;
      if (mounted.current) {
        setError(micErrorMessage(failure));
        setState({ kind: 'idle' });
      }
      return;
    }
    if (!mounted.current || cancelStart.current) {
      for (const track of stream.getTracks()) track.stop();
      busy.current = false;
      if (mounted.current) setState({ kind: 'idle' });
      return;
    }
    const mimeType = preferredMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const startedAt = Date.now();
    const current: Recording = { recorder, stream, chunks: [], bytes: 0, cancelled: false, timer: 0 };
    recording.current = current;
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      current.chunks.push(event.data);
      current.bytes += event.data.size;
      if (current.bytes >= MAX_RECORDING_BYTES) stop();
    };
    recorder.onstop = () => void finish(current);
    current.timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      if (seconds >= MAX_RECORDING_SECONDS) stop();
      else setState({ kind: 'recording', seconds });
    }, 250);
    recorder.start(1000);
    setState({ kind: 'recording', seconds: 0 });
  }, [finish, stop]);

  /** Click / Cmd+Shift+M: start when idle, stop (and transcribe) while recording. */
  const toggle = useCallback((): void => {
    if (recording.current) stop();
    else void start();
  }, [start, stop]);

  const cancel = useCallback((): void => stop(true), [stop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop(true);
    };
  }, [stop]);

  return { state, error, toggle, cancel, dismissError: () => setError(null) };
}
