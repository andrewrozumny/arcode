import { describe, expect, it } from 'vitest';
import type { TerminalTab } from '../terminal/types';
import {
  MODEL_CHOICES,
  REMOTE_CONTROL_TIMEOUT_MS,
  activitySummary,
  claudeReady,
  isCurrentModel,
  remoteControlSettled,
  remoteControlState,
} from './activityModel';

const shell = (over: Partial<TerminalTab> = {}): TerminalTab => ({ id: 's', kind: 'shell', title: 'Shell', ptyId: 1, ...over });
const claude = (over: Partial<TerminalTab> = {}): TerminalTab => ({
  id: 'c',
  kind: 'claude',
  title: 'Claude',
  ptyId: 2,
  claudeStatus: 'idle',
  ...over,
});

describe('activitySummary', () => {
  it('is idle when nothing runs', () => {
    expect(activitySummary([shell(), claude()], [{ ptyId: 1, jobs: [] }])).toEqual({ state: 'idle', items: [] });
  });

  it('works while Claude is busy, listing its current shell command', () => {
    const summary = activitySummary([claude({ claudeStatus: 'busy' })], [{ ptyId: 2, jobs: [{ command: 'pnpm test', source: 'claude' }] }]);
    expect(summary.state).toBe('working');
    expect(summary.items.map((i) => i.text)).toEqual(['Claude is working', 'pnpm test']);
  });

  it('reports a shell Claude left running in the background', () => {
    const summary = activitySummary([claude()], [{ ptyId: 2, jobs: [{ command: 'pnpm dev', source: 'claude' }] }]);
    expect(summary).toEqual({
      state: 'working',
      items: [{ tab: 'Claude', text: 'Background: pnpm dev', kind: 'background', ptyId: 2 }],
    });
  });

  it('reports commands of shell tabs and running gates once', () => {
    const gate = shell({ id: 'g', kind: 'gate', title: 'Gate: all', ptyId: 3, gate: { target: 'all', state: 'running' } });
    const summary = activitySummary(
      [shell(), gate],
      [
        { ptyId: 1, jobs: [{ command: 'pnpm dev', source: 'shell' }] },
        { ptyId: 3, jobs: [{ command: 'bash scripts/gates.sh all', source: 'shell' }] },
      ],
    );
    expect(summary.items.map((i) => i.text)).toEqual(['pnpm dev', 'Gate all is running']);
  });

  it('waits when Claude asks something and nothing runs', () => {
    const summary = activitySummary([claude({ claudeStatus: 'waiting', waitingFor: 'permission' })], []);
    expect(summary.state).toBe('waiting');
    expect(summary.items[0]?.text).toBe('Waits for you: permission');
  });

  it('skips exited tabs', () => {
    expect(activitySummary([claude({ claudeStatus: 'busy', exited: true })], []).state).toBe('idle');
  });
});

describe('model choices', () => {
  it('marks the current model, ignoring a context suffix', () => {
    const opus = MODEL_CHOICES.find((c) => c.label === 'Opus 5.5');
    expect(opus && isCurrentModel(opus, 'claude-opus-5-5[1m]')).toBe(true);
    expect(opus && isCurrentModel(opus, 'claude-sonnet-5-5')).toBe(false);
    const fallback = MODEL_CHOICES.find((c) => c.id === null);
    expect(fallback && isCurrentModel(fallback, 'claude-opus-5-5')).toBe(false);
  });
});

describe('claudeReady', () => {
  it('only accepts an idle Claude tab with a pty', () => {
    expect(claudeReady(claude())).toBe(true);
    expect(claudeReady(claude({ claudeStatus: 'busy' }))).toBe(false);
    expect(claudeReady(claude({ claudeStatus: 'waiting' }))).toBe(false);
    expect(claudeReady(shell())).toBe(false);
    expect(claudeReady(null)).toBe(false);
  });
});

describe('remoteControlState', () => {
  const start = { kind: 'start' as const, at: 1000 };
  const stop = { kind: 'stop' as const, at: 1000 };

  it('follows the bridge id without a request', () => {
    expect(remoteControlState('session_1', null, 0)).toBe('on');
    expect(remoteControlState(null, null, 0)).toBe('off');
  });

  it('starts, then fails after the timeout', () => {
    expect(remoteControlState(null, start, 2000)).toBe('starting');
    expect(remoteControlState('session_1', start, 2000)).toBe('on');
    expect(remoteControlState(null, start, 1000 + REMOTE_CONTROL_TIMEOUT_MS)).toBe('failed');
  });

  it('stops, then reports a stop that did not happen', () => {
    expect(remoteControlState('session_1', stop, 2000)).toBe('stopping');
    expect(remoteControlState(null, stop, 2000)).toBe('off');
    expect(remoteControlState('session_1', stop, 1000 + REMOTE_CONTROL_TIMEOUT_MS)).toBe('stopFailed');
  });

  it('settles requests by their goal', () => {
    expect(remoteControlSettled('x', start)).toBe(true);
    expect(remoteControlSettled(null, stop)).toBe(true);
    expect(remoteControlSettled(null, start)).toBe(false);
  });
});
