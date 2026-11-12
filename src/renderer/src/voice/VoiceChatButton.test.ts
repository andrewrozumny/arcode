import { describe, expect, it } from 'vitest';
import type { TerminalTab } from '../terminal/types';
import { pauseReason } from './useVoiceChat';
import { voiceTarget } from './VoiceChatButton';

const claude = (id: string, ptyId: number, over: Partial<TerminalTab> = {}): TerminalTab => ({
  id,
  kind: 'claude',
  title: id,
  ptyId,
  claudeStatus: 'idle',
  ...over,
});
const shell: TerminalTab = { id: 'sh', kind: 'shell', title: 'Shell', ptyId: 1 };

describe('voiceTarget', () => {
  it('talks to the active Claude tab', () => {
    const a = claude('a', 2);
    const b = claude('b', 3);
    expect(voiceTarget([a, b], a)?.ptyId).toBe(2);
  });

  it('falls back to the last Claude tab while a shell is active', () => {
    expect(voiceTarget([claude('a', 2), shell, claude('b', 3)], shell)?.ptyId).toBe(3);
  });

  it('skips exited tabs and tabs without a terminal', () => {
    expect(voiceTarget([claude('a', 2, { exited: true })], null)).toBeNull();
    expect(voiceTarget([shell], shell)).toBeNull();
  });
});

describe('pauseReason', () => {
  it('only lets an idle Claude through', () => {
    expect(pauseReason({ ptyId: 1, status: 'idle', title: 'c' })).toBeNull();
    expect(pauseReason({ ptyId: 1, status: 'busy', title: 'c' })).toBe('Claude is working');
    expect(pauseReason({ ptyId: 1, status: 'waiting', title: 'c' })).toMatch(/answer in the terminal/);
    expect(pauseReason({ ptyId: 1, status: undefined, title: 'c' })).toMatch(/not running/);
    expect(pauseReason(null)).toMatch(/Open a Claude tab/);
  });
});
