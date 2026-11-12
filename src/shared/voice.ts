/** IPC contract of voice input (local dictation with whisper.cpp). No Electron imports. */

export const VoiceChannel = {
  /** WAV bytes in, recognised text out. */
  Transcribe: 'voice:transcribe',
  /** Asks macOS for microphone access; resolves to whether it is granted. */
  RequestMic: 'voice:requestMic',
} as const;

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
}
