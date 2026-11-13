import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOICE_MAX_SPEECH_CHARS } from '@shared/voice';
import { sayArgs, speechText, speechVoice, synthesize } from './speech';

describe('speechVoice', () => {
  it('follows the dictation language', () => {
    expect(speechVoice({})).toBe('Milena');
    expect(speechVoice({ ARCODE_WHISPER_LANG: 'en' })).toBe('Samantha');
    expect(speechVoice({ ARCODE_WHISPER_LANG: 'auto' })).toBeNull();
  });

  it('takes a configured voice and rejects odd values', () => {
    expect(speechVoice({ ARCODE_TTS_VOICE: 'Yuri (Enhanced)' })).toBe('Yuri (Enhanced)');
    expect(speechVoice({ ARCODE_TTS_VOICE: '-o /etc/x' })).toBe('Milena');
  });
});

describe('sayArgs', () => {
  it('reads the text from a file and writes a WAV', () => {
    expect(sayArgs('Milena', '/t/in.txt', '/t/out.wav')).toEqual([
      '-v', 'Milena', '-f', '/t/in.txt', '-o', '/t/out.wav', '--file-format=WAVE', '--data-format=LEI16@22050',
    ]);
    expect(sayArgs(null, 'a', 'b')[0]).toBe('-f');
  });
});

describe('speechText', () => {
  it('validates and caps the text', () => {
    expect(() => speechText(5)).toThrow();
    expect(() => speechText('  ')).toThrow();
    expect(speechText('x'.repeat(VOICE_MAX_SPEECH_CHARS + 10))).toHaveLength(VOICE_MAX_SPEECH_CHARS);
  });
});

describe('synthesize', () => {
  it('returns the WAV the speech program wrote', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'arcode-say-test-'));
    const fake = join(dir, 'say');
    // Copies the text file to the -o path, so the result shows what was rendered.
    writeFileSync(fake, '#!/bin/bash\nwhile [ $# -gt 0 ]; do case "$1" in -f) IN="$2"; shift;; -o) OUT="$2"; shift;; esac; shift; done\ncp "$IN" "$OUT"\n');
    chmodSync(fake, 0o755);
    const result = await synthesize('hello', { say: fake, env: {} });
    expect(result.ok && Buffer.from(result.audio).toString()).toBe('hello');
  });

  it('reports a failing speech program', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'arcode-say-test-'));
    const fake = join(dir, 'say');
    writeFileSync(fake, '#!/bin/bash\necho "no voice" >&2\nexit 1\n');
    chmodSync(fake, 0o755);
    const result = await synthesize('hello', { say: fake, env: {} });
    expect(result).toEqual({ ok: false, message: 'say failed: no voice' });
  });
});
