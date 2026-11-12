import { describe, expect, it } from 'vitest';
import { downsample, encodeWav, formatElapsed } from './wav';

const tag = (bytes: Uint8Array, offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));

describe('encodeWav', () => {
  it('writes a 16-bit mono PCM header', () => {
    const wav = encodeWav(new Float32Array(10), 16_000);
    const view = new DataView(wav.buffer);
    expect(wav.byteLength).toBe(44 + 20);
    expect(tag(wav, 0)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 20);
    expect(tag(wav, 8)).toBe('WAVE');
    expect(tag(wav, 12)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(tag(wav, 36)).toBe('data');
    expect(view.getUint32(40, true)).toBe(20);
  });

  it('scales and clamps samples', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]), 16_000);
    const view = new DataView(wav.buffer);
    const samples = [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it('encodes an empty recording as a header only', () => {
    expect(encodeWav(new Float32Array(0), 16_000).byteLength).toBe(44);
  });
});

describe('formatElapsed', () => {
  it('formats minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7.9)).toBe('0:07');
    expect(formatElapsed(65)).toBe('1:05');
    expect(formatElapsed(-3)).toBe('0:00');
  });
});

describe('downsample', () => {
  it('averages spans of the input', () => {
    const out = downsample(new Float32Array([1, 1, 1, 0, 0, 0]), 48_000, 16_000);
    expect([...out]).toEqual([1, 0]);
  });

  it('leaves lower rates alone', () => {
    const input = new Float32Array([0.5]);
    expect(downsample(input, 16_000, 16_000)).toBe(input);
  });
});
