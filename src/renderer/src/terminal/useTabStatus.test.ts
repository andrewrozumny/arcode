import { describe, expect, it } from 'vitest';
import type { ClaudeStatusEvent } from '@shared/terminal';
import { claudeStatusPatch, tabOfStatus } from './useTabStatus';
import type { TerminalTab } from './types';

const event = (over: Partial<ClaudeStatusEvent> = {}): ClaudeStatusEvent => ({
  pid: 100,
  sessionId: 's1',
  status: 'busy',
  waitingFor: null,
  name: null,
  cwd: null,
  model: 'claude-opus-5-5',
  modelName: 'Opus 5.5',
  ptyId: 7,
  ...over,
});

const claudeTab = (sessionId: string, ptyId = 7): TerminalTab => ({
  id: 'tab',
  kind: 'claude',
  title: 'Claude',
  ptyId,
  claude: { sessionId, name: 'Claude', resumed: false },
});

describe('tabOfStatus', () => {
  it('prefers the tab whose pty started the process', () => {
    const own = claudeTab('other', 7);
    const bySession = claudeTab('s1', 9);
    expect(tabOfStatus([bySession, own], event())).toBe(own);
  });

  it('falls back to the tab that shows the session', () => {
    const bySession = claudeTab('s1', 9);
    expect(tabOfStatus([claudeTab('x', 8), bySession], event({ ptyId: null }))).toBe(bySession);
    expect(tabOfStatus([claudeTab('x', 8)], event({ ptyId: null }))).toBeUndefined();
  });
});

describe('claudeStatusPatch', () => {
  it('copies status and model onto the tab', () => {
    expect(claudeStatusPatch(claudeTab('s1'), event({ status: 'waiting', waitingFor: 'permission' }))).toEqual({
      claudeStatus: 'waiting',
      waitingFor: 'permission',
      claudeModel: 'claude-opus-5-5',
      claudeModelName: 'Opus 5.5',
    });
  });

  it('clears everything when the process ended and keeps the session id', () => {
    const patch = claudeStatusPatch(claudeTab('s1'), event({ status: 'ended' }));
    expect(patch).toEqual({ claudeStatus: undefined, waitingFor: undefined, claudeModel: undefined, claudeModelName: undefined });
    expect(patch).not.toHaveProperty('claude');
  });

  it('takes the id of a new session started by hand in the tab', () => {
    const tab: TerminalTab = { ...claudeTab('s1'), claude: { sessionId: 's1', name: 'Work', resumed: true } };
    const patch = claudeStatusPatch(tab, event({ sessionId: 's2' }));
    expect(patch.claude).toEqual({ sessionId: 's2', name: 'Work', resumed: false });
  });

  it('leaves the session id alone when it matches or the process is not from this tab', () => {
    expect(claudeStatusPatch(claudeTab('s1'), event())).not.toHaveProperty('claude');
    expect(claudeStatusPatch(claudeTab('s1', 9), event({ sessionId: 's2', ptyId: 7 }))).not.toHaveProperty('claude');
    expect(claudeStatusPatch(claudeTab('s1'), event({ sessionId: 's2', ptyId: null }))).not.toHaveProperty('claude');
    expect(claudeStatusPatch(claudeTab('s1'), event({ sessionId: null }))).not.toHaveProperty('claude');
  });

  it('turns a shell tab into a Claude tab when claude is run in it', () => {
    const shell: TerminalTab = { id: 'sh', kind: 'shell', title: 'Shell', ptyId: 7 };
    expect(claudeStatusPatch(shell, event({ sessionId: 's2', name: 'Review' }))).toMatchObject({
      kind: 'claude',
      title: 'Review',
      claude: { sessionId: 's2', name: 'Review', resumed: false },
    });
    expect(claudeStatusPatch(shell, event({ sessionId: 's2' })).title).toBe('Shell');
  });

  it('leaves a shell tab alone for a process from another pty or without a session', () => {
    const shell: TerminalTab = { id: 'sh', kind: 'shell', title: 'Shell', ptyId: 7 };
    expect(claudeStatusPatch(shell, event({ sessionId: 's2', ptyId: 9 }))).not.toHaveProperty('kind');
    expect(claudeStatusPatch(shell, event({ sessionId: null }))).not.toHaveProperty('kind');
  });
});
