import { mkdtemp, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanWhisperOutput,
  isWav,
  locateModel,
  locateWhisper,
  pickModel,
  transcribeWav,
  wavBytes,
  whisperArgs,
  whisperCandidates,
  whisperLanguage,
} from './transcribe';
import type { ModelFile, VoiceFs } from './transcribe';

function fakeFs(executables: string[], dirs: Record<string, ModelFile[]> = {}, files: string[] = []): VoiceFs {
  return {
    isExecutable: async (path) => executables.includes(path),
    isFile: async (path) => files.includes(path),
    listFiles: async (dir) => dirs[dir] ?? [],
  };
}

const model = (name: string, size = 100, mtimeMs = 0): ModelFile => ({ name, size, mtimeMs });

function wavHeader(): Uint8Array {
  const bytes = new Uint8Array(44);
  bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  bytes.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  return bytes;
}

describe('locateWhisper', () => {
  it('prefers ARCODE_WHISPER_CLI, then Homebrew, then PATH', () => {
    expect(whisperCandidates({ ARCODE_WHISPER_CLI: '/x/whisper', PATH: '/usr/bin:/opt/homebrew/bin' })).toEqual([
      '/x/whisper',
      '/opt/homebrew/bin/whisper-cli',
      '/usr/local/bin/whisper-cli',
      '/usr/bin/whisper-cli',
    ]);
  });

  it('returns the first executable candidate', async () => {
    const env = { PATH: '/a:/b' };
    expect(await locateWhisper(env, fakeFs(['/b/whisper-cli']))).toBe('/b/whisper-cli');
    expect(await locateWhisper(env, fakeFs(['/b/whisper-cli', '/usr/local/bin/whisper-cli']))).toBe(
      '/usr/local/bin/whisper-cli',
    );
    expect(await locateWhisper(env, fakeFs([]))).toBeNull();
  });
});

describe('pickModel', () => {
  it('prefers large-v3-turbo, then size, then mtime, and skips non-models and test models', () => {
    expect(
      pickModel([model('ggml-base.bin', 500), model('ggml-large-v3-turbo-q5_0.bin', 300), model('notes.txt', 900)])
        ?.name,
    ).toBe('ggml-large-v3-turbo-q5_0.bin');
    expect(pickModel([model('ggml-small.bin', 200), model('ggml-medium.bin', 400)])?.name).toBe('ggml-medium.bin');
    expect(pickModel([model('ggml-a.bin', 1, 1), model('ggml-b.bin', 1, 2)])?.name).toBe('ggml-b.bin');
    expect(pickModel([model('ggml-for-tests-large.bin', 9999), model('model.bin')])).toBeNull();
  });
});

describe('locateModel', () => {
  it('uses ARCODE_WHISPER_MODEL when it exists and reports it when missing', async () => {
    expect(await locateModel({ ARCODE_WHISPER_MODEL: '/m.bin' }, [], fakeFs([], {}, ['/m.bin']))).toEqual({
      ok: true,
      path: '/m.bin',
    });
    const missing = await locateModel({ ARCODE_WHISPER_MODEL: '/m.bin' }, [], fakeFs([]));
    expect(missing.ok).toBe(false);
  });

  it('takes the first folder with a model', async () => {
    const fs = fakeFs([], { '/home/models/whisper': [], '/data/whisper': [model('ggml-base.bin')] });
    expect(await locateModel({}, ['/home/models/whisper', '/data/whisper'], fs)).toEqual({
      ok: true,
      path: '/data/whisper/ggml-base.bin',
    });
  });

  it('explains where to put a model when none is found', async () => {
    const result = await locateModel({}, ['/nowhere'], fakeFs([]));
    expect(result).toEqual({ ok: false, message: expect.stringContaining('ARCODE_WHISPER_MODEL') });
  });
});

describe('whisper arguments and output', () => {
  it('defaults to Russian and accepts language codes only', () => {
    expect(whisperLanguage({})).toBe('ru');
    expect(whisperLanguage({ ARCODE_WHISPER_LANG: 'EN' })).toBe('en');
    expect(whisperLanguage({ ARCODE_WHISPER_LANG: 'auto' })).toBe('auto');
    expect(whisperLanguage({ ARCODE_WHISPER_LANG: '-m /etc/passwd' })).toBe('ru');
  });

  it('builds an argv with text-only output', () => {
    expect(whisperArgs('/m.bin', 'ru', '/tmp/a.wav')).toEqual(['-m', '/m.bin', '-l', 'ru', '-nt', '-np', '-f', '/tmp/a.wav']);
  });

  it('cleans whisper output', () => {
    expect(cleanWhisperOutput('\n Hello there,\n  second line. \n')).toBe('Hello there, second line.');
    expect(cleanWhisperOutput('[BLANK_AUDIO]\n')).toBe('');
    expect(cleanWhisperOutput('[00:00:00.000 --> 00:00:02.000]   one\n[00:00:02.000 --> 00:00:04.000]  two')).toBe(
      'one two',
    );
  });
});

describe('WAV validation', () => {
  it('accepts RIFF/WAVE bytes only', () => {
    expect(isWav(wavHeader())).toBe(true);
    expect(isWav(new Uint8Array(44))).toBe(false);
    expect(isWav(wavHeader().subarray(0, 12))).toBe(false);
    expect(() => wavBytes('RIFF')).toThrow('Invalid audio data');
    expect(() => wavBytes(new Uint8Array(100))).toThrow('Invalid audio data');
    expect(wavBytes(wavHeader()).byteLength).toBe(44);
  });
});

describe('transcribeWav', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reports a missing whisper-cli or model with a fix', async () => {
    const noWhisper = await transcribeWav(wavHeader(), { userData: '/x', env: {}, fs: fakeFs([]) });
    expect(noWhisper).toMatchObject({ ok: false, error: 'no-whisper', message: expect.stringContaining('brew install') });
    const noModel = await transcribeWav(wavHeader(), {
      userData: '/x',
      home: '/h',
      env: {},
      fs: fakeFs(['/opt/homebrew/bin/whisper-cli']),
    });
    expect(noModel).toMatchObject({ ok: false, error: 'no-model' });
  });

  it('runs the tool with an argv, returns cleaned stdout and removes the temp folder', async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'arcode-voice-test-'));
    const tool = join(dir, 'fake-whisper');
    // Prints its arguments (one per line) and a blank-audio token.
    await writeFile(tool, '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\necho "[BLANK_AUDIO]"\n');
    await chmod(tool, 0o755);
    const modelFile = join(dir, 'ggml-tiny.bin');
    await writeFile(modelFile, '');
    const before = (await readdir(os.tmpdir())).filter((name) => name.startsWith('arcode-voice-') && !name.includes('test'));
    const result = await transcribeWav(wavHeader(), {
      userData: dir,
      env: { ARCODE_WHISPER_CLI: tool, ARCODE_WHISPER_MODEL: modelFile, ARCODE_WHISPER_LANG: 'en' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toMatch(new RegExp(`^-m ${modelFile} -l en -nt -np -f \\S+/audio\\.wav$`));
    const after = (await readdir(os.tmpdir())).filter((name) => name.startsWith('arcode-voice-') && !name.includes('test'));
    expect(after).toEqual(before);
  });

  it('kills the tool on timeout', async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'arcode-voice-test-'));
    const tool = join(dir, 'slow-whisper');
    await writeFile(tool, '#!/bin/sh\nexec sleep 5\n');
    await chmod(tool, 0o755);
    const modelFile = join(dir, 'ggml-tiny.bin');
    await writeFile(modelFile, '');
    const result = await transcribeWav(wavHeader(), {
      userData: dir,
      timeoutMs: 200,
      env: { ARCODE_WHISPER_CLI: tool, ARCODE_WHISPER_MODEL: modelFile },
    });
    expect(result).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('reports a non-zero exit as failed', async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'arcode-voice-test-'));
    const tool = join(dir, 'bad-whisper');
    await writeFile(tool, '#!/bin/sh\necho "error: failed to read audio" >&2\nexit 3\n');
    await chmod(tool, 0o755);
    const modelFile = join(dir, 'ggml-tiny.bin');
    await writeFile(modelFile, '');
    const result = await transcribeWav(wavHeader(), {
      userData: dir,
      env: { ARCODE_WHISPER_CLI: tool, ARCODE_WHISPER_MODEL: modelFile },
    });
    expect(result).toEqual({ ok: false, error: 'failed', message: 'whisper-cli failed: error: failed to read audio' });
  });
});
