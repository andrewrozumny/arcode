/**
 * Silero, a neural Russian voice that runs on this Mac: one helper process
 * (`resources/arcode-tts-silero.py`) keeps the model loaded and renders each piece of text to WAV.
 * The Python with `silero` and `torch` comes from `ARCODE_SILERO_PYTHON` or `~/models/silero/.venv`.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import type { SpeechResult, TtsVoice } from '@shared/voice';

export const SILERO_SCRIPT = 'arcode-tts-silero.py';
export const DEFAULT_SPEAKER = 'baya';
/** First start loads (or downloads) the model; later requests take well under a second. */
const START_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 30_000;

export const SILERO_VOICES: readonly TtsVoice[] = [
  { id: 'baya', name: 'Baya', description: 'female' },
  { id: 'xenia', name: 'Xenia', description: 'female, lower' },
  { id: 'kseniya', name: 'Kseniya', description: 'female' },
  { id: 'aidar', name: 'Aidar', description: 'male' },
  { id: 'eugene', name: 'Eugene', description: 'male, low' },
];

export function sileroPython(env: Record<string, string | undefined>, home = os.homedir()): string {
  const configured = env.ARCODE_SILERO_PYTHON?.trim();
  return configured || join(home, 'models', 'silero', '.venv', 'bin', 'python');
}

export function speaker(value: unknown): string {
  return SILERO_VOICES.some((v) => v.id === value) ? (value as string) : DEFAULT_SPEAKER;
}

interface Pending {
  resolve(line: Record<string, unknown>): void;
  timer: NodeJS.Timeout;
}

export class Silero {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private readonly waiting: Pending[] = [];
  /** Requests run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly script: string,
    private readonly python: string,
  ) {}

  /** Whether the Python of the Silero environment exists (the model itself is checked on first use). */
  async available(): Promise<boolean> {
    try {
      await access(this.python, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const next = this.waiting.shift();
    if (!next) return;
    clearTimeout(next.timer);
    next.resolve(message);
  }

  private nextLine(timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const pending: Pending = {
        resolve,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(pending);
          if (index >= 0) this.waiting.splice(index, 1);
          resolve({ ok: false, error: 'Silero did not answer in time' });
          this.stop();
        }, timeoutMs),
      };
      this.waiting.push(pending);
    });
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    // The model files are kept next to the environment (Silero downloads them into the working folder).
    const child = spawn(this.python, [this.script], { cwd: dirname(dirname(dirname(this.python))), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.on('data', () => undefined);
    const onGone = (): void => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      for (const pending of this.waiting.splice(0)) {
        clearTimeout(pending.timer);
        pending.resolve({ ok: false, error: 'Silero stopped' });
      }
    };
    child.on('exit', onGone);
    child.on('error', onGone);
    this.ready = this.nextLine(START_TIMEOUT_MS).then((hello) => {
      if (hello.ok !== true) {
        this.stop();
        throw new Error(typeof hello.error === 'string' ? hello.error : 'Silero could not start');
      }
    });
    return this.ready;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    if (child && !child.killed) child.kill();
  }

  speak(text: string, voice: unknown): Promise<SpeechResult> {
    const run = async (): Promise<SpeechResult> => {
      const dir = await mkdtemp(join(os.tmpdir(), 'arcode-silero-'));
      try {
        await this.start();
        const out = join(dir, 'speech.wav');
        const answer = this.nextLine(REQUEST_TIMEOUT_MS);
        this.child?.stdin.write(`${JSON.stringify({ text, speaker: speaker(voice), out })}\n`);
        const result = await answer;
        if (result.ok !== true) return { ok: false, message: `Silero: ${typeof result.error === 'string' ? result.error : 'failed'}` };
        return { ok: true, audio: new Uint8Array(await readFile(out)) };
      } catch (error) {
        return { ok: false, message: `Silero: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
