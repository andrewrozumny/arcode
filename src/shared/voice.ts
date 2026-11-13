/**
 * IPC contract of voice: local dictation with whisper.cpp, and reading Claude's answers aloud with
 * one of three engines (ElevenLabs in the cloud, Silero or the macOS voice on this Mac). No Electron imports.
 */

export const VoiceChannel = {
  /** WAV bytes in, recognised text out. */
  Transcribe: 'voice:transcribe',
  /** Asks macOS for microphone access; resolves to whether it is granted. */
  RequestMic: 'voice:requestMic',
  /** Text in, audio of it read aloud out, by the requested engine and voice. */
  Speak: 'voice:speak',
  /** Which reading engines can be used on this Mac, and their voices. */
  TtsInfo: 'voice:ttsInfo',
  /** Characters of the ElevenLabs plan used so far in this billing period. */
  TtsUsage: 'voice:ttsUsage',
} as const;

/** Longest text rendered to speech in one call; the renderer splits longer answers. */
export const VOICE_MAX_SPEECH_CHARS = 4000;

/**
 * Reading engines. `elevenlabs` sends the code-free answer text to ElevenLabs (opt-in: it needs an
 * API key in the Keychain); `silero` and `system` never leave the Mac.
 */
export type TtsEngine = 'elevenlabs' | 'silero' | 'system';

export const TTS_ENGINES: readonly TtsEngine[] = ['elevenlabs', 'silero', 'system'];

export interface TtsVoice {
  id: string;
  name: string;
  description: string;
}

export interface SpeakRequest {
  text: string;
  engine: TtsEngine;
  /** Voice id of the engine; the engine's default when empty or unknown. */
  voice?: string;
}

/** Audio bytes (WAV or MP3, whatever the engine gives; the renderer decodes both). */
export type SpeechResult = { ok: true; audio: Uint8Array } | { ok: false; message: string };

export interface TtsEngineInfo {
  available: boolean;
  /** Why it cannot be used, with the fix, when it is not available. */
  reason?: string;
  voices: TtsVoice[];
  defaultVoice: string;
}

export type TtsInfo = Record<TtsEngine, TtsEngineInfo>;

/** The ElevenLabs plan's character allowance: used and limit of this period, and when it resets. */
export interface TtsUsage {
  used: number;
  limit: number;
  /** Unix time in ms of the next reset; null when unknown. */
  resetsAt: number | null;
  tier: string | null;
}

/** Largest WAV main accepts (about 26 minutes of 16 kHz mono 16-bit audio). */
export const VOICE_MAX_WAV_BYTES = 50 * 1024 * 1024;

export type VoiceErrorCode = 'no-whisper' | 'no-model' | 'failed' | 'timeout';

export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; error: VoiceErrorCode; message: string };

export interface VoiceApi {
  /** Transcribes a 16-bit PCM WAV (16 kHz mono works best). Rejects only on malformed input. */
  transcribe(bytes: Uint8Array): Promise<TranscribeResult>;
  /** macOS: prompts for microphone access once; true when access is granted. */
  requestMic(): Promise<boolean>;
  /** Renders text to speech with the requested engine; the renderer plays the audio. */
  speak(request: SpeakRequest): Promise<SpeechResult>;
  /** Reading engines that can be used here and their voices (ElevenLabs voices come from the account). */
  ttsInfo(): Promise<TtsInfo>;
  /** The ElevenLabs plan's usage; null without a key or when it cannot be read. */
  ttsUsage(): Promise<TtsUsage | null>;
}
