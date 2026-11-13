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
  { mode: 'dictate', label: 'Dictation', hint: 'Types what you say into Claude\'s prompt; you edit and press Enter' },
  { mode: 'command', label: 'Commands', hint: 'Sends each phrase to Claude; it works without talking back' },
  { mode: 'chat', label: 'Conversation', hint: 'Sends each phrase and reads Claude\'s answer aloud (without code)' },
];

const MODE_KEY = 'arcode.voiceChat.mode';

export function loadVoiceMode(): VoiceMode {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'dictate' || saved === 'command' || saved === 'chat') return saved;
  } catch {
    // Storage unavailable: use the default.
  }
  return 'command';
}

export function saveVoiceMode(mode: VoiceMode): void {
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
