import { describe, expect, it } from 'vitest';
import { rms, Vad } from './vad';

const run = (vad: Vad, levels: number[], frameMs = 100): string[] =>
  levels.map((level) => vad.feed(level, frameMs)).filter((e): e is NonNullable<typeof e> => e !== null);

describe('rms', () => {
  it('measures loudness', () => {
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array())).toBe(0);
  });
});

describe('Vad', () => {
  it('ends a phrase after the pause', () => {
    const vad = new Vad({ silenceMs: 500, minSpeechMs: 200, calibrateMs: 0 });
    const events = run(vad, [0.001, 0.001, 0.2, 0.2, 0.2, 0.001, 0.001, 0.001, 0.001, 0.001]);
    expect(events).toEqual(['start', 'end']);
    expect(vad.speaking).toBe(false);
  });

  it('keeps a phrase going through short pauses', () => {
    const vad = new Vad({ silenceMs: 500, minSpeechMs: 200, calibrateMs: 0 });
    expect(run(vad, [0.2, 0.2, 0.001, 0.001, 0.2, 0.2])).toEqual(['start']);
    expect(vad.speaking).toBe(true);
  });

  it('discards a click', () => {
    const vad = new Vad({ silenceMs: 300, minSpeechMs: 300, calibrateMs: 0 });
    expect(run(vad, [0.3, 0.001, 0.001, 0.001])).toEqual(['start', 'discard']);
  });

  it('measures a noisy room first and does not take the noise for speech', () => {
    const vad = new Vad({ minThreshold: 0.01 });
    expect(run(vad, Array.from({ length: 50 }, () => 0.018))).toEqual([]);
    expect(vad.threshold()).toBeGreaterThan(0.05);
    expect(run(vad, [0.2, 0.2, 0.2, 0.2, 0.2, 0.018, ...Array.from({ length: 15 }, () => 0.018)])).toEqual(['start', 'end']);
  });

  it('raises the bar when noise starts between phrases', () => {
    const vad = new Vad({ minThreshold: 0.01, calibrateMs: 0, silenceMs: 500 });
    const events = run(vad, Array.from({ length: 300 }, () => 0.02));
    // The first noisy frames may open one phrase; once the floor has caught up it ends and stays quiet.
    expect(events.length).toBeLessThanOrEqual(2);
    expect(vad.speaking).toBe(false);
  });

  it('cuts a phrase that never pauses', () => {
    const vad = new Vad({ maxPhraseMs: 1000, calibrateMs: 0 });
    expect(run(vad, Array.from({ length: 12 }, () => 0.3))).toEqual(['start', 'end', 'start']);
  });
});
