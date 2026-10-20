import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PtyId } from '@shared/ipc';
import { bus } from '../bus';
import { readScreen } from '../terminal/ptyScreens';
import { parseScreenPrompt, screenShows, sendKeys } from './feedKeys';
import type { ScreenPrompt } from './feedKeys';
import type { SessionActivity } from './feedModel';

/** How often the terminal screen is read while Claude waits for the user. */
const SCREEN_POLL_MS = 400;

/** What the feed's prompt cards need to answer in the terminal. */
export interface PromptControl {
  /** Pty of this window that runs the session; null when the answer can only be typed elsewhere. */
  ptyId: PtyId | null;
  /** Id of the question or plan call Claude waits on (see `pendingPrompt`). */
  pendingId: string | null;
  /** The numbered prompt on the terminal screen while Claude waits (plan approval, permission). */
  screen: ScreenPrompt | null;
  /** Keys were sent for the prompt on screen now; its buttons stay disabled. */
  sent: boolean;
  /** Types the steps into the pty; `focus` then moves to the terminal for text the user types there. */
  send(steps: readonly string[], focus?: boolean): void;
  /** True when the terminal shows `text` (the question the feed is about to answer). */
  shows(text: string): boolean;
  /** Shows and focuses the session's terminal tab. */
  focusTerminal(): void;
}

export const NO_PROMPT: PromptControl = {
  ptyId: null,
  pendingId: null,
  screen: null,
  sent: false,
  send: () => undefined,
  shows: () => false,
  focusTerminal: () => undefined,
};

function signature(screen: ScreenPrompt | null): string {
  return screen ? `${screen.title ?? ''}\n${screen.options.map((o) => `${o.key}.${o.label}`).join('\n')}` : '';
}

/**
 * Reads the session's terminal screen while Claude waits and sends answers to its pty. Keys go
 * out once per prompt: after a send the buttons stay disabled until the prompt changes.
 */
export function useTerminalPrompt(ptyId: PtyId | null, activity: SessionActivity, pendingId: string | null): PromptControl {
  const live = ptyId !== null && activity === 'waiting';
  const [screen, setScreen] = useState<{ ptyId: PtyId; prompt: ScreenPrompt } | null>(null);
  const [sentFor, setSentFor] = useState<string | null>(null);

  useEffect(() => {
    if (!live || ptyId === null) return;
    let last = '';
    const read = (): void => {
      const text = readScreen(ptyId);
      const prompt = text ? parseScreenPrompt(text.lines, text.cols) : null;
      const sig = signature(prompt);
      if (sig === last) return;
      last = sig;
      setScreen(prompt ? { ptyId, prompt } : null);
    };
    const first = window.setTimeout(read, 0);
    const timer = window.setInterval(read, SCREEN_POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [live, ptyId]);

  const prompt = live && screen?.ptyId === ptyId ? screen.prompt : null;
  const key = live ? `${ptyId}|${pendingId ?? ''}|${signature(prompt)}` : null;

  const focusTerminal = useCallback(() => {
    bus.emit('focusPanel', { panel: 'terminal' });
    if (ptyId !== null) bus.emit('focusPty', { ptyId });
  }, [ptyId]);

  const send = useCallback(
    (steps: readonly string[], focus = false) => {
      if (ptyId === null || key === null || sentFor === key) return;
      setSentFor(key);
      void sendKeys((data) => window.acode.pty.write(ptyId, data), steps).then(() => {
        if (focus) focusTerminal();
      });
    },
    [ptyId, key, sentFor, focusTerminal],
  );

  const shows = useCallback(
    (text: string) => {
      if (ptyId === null) return false;
      const screenText = readScreen(ptyId);
      return screenText ? screenShows(screenText.lines, text) : false;
    },
    [ptyId],
  );

  return useMemo(
    () => ({ ptyId, pendingId, screen: prompt, sent: key !== null && sentFor === key, send, shows, focusTerminal }),
    [ptyId, pendingId, prompt, key, sentFor, send, shows, focusTerminal],
  );
}
