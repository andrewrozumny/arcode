import { describe, expect, it } from 'vitest';
import type { TtsInfo } from '@shared/voice';
import { readingVoice } from './reading';

const info = (eleven: boolean, silero: boolean): TtsInfo => ({
  elevenlabs: { available: eleven, voices: [{ id: 'ukr', name: 'Ukr', description: '' }, { id: 'nur', name: 'Nur', description: '' }], defaultVoice: 'ukr' },
  silero: { available: silero, voices: [{ id: 'baya', name: 'Baya', description: '' }], defaultVoice: 'baya' },
  system: { available: true, voices: [{ id: 'Milena', name: 'Milena', description: '' }], defaultVoice: 'Milena' },
});

describe('readingVoice', () => {
  it('starts with ElevenLabs only when its key is set up, then Silero, then the macOS voice', () => {
    expect(readingVoice({ engine: null, voices: {} }, info(true, true))).toEqual({ engine: 'elevenlabs', voice: 'ukr' });
    expect(readingVoice({ engine: null, voices: {} }, info(false, true))).toEqual({ engine: 'silero', voice: 'baya' });
    expect(readingVoice({ engine: null, voices: {} }, info(false, false))).toEqual({ engine: 'system', voice: 'Milena' });
  });

  it('keeps the picked engine and voice while they work', () => {
    expect(readingVoice({ engine: 'silero', voices: { elevenlabs: 'nur' } }, info(true, true))).toEqual({ engine: 'silero', voice: 'baya' });
    expect(readingVoice({ engine: 'elevenlabs', voices: { elevenlabs: 'nur' } }, info(true, true))).toEqual({ engine: 'elevenlabs', voice: 'nur' });
  });

  it('falls back when the picked engine or voice is gone', () => {
    expect(readingVoice({ engine: 'elevenlabs', voices: {} }, info(false, true)).engine).toBe('silero');
    expect(readingVoice({ engine: 'elevenlabs', voices: { elevenlabs: 'deleted' } }, info(true, true)).voice).toBe('ukr');
  });

  it('reads with the macOS voice before the engines are known', () => {
    expect(readingVoice({ engine: 'elevenlabs', voices: {} }, null)).toEqual({ engine: 'system', voice: '' });
  });
});
