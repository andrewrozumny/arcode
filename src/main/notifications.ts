import { Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import type { ClaudeStatus, ClaudeStatusEvent } from '@shared/terminal';

/**
 * Tells when a Claude process has just started waiting for the user, so that one notification
 * is shown per waiting period. Pure: the caller decides what to do with the answer.
 */
export class WaitingTransitions {
  private readonly last = new Map<number, ClaudeStatus>();

  /** True only on the step into 'waiting'; repeated 'waiting' events for the same process return false. */
  observe(event: Pick<ClaudeStatusEvent, 'pid' | 'status'>): boolean {
    if (event.status === 'ended') {
      this.last.delete(event.pid);
      return false;
    }
    const previous = this.last.get(event.pid);
    this.last.set(event.pid, event.status);
    return event.status === 'waiting' && previous !== 'waiting';
  }
}

/**
 * Every window's watcher sees every Claude process on the machine (the registry is global); only
 * those whose shell is one of the window's ptys belong to it and may notify in its name.
 */
export function ownedByWindow(event: Pick<ClaudeStatusEvent, 'ptyId'>): boolean {
  return event.ptyId !== null;
}

/** Shows a system notification for a project window that is in the background. Click focuses the window. */
export function notifyWaiting(win: BrowserWindow, event: ClaudeStatusEvent): void {
  if (!Notification.isSupported() || win.isDestroyed() || win.isFocused()) return;
  const notification = new Notification({
    title: win.getTitle(),
    body: event.waitingFor ?? 'Claude is waiting for you',
  });
  notification.on('click', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  notification.show();
}
