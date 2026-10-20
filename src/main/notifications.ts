import { app, Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import type { PtyId } from '@shared/ipc';
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

export interface WaitingNotificationText {
  title: string;
  subtitle: string;
  body: string;
}

/**
 * What the notification says: the project as the title and the tab as the subtitle, so several
 * waiting tabs stay apart in Notification Center. The tab title the renderer reported wins over
 * the session name.
 */
export function waitingNotificationText(
  project: string,
  tabTitle: string | undefined,
  event: Pick<ClaudeStatusEvent, 'name' | 'waitingFor'>,
): WaitingNotificationText {
  const tab = tabTitle?.trim() || event.name?.trim() || 'Claude';
  const reason = event.waitingFor?.trim();
  return {
    title: project,
    subtitle: tab,
    body: reason ? `Claude is waiting: ${reason}` : 'Claude is waiting for you',
  };
}

export interface NotifyWaitingOptions {
  /** Project name shown as the title. */
  project: string;
  /** Title of the terminal tab, when the renderer reported one. */
  tabTitle: string | undefined;
  /** Play the system notification sound. */
  sound: boolean;
  /** Called on click with the waiting pty, after the window came forward. */
  onClick(ptyId: PtyId): void;
}

/** Shown notifications, kept alive until clicked or closed: a collected one would drop its click handler. */
const shown = new Set<Notification>();
const MAX_SHOWN = 50;

/**
 * Shows a system notification for a project window that is in the background. A click brings the
 * window forward and hands the pty to `onClick`, which selects its tab.
 */
export function notifyWaiting(win: BrowserWindow, event: ClaudeStatusEvent, options: NotifyWaitingOptions): void {
  if (!Notification.isSupported() || win.isDestroyed() || win.isFocused()) return;
  const text = waitingNotificationText(options.project, options.tabTitle, event);
  const notification = new Notification({
    title: text.title,
    subtitle: text.subtitle,
    body: text.body,
    // Without `silent` macOS plays the default sound; the setting decides.
    silent: !options.sound,
  });
  const ptyId = event.ptyId;
  shown.add(notification);
  // Ignored notifications never report back; let the oldest go so the set stays small.
  if (shown.size > MAX_SHOWN) shown.delete(shown.values().next().value as Notification);
  notification.on('close', () => shown.delete(notification));
  notification.on('click', () => {
    shown.delete(notification);
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
    if (ptyId !== null) options.onClick(ptyId);
  });
  notification.show();
}
