/**
 * Local speech recognition with whisper.cpp (`whisper-cli`). The renderer records and encodes a
 * 16 kHz mono WAV; this module writes it to a private temp folder, runs whisper-cli on it with an
 * argv array (never a shell) and returns the cleaned text. No Electron imports, so it can be tested.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { delimiter, join } from 'node:path';
import { VOICE_MAX_WAV_BYTES } from '@shared/voice';
import type { TranscribeResult } from '@shared/voice';

export const TRANSCRIBE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_LANGUAGE = 'ru';

export interface ModelFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/** The file system calls the locate helpers need; injected in tests. */
export interface VoiceFs {
  /** A regular file the current user may execute. */
  isExecutable(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  /** Regular files of a folder; empty when the folder is missing or unreadable. */
  listFiles(dir: string): Promise<ModelFile[]>;
}

export type Env = Record<string, string | undefined>;

export const nodeVoiceFs: VoiceFs = {
  async isExecutable(path) {
    try {
      await access(path, constants.X_OK);
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  async isFile(path) {
    return (await stat(path).catch(() => null))?.isFile() ?? false;
  },
  async listFiles(dir) {
    const names = await readdir(dir).catch(() => [] as string[]);
    const files: ModelFile[] = [];
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null);
      if (info?.isFile()) files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    }
    return files;
  },
};

/** Where whisper-cli is looked for: ARCODE_WHISPER_CLI, the Homebrew folders, then PATH. */
export function whisperCandidates(env: Env): string[] {
  const candidates: string[] = [];
  if (env.ARCODE_WHISPER_CLI) candidates.push(env.ARCODE_WHISPER_CLI);
  candidates.push('/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli');
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, 'whisper-cli'));
  }
  return [...new Set(candidates)];
}

export async function locateWhisper(env: Env, fs: VoiceFs): Promise<string | null> {
  for (const candidate of whisperCandidates(env)) {
    if (await fs.isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * The best model among a folder's files: `ggml-*.bin` only, test models skipped, names with
 * `large-v3-turbo` first, then the largest, then the newest.
 */
export function pickModel(files: readonly ModelFile[]): ModelFile | null {
  const models = files.filter(
    (file) => file.name.startsWith('ggml-') && file.name.endsWith('.bin') && !file.name.includes('for-tests'),
  );
  const turbo = (file: ModelFile): number => (file.name.includes('large-v3-turbo') ? 1 : 0);
  models.sort((a, b) => turbo(b) - turbo(a) || b.size - a.size || b.mtimeMs - a.mtimeMs);
  return models[0] ?? null;
}

export function modelDirs(home: string, userData: string): string[] {
  return [join(home, 'models', 'whisper'), join(userData, 'whisper')];
}

export type ModelLookup = { ok: true; path: string } | { ok: false; message: string };

/** ARCODE_WHISPER_MODEL when set (it must exist), else the best model of the first folder that has one. */
export async function locateModel(env: Env, dirs: readonly string[], fs: VoiceFs): Promise<ModelLookup> {
  const override = env.ARCODE_WHISPER_MODEL;
  if (override) {
    return (await fs.isFile(override))
      ? { ok: true, path: override }
      : { ok: false, message: `ARCODE_WHISPER_MODEL points to a missing file: ${override}` };
  }
  for (const dir of dirs) {
    const model = pickModel(await fs.listFiles(dir));
    if (model) return { ok: true, path: join(dir, model.name) };
  }
  return {
    ok: false,
    message: 'No whisper model found, put a ggml model in ~/models/whisper or set ARCODE_WHISPER_MODEL',
  };
}

/** ARCODE_WHISPER_LANG when it looks like a language code (or `auto`), else Russian. */
export function whisperLanguage(env: Env): string {
  const lang = env.ARCODE_WHISPER_LANG?.trim().toLowerCase();
  return lang && /^(auto|[a-z]{2,3})$/.test(lang) ? lang : DEFAULT_LANGUAGE;
}

/** Text only on stdout: no timestamps, no progress or model prints. */
export function whisperArgs(model: string, language: string, file: string): string[] {
  return ['-m', model, '-l', language, '-nt', '-np', '-f', file];
}

/** Trims, joins lines with spaces and drops bracketed tokens such as `[BLANK_AUDIO]` and timestamps. */
export function cleanWhisperOutput(output: string): string {
  return output
    .replace(/\[[^\]\n]*\]/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** RIFF....WAVE header check. */
export function isWav(bytes: Uint8Array): boolean {
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return bytes.byteLength >= 44 && tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

/** Throws when `bytes` is not a WAV within the size cap. */
export function wavBytes(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > VOICE_MAX_WAV_BYTES || !isWav(bytes)) {
    throw new Error('Invalid audio data');
  }
  return bytes;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_OUTPUT_BYTES) return;
      out.push(chunk);
      outBytes += chunk.length;
    });
    // Keep the tail only: whisper logs a lot to stderr, the error is at the end.
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    const finish = (code: number | null): void => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr, timedOut });
    };
    child.on('error', (error) => {
      stderr += String(error);
      finish(null);
    });
    child.on('close', finish);
  });
}

export interface TranscribeOptions {
  env?: Env;
  home?: string;
  userData: string;
  timeoutMs?: number;
  fs?: VoiceFs;
}

/** Transcribes WAV bytes with whisper-cli. Failures are reported in the result, never thrown. */
export async function transcribeWav(bytes: Uint8Array, options: TranscribeOptions): Promise<TranscribeResult> {
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeVoiceFs;
  const whisper = await locateWhisper(env, fs);
  if (!whisper) {
    return {
      ok: false,
      error: 'no-whisper',
      message: 'Install whisper.cpp: brew install whisper-cpp (or set ARCODE_WHISPER_CLI)',
    };
  }
  const model = await locateModel(env, modelDirs(options.home ?? os.homedir(), options.userData), fs);
  if (!model.ok) return { ok: false, error: 'no-model', message: model.message };

  const dir = await mkdtemp(join(os.tmpdir(), 'arcode-voice-'));
  try {
    const file = join(dir, 'audio.wav');
    await writeFile(file, bytes, { mode: 0o600 });
    const timeoutMs = options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
    const result = await run(whisper, whisperArgs(model.path, whisperLanguage(env), file), timeoutMs);
    if (result.timedOut) {
      return {
        ok: false,
        error: 'timeout',
        message: `Transcription took longer than ${Math.round(timeoutMs / 1000)} s; try a shorter recording or a smaller model`,
      };
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim().split('\n').pop() ?? '';
      return { ok: false, error: 'failed', message: `whisper-cli failed${detail ? `: ${detail}` : ''}` };
    }
    return { ok: true, text: cleanWhisperOutput(result.stdout) };
  } catch (error) {
    return { ok: false, error: 'failed', message: `Transcription failed: ${String(error)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
