import { useEffect, useRef } from 'react';
import type { PtyId } from '@shared/ipc';
import { TerminalSession } from '../terminalSession';
import { claudeNewCommand, claudeResumeCommand } from './commands';
import { safeColor } from './osc';
import type { TabStatusOsc } from './osc';
import type { TerminalTab } from './types';

/** Command a new tab runs once its shell is up; null runs nothing (e.g. waiting for the resume choice). */
export type StartCommand = () => Promise<string | null>;

/** Pane props a session reads when it starts; kept in a ref so later changes need no new session. */
export interface SessionHostProps {
  projectRoot: string;
  extraEnv?: Record<string, string> | undefined;
  onOpenFile?: ((path: string, line?: number, endLine?: number) => void) | undefined;
}

export interface TabViewProps {
  tab: TerminalTab;
  /** The active tab of its column, i.e. on screen. */
  active: boolean;
  sessions: Map<string, TerminalSession>;
  startCommands: Map<string, StartCommand>;
  fontSize: number;
  propsRef: { current: SessionHostProps };
  patchTab: (id: string, patch: Partial<TerminalTab>) => void;
  onStarted: () => void;
}

/** Hosts one terminal session for the lifetime of its tab. */
export function TabView({ tab, active, sessions, startCommands, fontSize, propsRef, patchTab, onStarted }: TabViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tabId = tab.id;
  const kind = tab.kind;
  const title = tab.title;
  const initialFontSize = useRef(fontSize);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const session = new TerminalSession(host, {
      projectRoot: propsRef.current.projectRoot,
      extraEnv: propsRef.current.extraEnv,
      name: title,
      fontSize: initialFontSize.current,
      callbacks: {
        onPtyId: (ptyId: PtyId) => patchTab(tabId, { ptyId }),
        onTitle: (oscTitle) => patchTab(tabId, { oscTitle }),
        onTabStatus: (status: TabStatusOsc) =>
          patchTab(tabId, {
            indicator: {
              color: safeColor(status.indicator) ?? safeColor(status.statusColor),
              text: status.status,
            },
          }),
        onGate: (exitCode) =>
          patchTab(tabId, { gate: { target: tab.gate?.target ?? 'all', state: exitCode === 0 ? 'passed' : 'failed' } }),
        onExit: () => patchTab(tabId, { exited: true, claudeStatus: undefined }),
        onOpenFile: (path, line, endLine) => {
          propsRef.current.onOpenFile?.(path, line, endLine);
        },
      },
    });
    sessions.set(tabId, session);
    void session.start().then(async () => {
      onStarted();
      const make = startCommands.get(tabId);
      if (!make || session.isDisposed) return;
      const command = await make();
      if (!command || session.isDisposed) return;
      startCommands.delete(tabId);
      await session.runCommand(command);
    });
    return () => {
      if (sessions.get(tabId) === session) sessions.delete(tabId);
      session.dispose();
    };
    // The session is created once per tab; later prop changes are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, kind]);

  // Coming on screen refits; focus is the pane's call, since with two columns a tab can become
  // visible in the column that does not have focus.
  useEffect(() => {
    if (active) sessions.get(tabId)?.refit();
  }, [active, sessions, tabId]);

  // Runs the choice the user made for a restored Claude tab; the shell has been running since the tab opened.
  const pickResume = (continuePrevious: boolean): void => {
    const session = sessions.get(tabId);
    const claude = tab.claude;
    if (!session || !claude) return;
    patchTab(tabId, { resumeChoice: false });
    if (continuePrevious) {
      patchTab(tabId, { claude: { ...claude, resumed: true } });
      void session.runCommand(claudeResumeCommand(claude.sessionId));
    } else {
      const sessionId = crypto.randomUUID();
      patchTab(tabId, { claude: { sessionId, name: claude.name, resumed: false } });
      void session.runCommand(claudeNewCommand(sessionId, claude.name));
    }
    session.focus();
  };

  // Every cell stays a child of the same grid, so moving a tab to the other column only changes its
  // grid column: React keeps the element and the terminal session survives the move.
  const column = tab.column === 1 ? 1 : 0;
  return (
    <div className={active ? 'tp-cell active' : 'tp-cell'} data-column={column} style={{ gridColumn: column === 1 ? 3 : 1 }}>
      <div ref={hostRef} className={active ? 'tp-host active' : 'tp-host'} />
      {active && tab.resumeChoice && (
        <div className="tp-resume" role="group" aria-label="Previous Claude session">
          <span className="tp-resume-text">Previous Claude session found</span>
          <button type="button" className="tp-resume-btn primary" onClick={() => pickResume(true)}>
            Continue previous session
          </button>
          <button type="button" className="tp-resume-btn" onClick={() => pickResume(false)}>
            New session
          </button>
        </div>
      )}
    </div>
  );
}
