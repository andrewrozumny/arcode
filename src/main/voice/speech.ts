/**
 * Text to speech for the voice chat with macOS `say`: the text is rendered into a WAV file that the
 * renderer plays itself, so the page's echo cancellation knows what the speakers play.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { SpeechResult } from '@shared/voice';
import { VOICE_MAX_SPEECH_CHARS } from '@shared/voice';
import { run, whisperLanguage } from './transcribe';
import type { Env } from './transcribe';

export const SAY = '/usr/bin/say';
/** Rendering a long paragraph takes a few seconds; anything slower is stuck. */
export const SPEECH_TIMEOUT_MS = 60_000;
/** Voice per dictation language when `ARCODE_TTS_VOICE` is not set; others use the system voice. */
const VOICES: Record<string, string> = { ru: 'Milena', en: 'Samantha', uk: 'Lesya', de: 'Anna', fr: 'Thomas', es: 'Monica' };

/** Voice to speak with: `ARCODE_TTS_VOICE`, else one matching the dictation language, else the system voice (null). */
export function speechVoice(env: Env): string | null {
  const configured = env.ARCODE_TTS_VOICE?.trim();
  if (configured && /^[\p{L}\p{N} ()._-]{1,64}$/u.test(configured)) return configured;
  return VOICES[whisperLanguage(env)] ?? null;
}

export function sayArgs(voice: string | null, textFile: string, outFile: string): string[] {
  return [...(voice ? ['-v', voice] : []), '-f', textFile, '-o', outFile, '--file-format=WAVE', '--data-format=LEI16@22050'];
}

export function speechText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Speech text must be a string');
  const text = value.trim();
  if (!text) throw new Error('Speech text is empty');
  return text.slice(0, VOICE_MAX_SPEECH_CHARS);
}

export interface SpeechOptions {
  env?: Env;
  say?: string;
  timeoutMs?: number;
}

/** Renders text to WAV bytes. Failures are reported in the result, never thrown. */
export async function synthesize(text: string, options: SpeechOptions = {}): Promise<SpeechResult> {
  if (process.platform !== 'darwin' && !options.say) return { ok: false, message: 'Reading answers aloud needs macOS' };
  const env = options.env ?? process.env;
  const dir = await mkdtemp(join(os.tmpdir(), 'arcode-speech-'));
  try {
    const textFile = join(dir, 'text.txt');
    const outFile = join(dir, 'speech.wav');
    await writeFile(textFile, text, { encoding: 'utf8', mode: 0o600 });
    const voice = speechVoice(env);
    let result = await run(options.say ?? SAY, sayArgs(voice, textFile, outFile), options.timeoutMs ?? SPEECH_TIMEOUT_MS);
    // A configured voice that is not installed: fall back to the system voice once.
    if (result.code !== 0 && !result.timedOut && voice) {
      result = await run(options.say ?? SAY, sayArgs(null, textFile, outFile), options.timeoutMs ?? SPEECH_TIMEOUT_MS);
    }
    if (result.timedOut) return { ok: false, message: 'Speech took too long to render' };
    if (result.code !== 0) {
      const detail = result.stderr.trim().split('\n').pop() ?? '';
      return { ok: false, message: `say failed${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true, audio: new Uint8Array(await readFile(outFile)) };
  } catch (error) {
    return { ok: false, message: `Speech failed: ${String(error)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
