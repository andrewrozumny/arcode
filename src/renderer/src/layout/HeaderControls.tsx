import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { remoteControlUrl } from '@shared/terminal';
import type { PtyActivity } from '@shared/terminal';
import { bus } from '../bus';
import type { BadgeModel } from '../claude/liveUsage';
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
import type { ActivityItem, RemoteControlRequest } from './activityModel';
import { modelLabel } from './ClaudeBadges';
import { modelFamily } from './modelFamily';

/** Open state of a header menu that closes on Escape and on a click outside `root`. */
function usePopover(root: RefObject<HTMLElement | null>): [boolean, (open: boolean | ((v: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, root]);
  return [open, setOpen];
}

function notReadyReason(tab: TerminalTab): string {
  if (tab.claudeStatus === 'waiting') return 'Claude is waiting for an answer in the terminal';
  if (tab.claudeStatus === 'busy' || tab.claudeStatus === 'shell') return 'Claude is working; try again when it is done';
  return 'Claude Code is not running in this tab yet';
}

/** Model of the active Claude tab; a click lists the models and switches with `/model`. */
export function ModelPicker({ model, tab }: { model: BadgeModel | null; tab: TerminalTab }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = usePopover(rootRef);
  const ready = claudeReady(tab);
  const family = model ? modelFamily(model.id) : 'other';
  const label = model ? (model.name ?? modelLabel(model.id)) : 'Model';

  const choose = (arg: string): void => {
    setOpen(false);
    if (tab.ptyId !== undefined) bus.emit('sendToPty', { ptyId: tab.ptyId, text: `/model ${arg}` });
  };

  return (
    <span className="header-menu-wrap" ref={rootRef}>
      <button
        type="button"
        className={`model-badge model-picker family-${family}`}
        title={open ? undefined : `${model?.id ?? 'Model unknown'}. Click to switch`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <span className="model-picker-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <span className="header-menu" role="menu">
          {!ready && <span className="header-menu-note">{notReadyReason(tab)}</span>}
          {MODEL_CHOICES.map((choice) => {
            const current = isCurrentModel(choice, model?.id);
            return (
              <button
                key={choice.arg}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                className={current ? 'header-menu-item current' : 'header-menu-item'}
                disabled={!ready || current}
                onClick={() => choose(choice.arg)}
              >
                <span className={`agents-chip-dot model-family-${choice.id ? modelFamily(choice.id) : 'other'}`} aria-hidden="true" />
                <span className="header-menu-label">{choice.label}</span>
                {current && <span className="header-menu-meta">current</span>}
              </button>
            );
          })}
        </span>
      )}
    </span>
  );
}

const RC_LABEL = { off: 'RC', starting: 'RC…', on: 'RC on', stopping: 'RC…', failed: 'RC failed', stopFailed: 'RC on' } as const;

/**
 * Remote Control of the active Claude tab. `/remote-control` starts it when it is off and disconnects
 * it when it is on; the button follows the bridge session id Claude Code writes into its process
 * registry while a Remote Control session is up.
 */
export function RemoteControlButton({ tab }: { tab: TerminalTab }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = usePopover(rootRef);
  // The last request per pty, so switching tabs does not carry a pending request over.
  const [requested, setRequested] = useState<(RemoteControlRequest & { ptyId: number }) | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const request = requested && requested.ptyId === tab.ptyId ? requested : null;
  // A settled request is forgotten, so a later change made in the terminal reads as plain on or off.
  if (request && remoteControlSettled(tab.remoteControl, request)) setRequested(null);
  const state = remoteControlState(tab.remoteControl, request, now);
  const ready = claudeReady(tab);

  // Tick while a request is pending so the button reports a failure after the timeout.
  useEffect(() => {
    if (state !== 'starting' && state !== 'stopping') return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(250, (request?.at ?? 0) + REMOTE_CONTROL_TIMEOUT_MS - Date.now() + 50));
    return () => window.clearTimeout(timer);
  }, [state, request?.at, now]);

  const send = (kind: RemoteControlRequest['kind']): void => {
    setOpen(false);
    if (tab.ptyId === undefined) return;
    const at = Date.now();
    setRequested({ ptyId: tab.ptyId, kind, at });
    setNow(at);
    bus.emit('sendToPty', { ptyId: tab.ptyId, text: '/remote-control' });
  };
  const showTab = (): void => {
    setOpen(false);
    if (tab.ptyId === undefined) return;
    bus.emit('focusPanel', { panel: 'terminal' });
    bus.emit('focusPty', { ptyId: tab.ptyId });
  };

  const onClick = (): void => {
    if (state === 'starting' || state === 'stopping') showTab();
    else if (state === 'off' && ready) send('start');
    else setOpen((v) => !v);
  };

  const url = tab.remoteControl ? remoteControlUrl(tab.remoteControl) : null;
  const title = {
    on: `Remote Control is active: ${url ?? ''}. Click for the link or to disconnect`,
    starting: 'Starting Remote Control. If Claude asks to confirm, answer in the terminal (click to show it)',
    stopping: 'Disconnecting Remote Control. If Claude asks to confirm, answer in the terminal (click to show it)',
    failed: 'Remote Control did not start. Check the terminal tab',
    stopFailed: 'Remote Control is still active: the disconnect did not go through. Check the terminal tab',
    off: ready ? 'Start Remote Control (/remote-control): continue this session on your phone or at claude.ai/code' : notReadyReason(tab),
  }[state];
  const cssState = state === 'stopFailed' ? 'on' : state === 'stopping' ? 'starting' : state;

  return (
    <span className="header-menu-wrap" ref={rootRef}>
      <button
        type="button"
        className={`rc-button rc-${cssState}`}
        title={open ? undefined : title}
        aria-expanded={open}
        onClick={onClick}
      >
        <span className="rc-dot" aria-hidden="true" />
        {RC_LABEL[state]}
      </button>
      {open && (
        <span className="header-menu" role="menu">
          {(state === 'on' || state === 'stopFailed') && url && (
            <>
              <span className="header-menu-note">
                {state === 'on' ? 'Remote Control is active' : 'The disconnect did not go through; Remote Control is still active'}
              </span>
              <button
                type="button"
                role="menuitem"
                className="header-menu-item"
                onClick={() => {
                  setOpen(false);
                  window.open(url, '_blank');
                }}
              >
                <span className="header-menu-label">Open in browser</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="header-menu-item"
                onClick={() => {
                  setOpen(false);
                  void navigator.clipboard.writeText(url).catch(() => undefined);
                }}
              >
                <span className="header-menu-label">Copy link</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="header-menu-item header-menu-danger"
                disabled={!ready}
                title={ready ? 'Types /remote-control into the tab, which disconnects it' : notReadyReason(tab)}
                onClick={() => send('stop')}
              >
                <span className="header-menu-label">Disconnect</span>
                {!ready && <span className="header-menu-meta">when Claude is idle</span>}
              </button>
            </>
          )}
          {state === 'failed' && (
            <>
              <span className="header-menu-note">Remote Control did not report a session within {REMOTE_CONTROL_TIMEOUT_MS / 1000} s</span>
              <button type="button" role="menuitem" className="header-menu-item" disabled={!ready} onClick={() => send('start')}>
                <span className="header-menu-label">Try again</span>
              </button>
            </>
          )}
          {state === 'off' && !ready && <span className="header-menu-note">{notReadyReason(tab)}</span>}
          <button type="button" role="menuitem" className="header-menu-item" onClick={showTab}>
            <span className="header-menu-label">Show the terminal tab</span>
          </button>
        </span>
      )}
    </span>
  );
}

/** Processes of this window's terminals, live from main. */
export function usePtyActivity(): readonly PtyActivity[] {
  const [activity, setActivity] = useState<readonly PtyActivity[]>([]);
  useEffect(() => {
    const api = window.acode.terminal;
    let live = true;
    const off = api.onActivity((next) => setActivity(next));
    void api
      .activitySnapshot()
      .then((snapshot) => {
        if (live) setActivity((prev) => (prev.length === 0 ? snapshot : prev));
      })
      .catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, []);
  return activity;
}

const STATE_TITLE = {
  working: 'Something is running',
  waiting: 'Nothing is running, but Claude waits for you',
  idle: 'All done: nothing is running',
} as const;

/**
 * Lamp next to the project: blinking orange while anything runs in this window's terminals (Claude
 * working, a command, a gate, a shell Claude left in the background), steady orange while Claude
 * waits for the user, green when everything is done. A click lists what runs; a row shows its tab.
 */
export function ActivityLamp({ tabs, subagents }: { tabs: readonly TerminalTab[]; subagents: number }) {
  const activity = usePtyActivity();
  const summary = useMemo(() => activitySummary(tabs, activity), [tabs, activity]);
  const rootRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = usePopover(rootRef);
  const items: ActivityItem[] =
    subagents > 0
      ? [...summary.items, { tab: 'Claude', text: `${subagents} subagent${subagents === 1 ? '' : 's'} running`, kind: 'claude', ptyId: null }]
      : summary.items;
  const state = subagents > 0 ? 'working' : summary.state;
  const title = [STATE_TITLE[state], ...items.map((i) => `${i.tab}: ${i.text}`)].join('\n');

  const show = (item: ActivityItem): void => {
    setOpen(false);
    if (item.ptyId === null) return;
    bus.emit('focusPanel', { panel: 'terminal' });
    bus.emit('focusPty', { ptyId: item.ptyId });
  };

  return (
    <span className="header-menu-wrap" ref={rootRef}>
      <button
        type="button"
        className={`activity-lamp lamp-${state}`}
        title={open ? undefined : title}
        aria-label={STATE_TITLE[state]}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="activity-lamp-light" aria-hidden="true" />
      </button>
      {open && (
        <span className="header-menu header-menu-left" role="menu">
          <span className="header-menu-note">{STATE_TITLE[state]}</span>
          {items.map((item, i) => (
            <button
              key={`${item.ptyId ?? 'x'}-${i}`}
              type="button"
              role="menuitem"
              className="header-menu-item"
              disabled={item.ptyId === null}
              onClick={() => show(item)}
            >
              <span className={`activity-kind kind-${item.kind}`} aria-hidden="true" />
              <span className="header-menu-label" title={item.text}>
                {item.text}
              </span>
              <span className="header-menu-meta">{item.tab}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
