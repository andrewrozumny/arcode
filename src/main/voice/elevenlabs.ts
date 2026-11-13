/**
 * ElevenLabs text to speech for reading Claude's answers aloud. Opt-in: it is only offered when an
 * API key is in the macOS Keychain (service "ARcode ElevenLabs", account "api-key") or in
 * `ELEVENLABS_API_KEY`. Only the code-free answer text is sent; the key never leaves main.
 */
import { execFile } from 'node:child_process';
import type { SpeechResult, TtsVoice } from '@shared/voice';

export const ELEVENLABS_API = 'https://api.elevenlabs.io';
export const KEYCHAIN_SERVICE = 'ARcode ElevenLabs';
export const KEYCHAIN_ACCOUNT = 'api-key';
/** The most life-like ElevenLabs model; it speaks Russian with any voice. */
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
/** The voice used until another is picked (a Ukrainian voice from the ElevenLabs library). */
export const DEFAULT_VOICE = '9Sj8ugvpK1DmcAXyvi3a';
const REQUEST_TIMEOUT_MS = 60_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Env = Record<string, string | undefined>;

/** Reads the key from the login Keychain; null when there is none. */
export function keychainKey(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { timeout: 10_000 },
      (error, stdout) => {
        const key = String(stdout).trim();
        resolve(!error && key ? key : null);
      },
    );
  });
}

export function voiceId(value: unknown): string {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : DEFAULT_VOICE;
}

export function modelId(env: Env): string {
  const model = env.ARCODE_ELEVENLABS_MODEL?.trim();
  return model && /^[a-z0-9_]{3,64}$/.test(model) ? model : DEFAULT_MODEL;
}

/** Voices of the account, from `GET /v1/voices`, sorted by name. */
export function parseVoices(body: unknown): TtsVoice[] {
  const list = body && typeof body === 'object' && Array.isArray((body as { voices?: unknown }).voices) ? (body as { voices: unknown[] }).voices : [];
  const voices: TtsVoice[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const { voice_id: id, name, labels } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || typeof name !== 'string') continue;
    const tags = labels && typeof labels === 'object' ? Object.values(labels).filter((v): v is string => typeof v === 'string') : [];
    voices.push({ id, name: name.slice(0, 80), description: tags.slice(0, 4).join(', ').slice(0, 120) });
  }
  return voices.sort((a, b) => a.name.localeCompare(b.name));
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: { message?: unknown } | string };
    const detail = typeof body.detail === 'string' ? body.detail : body.detail?.message;
    if (typeof detail === 'string') return detail.slice(0, 200);
  } catch {
    // Not JSON.
  }
  return `HTTP ${response.status}`;
}

export class ElevenLabs {
  private cachedKey: Promise<string | null> | undefined;
  private cachedVoices: TtsVoice[] | undefined;

  constructor(
    private readonly env: Env = process.env,
    private readonly readKey: () => Promise<string | null> = keychainKey,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init),
  ) {}

  key(): Promise<string | null> {
    const fromEnv = this.env.ELEVENLABS_API_KEY?.trim();
    if (fromEnv) return Promise.resolve(fromEnv);
    // A key added to the Keychain later is picked up on the next check after a miss.
    this.cachedKey ??= this.readKey().then((key) => {
      if (!key) this.cachedKey = undefined;
      return key;
    });
    return this.cachedKey;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const key = await this.key();
    if (!key) throw new Error('no API key: add it to the Keychain as "ARcode ElevenLabs"');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.fetcher(`${ELEVENLABS_API}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), 'xi-api-key': key },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Voices of the account; the default voice is listed first even when it is not in the account. */
  async voices(): Promise<TtsVoice[]> {
    if (this.cachedVoices) return this.cachedVoices;
    let voices: TtsVoice[] = [];
    try {
      const response = await this.request('/v1/voices', { method: 'GET' });
      if (response.ok) voices = parseVoices(await response.json());
    } catch {
      // Offline or no key: only the default is offered.
    }
    const own = voices.filter((v) => v.id !== DEFAULT_VOICE);
    const fallback = { id: DEFAULT_VOICE, name: 'Ukrainian (default)', description: 'ElevenLabs library voice' };
    const listed = voices.find((v) => v.id === DEFAULT_VOICE);
    this.cachedVoices = [listed ?? fallback, ...own];
    return this.cachedVoices;
  }

  /** MP3 of the text spoken by the voice. */
  async speak(text: string, voice: unknown): Promise<SpeechResult> {
    try {
      const response = await this.request(`/v1/text-to-speech/${encodeURIComponent(voiceId(voice))}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: modelId(this.env) }),
      });
      if (!response.ok) return { ok: false, message: `ElevenLabs: ${await errorText(response)}` };
      return { ok: true, audio: new Uint8Array(await response.arrayBuffer()) };
    } catch (error) {
      return { ok: false, message: `ElevenLabs: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}
