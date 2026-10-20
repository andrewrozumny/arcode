import { describe, expect, it } from 'vitest';
import { ownedByWindow, waitingNotificationText, WaitingTransitions } from './notifications';

describe('WaitingTransitions', () => {
  it('reports only the step into waiting', () => {
    const t = new WaitingTransitions();
    expect(t.observe({ pid: 1, status: 'busy' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'busy' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
  });

  it('tracks processes separately', () => {
    const t = new WaitingTransitions();
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
    expect(t.observe({ pid: 2, status: 'waiting' })).toBe(true);
  });

  it('forgets a process that ended, so its next waiting period notifies again', () => {
    const t = new WaitingTransitions();
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
    expect(t.observe({ pid: 1, status: 'ended' })).toBe(false);
    expect(t.observe({ pid: 1, status: 'waiting' })).toBe(true);
  });
});

describe('ownedByWindow', () => {
  it('accepts only processes started from one of the window ptys', () => {
    expect(ownedByWindow({ ptyId: 3 })).toBe(true);
    expect(ownedByWindow({ ptyId: null })).toBe(false);
  });
});

describe('waitingNotificationText', () => {
  it('names the project and the tab, with the reason Claude waits', () => {
    expect(waitingNotificationText('orbit-api', 'Review', { name: 'session', waitingFor: 'permission to run Bash' })).toEqual({
      title: 'orbit-api',
      subtitle: 'Review',
      body: 'Claude is waiting: permission to run Bash',
    });
  });

  it('falls back to the session name, then to Claude, and to a generic body', () => {
    expect(waitingNotificationText('p', undefined, { name: 'fix tests', waitingFor: null })).toEqual({
      title: 'p',
      subtitle: 'fix tests',
      body: 'Claude is waiting for you',
    });
    expect(waitingNotificationText('p', '  ', { name: null, waitingFor: '  ' }).subtitle).toBe('Claude');
  });
});
