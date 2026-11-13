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
  const t = (status: TerminalTab['claudeStatus']) => ({ ptyId: 1, status, title: 'c', sessionId: 's' });

  it('lets phrases through while Claude is idle or working (they are queued)', () => {
    expect(pauseReason(t('idle'))).toBeNull();
    expect(pauseReason(t('busy'))).toBeNull();
    expect(pauseReason(t('shell'))).toBeNull();
  });

  it('holds phrases while Claude asks something or does not run', () => {
    expect(pauseReason(t('waiting'))).toMatch(/answer in the terminal/);
    expect(pauseReason(t(undefined))).toMatch(/not running/);
    expect(pauseReason(null)).toMatch(/Open a Claude tab/);
  });

  it('pauses while ARcode is in the background', () => {
    expect(pauseReason(t('idle'), false)).toBe('ARcode is in the background');
  });
});

describe('voiceTarget session', () => {
  it('carries the session id for reading answers', () => {
    const tab = claude('a', 2, { claude: { sessionId: 'abc', name: 'a', resumed: false } });
    expect(voiceTarget([tab], tab)?.sessionId).toBe('abc');
  });
});
