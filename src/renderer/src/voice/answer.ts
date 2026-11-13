import type { FeedItem } from '@shared/claude';

/**
 * Claude's answer to the latest prompt in a feed range: the last assistant text after the last user
 * prompt (the final message of the turn, not the "let me check" lines between tool calls).
 */
export function turnAnswer(items: readonly FeedItem[]): string | null {
  let answer: string | null = null;
  for (const item of items) {
    if (item.kind === 'user') answer = null;
    else if (item.kind === 'assistant' && item.text.trim()) answer = item.text;
  }
  return answer;
}

export type VoiceMode = 'dictate' | 'command' | 'chat';

export const VOICE_MODES: readonly { mode: VoiceMode; label: string; hint: string }[] = [
  { mode: 'dictate', label: 'Type into the prompt', hint: 'Types what you say into Claude\'s prompt; keep talking or edit, then press Enter' },
  { mode: 'command', label: 'Send each phrase', hint: 'Sends each phrase to Claude as soon as you pause' },
  { mode: 'chat', label: 'Discussion', hint: 'Talk about the work in your Claude Code session; the partner answers aloud and never changes anything' },
];

/** Modes of the dictation button in the terminal; the live chat button is always `chat`. */
export type DictationMode = Extract<VoiceMode, 'dictate' | 'command'>;

const MODE_KEY = 'arcode.voiceDictation.mode';

export function loadDictationMode(): DictationMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'dictate' || saved === 'command') return saved;
  } catch {
    // Storage unavailable: use the default.
  }
  return 'dictate';
}

export function saveDictationMode(mode: DictationMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // The mode is a convenience; losing it is fine.
  }
}

/** Text typed into the prompt for a dictated phrase: phrases after the first are joined with a space. */
export function dictationText(text: string, continuing: boolean): string {
  return continuing ? ` ${text}` : text;
}
