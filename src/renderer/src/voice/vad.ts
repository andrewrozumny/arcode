/**
 * Energy voice activity detection for the voice chat: decides from the loudness of short frames when
 * the user starts speaking and when a pause means the phrase is finished.
 */

export interface VadOptions {
  /** Pause that ends a phrase. */
  silenceMs?: number;
  /** Less speech than this is a cough or a click, not a phrase. */
  minSpeechMs?: number;
  /** A phrase is cut here even without a pause. */
  maxPhraseMs?: number;
  /** Quietest level that can count as speech, whatever the noise floor. */
  minThreshold?: number;
  /** Speech must be this many times louder than the background noise. */
  floorRatio?: number;
  /** Listening time at the start that only measures the background noise. */
  calibrateMs?: number;
}

export type VadEvent = 'start' | 'end' | 'discard' | null;

/** Root mean square loudness of a frame of samples (-1..1). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export class Vad {
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxPhraseMs: number;
  private readonly minThreshold: number;
  private readonly floorRatio: number;
  private calibrateLeftMs: number;
  private calibrateSum = 0;
  private calibrateFrames = 0;
  /** Background noise level, followed slowly while nobody speaks. */
  private floor = 0.004;
  private inPhrase = false;
  private speechMs = 0;
  private silentMs = 0;
  private phraseMs = 0;

  constructor(options: VadOptions = {}) {
    this.silenceMs = options.silenceMs ?? 1500;
    this.minSpeechMs = options.minSpeechMs ?? 350;
    this.maxPhraseMs = options.maxPhraseMs ?? 60_000;
    this.minThreshold = options.minThreshold ?? 0.012;
    this.floorRatio = options.floorRatio ?? 3;
    this.calibrateLeftMs = options.calibrateMs ?? 600;
  }

  get speaking(): boolean {
    return this.inPhrase;
  }

  threshold(): number {
    return Math.max(this.minThreshold, this.floor * this.floorRatio);
  }

  /** Feeds one frame's loudness and duration; returns what changed. */
  feed(level: number, frameMs: number): VadEvent {
    if (this.calibrateLeftMs > 0) {
      this.calibrateLeftMs -= frameMs;
      this.calibrateSum += level;
      this.calibrateFrames += 1;
      this.floor = Math.max(this.floor, this.calibrateSum / this.calibrateFrames);
      return null;
    }
    const loud = level > this.threshold();
    // The noise floor follows quiet frames down at once and creeps up otherwise: quickly between
    // phrases (a fan was switched on), barely during one (speech must not raise the bar on itself).
    const step = frameMs / 100;
    if (level < this.floor) this.floor = this.floor * 0.7 + level * 0.3;
    else this.floor += (level - this.floor) * (this.inPhrase ? 0.002 : 0.03) * step;
    if (!this.inPhrase) {
      if (!loud) return null;
      this.inPhrase = true;
      this.speechMs = frameMs;
      this.silentMs = 0;
      this.phraseMs = frameMs;
      return 'start';
    }
    this.phraseMs += frameMs;
    if (loud) {
      this.speechMs += frameMs;
      this.silentMs = 0;
    } else {
      this.silentMs += frameMs;
    }
    if (this.silentMs >= this.silenceMs || this.phraseMs >= this.maxPhraseMs) {
      const enough = this.speechMs >= this.minSpeechMs;
      this.reset();
      return enough ? 'end' : 'discard';
    }
    return null;
  }

  /** Forgets the current phrase (the noise floor is kept). */
  reset(): void {
    this.inPhrase = false;
    this.speechMs = 0;
    this.silentMs = 0;
    this.phraseMs = 0;
  }
}
