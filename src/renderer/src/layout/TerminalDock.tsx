import { useCallback, useEffect, useRef } from 'react';
import type { Ref } from 'react';
import type { TerminalPaneState } from '@shared/terminal';
import { TerminalPane } from '../TerminalPane';
import type { TerminalPaneHandle } from '../TerminalPane';
import type { TerminalTab } from '../terminal/types';
import { bus } from '../bus';

interface Props {
  projectRoot: string;
  ref: Ref<TerminalPaneHandle>;
  /** Tabs saved for this project; the pane reads them once, on mount. */
  initialState?: TerminalPaneState | undefined;
  /** Live tabs and the active one; the header reads the active Claude tab's model from it. */
  onTabsChange?: ((tabs: readonly TerminalTab[], activeTabId: string | null) => void) | undefined;
}

const SAVE_DELAY_MS = 300;

/**
 * Bottom dock hosting the terminal pane. Stays mounted while hidden so shells survive.
 * Tabs are saved per project; the window header owns the gate buttons and the window
 * routes menu tab commands by focus, so the pane's own toolbar actions and menu
 * listeners are off.
 */
export function TerminalDock({ projectRoot, ref, initialState, onTabsChange }: Props) {
  const reported = useRef(false);
  const pending = useRef<TerminalPaneState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current) window.acode.layout.setTerminal(projectRoot, pending.current);
    pending.current = null;
  }, [projectRoot]);

  const onStateChange = useCallback(
    (state: TerminalPaneState) => {
      pending.current = state;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, [flush]);

  const onOpenFile = useCallback((path: string, line?: number, endLine?: number) => {
    bus.openFile({
      path,
      ...(line !== undefined ? { line } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
    });
  }, []);

  const onFirstRender = useCallback(() => {
    if (reported.current) return;
    reported.current = true;
    window.acode.firstRender();
  }, []);

  return (
    <TerminalPane
      ref={ref}
      projectRoot={projectRoot}
      {...(initialState && initialState.tabs.length > 0 ? { initialState } : {})}
      onOpenFile={onOpenFile}
      onStateChange={onStateChange}
      {...(onTabsChange ? { onTabsChange } : {})}
      onFirstRender={onFirstRender}
      menuEvents={false}
      hideGate
    />
  );
}
