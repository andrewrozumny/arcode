import type { TtsEngine, TtsInfo } from '@shared/voice';
import type { ReadingVoice } from './useVoiceChat';

/** The engine and the voice picked per engine, remembered in this browser profile. */
export interface ReadingChoice {
  engine: TtsEngine | null;
  voices: Partial<Record<TtsEngine, string>>;
}

const KEY = 'arcode.voiceChat.reading';
/** First available engine when none was picked: the cloud voice only when it was set up on purpose. */
const ORDER: readonly TtsEngine[] = ['elevenlabs', 'silero', 'system'];

export const ENGINE_LABEL: Record<TtsEngine, string> = {
  elevenlabs: 'ElevenLabs (cloud)',
  silero: 'Silero (on this Mac)',
  system: 'macOS voice',
};

export function loadReadingChoice(): ReadingChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;
    if (raw && typeof raw === 'object') {
      const { engine, voices } = raw as { engine?: unknown; voices?: unknown };
      const picked: Partial<Record<TtsEngine, string>> = {};
      if (voices && typeof voices === 'object') {
        for (const e of ORDER) {
          const v = (voices as Record<string, unknown>)[e];
          if (typeof v === 'string' && v.length <= 64) picked[e] = v;
        }
      }
      return { engine: ORDER.find((e) => e === engine) ?? null, voices: picked };
    }
  } catch {
    // Nothing saved, or storage unavailable.
  }
  return { engine: null, voices: {} };
}

export function saveReadingChoice(choice: ReadingChoice): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    // A convenience; losing it is fine.
  }
}

/** The engine and voice to read with: the picked ones when usable, else the first engine that works. */
export function readingVoice(choice: ReadingChoice, info: TtsInfo | null): ReadingVoice {
  const usable = (engine: TtsEngine): boolean => (info ? info[engine].available : engine === 'system');
  const engine = choice.engine && usable(choice.engine) ? choice.engine : (ORDER.find(usable) ?? 'system');
  const known = info?.[engine].voices ?? [];
  const picked = choice.voices[engine];
  const voice = picked && (known.length === 0 || known.some((v) => v.id === picked)) ? picked : (info?.[engine].defaultVoice ?? '');
  return { engine, voice };
}
