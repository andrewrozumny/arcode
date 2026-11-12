import type { PtyId } from '@shared/ipc';
import type { PtyActivity } from '@shared/terminal';
import type { TerminalTab } from '../terminal/types';

/**
 * - `working`: something runs (Claude is busy, a command or a gate runs, Claude has a background shell).
 * - `waiting`: nothing runs, but a Claude tab waits for the user, so the work is not finished.
 * - `idle`: everything is done.
 */
export type ActivityState = 'working' | 'waiting' | 'idle';

export interface ActivityItem {
  /** Tab title the item belongs to. */
  tab: string;
  /** What happens there, in a few words. */
  text: string;
  kind: 'claude' | 'background' | 'command' | 'gate' | 'waiting';
  ptyId: PtyId | null;
}

export interface ActivitySummary {
  state: ActivityState;
  items: ActivityItem[];
}

/** Work going on in this window's terminal tabs, for the header lamp. */
export function activitySummary(tabs: readonly TerminalTab[], activity: readonly PtyActivity[]): ActivitySummary {
  const jobsByPty = new Map(activity.map((a) => [a.ptyId, a.jobs]));
  const items: ActivityItem[] = [];
  for (const tab of tabs) {
    if (tab.exited) continue;
    const ptyId = tab.ptyId ?? null;
    const jobs = ptyId !== null ? (jobsByPty.get(ptyId) ?? []) : [];
    const claudeBusy = tab.claudeStatus === 'busy' || tab.claudeStatus === 'shell';
    if (claudeBusy) items.push({ tab: tab.title, text: 'Claude is working', kind: 'claude', ptyId });
    else if (tab.claudeStatus === 'waiting') {
      items.push({ tab: tab.title, text: tab.waitingFor ? `Waits for you: ${tab.waitingFor}` : 'Waits for you', kind: 'waiting', ptyId });
    }
    const gateRunning = tab.gate?.state === 'running';
    if (tab.gate && gateRunning) items.push({ tab: tab.title, text: `Gate ${tab.gate.target} is running`, kind: 'gate', ptyId });
    for (const job of jobs) {
      if (job.source === 'claude') {
        // While Claude is busy its shell is the current tool call; once it is idle the shell holds on in the background.
        items.push({ tab: tab.title, text: claudeBusy ? job.command : `Background: ${job.command}`, kind: claudeBusy ? 'claude' : 'background', ptyId });
      } else if (!gateRunning && tab.kind !== 'claude') {
        items.push({ tab: tab.title, text: job.command, kind: 'command', ptyId });
      }
    }
  }
  const running = items.some((i) => i.kind !== 'waiting');
  const state: ActivityState = running ? 'working' : items.length > 0 ? 'waiting' : 'idle';
  return { state, items };
}

export interface ModelChoice {
  /** Argument of `/model`. */
  arg: string;
  label: string;
  /** Model id the choice selects, to mark the current one; null for the account default. */
  id: string | null;
}

/** Models offered by the header's model menu, newest family first. */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { arg: 'claude-fable-5-2', label: 'Fable 5.2', id: 'claude-fable-5-2' },
  { arg: 'claude-opus-5-5', label: 'Opus 5.5', id: 'claude-opus-5-5' },
  { arg: 'claude-sonnet-5-5', label: 'Sonnet 5.5', id: 'claude-sonnet-5-5' },
  { arg: 'claude-haiku-5-5', label: 'Haiku 5.5', id: 'claude-haiku-5-5' },
  { arg: 'default', label: 'Account default', id: null },
];

/** Whether a model id (possibly with a suffix such as `[1m]`) is the one a choice selects. */
export function isCurrentModel(choice: ModelChoice, current: string | null | undefined): boolean {
  return choice.id !== null && !!current && current.replace(/\[.*\]$/, '') === choice.id;
}

/**
 * Commands typed into Claude Code only land as commands while it waits at an empty prompt: while it
 * works they would be queued as a message, and while it asks something they would answer the question.
 */
export function claudeReady(tab: Pick<TerminalTab, 'kind' | 'claudeStatus' | 'ptyId'> | null | undefined): boolean {
  return !!tab && tab.kind === 'claude' && tab.claudeStatus === 'idle' && tab.ptyId !== undefined;
}

export type RemoteControlState = 'off' | 'starting' | 'on' | 'failed';

/** How long a `/remote-control` may take to report a bridge session before the button says it failed. */
export const REMOTE_CONTROL_TIMEOUT_MS = 30_000;

/** State of the Remote Control button from the tab's bridge id and the time of the last request. */
export function remoteControlState(bridgeId: string | null | undefined, requestedAt: number | null, now: number): RemoteControlState {
  if (bridgeId) return 'on';
  if (requestedAt === null) return 'off';
  return now - requestedAt < REMOTE_CONTROL_TIMEOUT_MS ? 'starting' : 'failed';
}
