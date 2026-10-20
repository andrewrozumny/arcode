import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent, Ref } from 'react';
import { bus } from './bus';
import { resolveKey } from './keys';
import type { PaneCommand } from './keys';
import type { TerminalSession } from './terminalSession';
import { Composer } from './terminal/Composer';
import { SearchBar } from './terminal/SearchBar';
import { terminalApi } from './terminal/api';
import { claudeNewCommand, claudeResumeCommand, gateCommand, gateTitle } from './terminal/commands';
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, loadFontSize, saveFontSize } from './terminal/fontSize';
import { TabStrip } from './terminal/TabStrip';
import { TabView } from './terminal/TabView';
import { useAttentionBadge, useClaudeStatus } from './terminal/useTabStatus';
import type { StartCommand } from './terminal/TabView';
import type { PersistedTab, TerminalPaneState, TerminalTab } from './terminal/types';
import './terminal/terminal.css';

export type { PersistedTab, TerminalPaneState, TerminalTab } from './terminal/types';
export { EMPTY_PANE_STATE } from './terminal/types';

/** Imperative API for the window header and for persistence. */
export interface TerminalPaneHandle {
  /** Opens a shell tab and returns its id. */
  newShell(): string;
  /** Opens a Claude tab (new session) and returns its id. */
  newClaude(name?: string): string;
  /** Opens a Claude tab resuming a past session, or focuses the tab that already runs it. */
  resumeClaude(sessionId: string, name?: string): string;
  /** Opens a `Gate: <target>` tab running `scripts/gates.sh <target>` and returns its id. */
  runGate(target: string): string;
  /** Replaces all tabs with the saved ones; Claude tabs resume their sessions. */
  restore(state: TerminalPaneState): void;
  /** Tab state to persist: no pty ids, no live status. */
  getState(): TerminalPaneState;
  toggleComposer(): void;
  focus(): void;
  /** Activates the next (+1) or previous (-1) tab. */
  stepTab(step: number): void;
  /** Closes the active tab, asking first when a process is still running in it. */
  closeActiveTab(): void;
}

export interface TerminalPaneProps {
  /** Project root: terminal cwd, base for relative file links, ARCODE_PROJECT. */
  projectRoot: string;
  ref?: Ref<TerminalPaneHandle>;
  /** Restored on mount; without it the pane opens one shell tab. */
  initialState?: TerminalPaneState;
  /** Extra environment for every pty, e.g. CLAUDE_CODE_SSE_PORT of the IDE bridge. */
  extraEnv?: Record<string, string>;
  /** A file link was clicked in terminal output. Paths are absolute, lines are 1-based. */
  onOpenFile?: (path: string, line?: number, endLine?: number) => void;
  /** Called whenever the persistable state changes. */
  onStateChange?: (state: TerminalPaneState) => void;
  /** Called when tabs change in any way (title, status, pty id). */
  onTabsChange?: (tabs: readonly TerminalTab[], activeTabId: string | null) => void;
  /** Listen to the application menu's New/Close/Next/Previous tab events. Default true. */
  menuEvents?: boolean;
  /** Hides the built-in toolbar when the host renders its own buttons through the ref API. Default false. */
  hideActions?: boolean;
  /** Hide only the gate menu (when the window header already offers gates). */
  hideGate?: boolean;
  onFirstRender?: () => void;
}

function uniqueTitle(base: string, tabs: readonly TerminalTab[]): string {
  const used = new Set(tabs.map((t) => t.title));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Docked terminal with shell, Claude and gate tabs. */
export function TerminalPane({
  projectRoot,
  ref,
  initialState,
  extraEnv,
  onOpenFile,
  onStateChange,
  onTabsChange,
  menuEvents = true,
  hideActions = false,
  hideGate = false,
  onFirstRender,
}: TerminalPaneProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(initialState?.composerOpen ?? false);
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(loadFontSize);

  // Refs hold the source of truth so the imperative API sees changes made in the same tick.
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeRef = useRef<string | null>(null);
  const composerRef = useRef(composerOpen);
  const [sessions] = useState(() => new Map<string, TerminalSession>());
  const [startCommands] = useState(() => new Map<string, StartCommand>());
  const propsRef = useRef({ projectRoot, extraEnv, onOpenFile, onFirstRender });
  const reportedFirstRender = useRef(false);
  const initialized = useRef(false);
  const lastStateJson = useRef('');

  useEffect(() => {
    propsRef.current = { projectRoot, extraEnv, onOpenFile, onFirstRender };
  });

  const commitTabs = useCallback((next: TerminalTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const commitActive = useCallback((id: string | null) => {
    activeRef.current = id;
    setActiveId(id);
  }, []);

  const patchTab = useCallback(
    (id: string, patch: Partial<TerminalTab>) => {
      if (!tabsRef.current.some((t) => t.id === id)) return;
      commitTabs(tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    },
    [commitTabs],
  );

  const focusActive = useCallback(() => {
    const id = activeRef.current;
    if (id) sessions.get(id)?.focus();
  }, [sessions]);

  const addTab = useCallback(
    (tab: TerminalTab, start?: StartCommand): string => {
      if (start) startCommands.set(tab.id, start);
      commitTabs([...tabsRef.current, tab]);
      commitActive(tab.id);
      return tab.id;
    },
    [commitActive, commitTabs, startCommands],
  );

  const newShell = useCallback((): string => {
    const id = crypto.randomUUID();
    return addTab({ id, kind: 'shell', title: uniqueTitle('Shell', tabsRef.current) });
  }, [addTab]);

  const claudeTab = useCallback(
    (id: string, title: string, sessionId: string, resumed: boolean): { tab: TerminalTab; start: StartCommand } => {
      const tab: TerminalTab = { id, kind: 'claude', title, claude: { sessionId, name: title, resumed } };
      const start: StartCommand = async () => {
        // A session that never got a message has no transcript yet; resuming it would fail.
        const canResume = resumed && (await terminalApi().sessionExists(sessionId));
        // Nothing runs until the user picks: the tab shows the continue / new choice over its shell.
        if (canResume) {
          patchTab(id, { resumeChoice: true });
          return null;
        }
        patchTab(id, { claude: { sessionId, name: title, resumed: false } });
        return claudeNewCommand(sessionId, title);
      };
      return { tab, start };
    },
    [patchTab],
  );

  const newClaude = useCallback(
    (name?: string): string => {
      const id = crypto.randomUUID();
      const title = name?.trim() ? name.trim() : uniqueTitle('Claude', tabsRef.current);
      const { tab, start } = claudeTab(id, title, crypto.randomUUID(), false);
      return addTab(tab, start);
    },
    [addTab, claudeTab],
  );

  const resumeClaude = useCallback(
    (sessionId: string, name?: string): string => {
      const existing = tabsRef.current.find((t) => t.claude?.sessionId === sessionId);
      if (existing) {
        commitActive(existing.id);
        sessions.get(existing.id)?.focus();
        return existing.id;
      }
      const id = crypto.randomUUID();
      const title = uniqueTitle(name?.trim() ? name.trim() : 'Claude', tabsRef.current);
      const tab: TerminalTab = { id, kind: 'claude', title, claude: { sessionId, name: title, resumed: true } };
      // The user picked this session in the list, so it resumes at once without the continue / new choice.
      return addTab(tab, () => Promise.resolve(claudeResumeCommand(sessionId)));
    },
    [addTab, commitActive, sessions],
  );

  const runGate = useCallback(
    (target: string): string => {
      const id = crypto.randomUUID();
      const tab: TerminalTab = {
        id,
        kind: 'gate',
        title: uniqueTitle(gateTitle(target), tabsRef.current),
        gate: { target, state: 'running' },
      };
      return addTab(tab, () => Promise.resolve(gateCommand(target)));
    },
    [addTab],
  );

  const closeTab = useCallback(
    async (id: string, confirmBusy = true): Promise<void> => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      if (confirmBusy && tab.ptyId !== undefined && !tab.exited) {
        let busy = false;
        try {
          busy = await terminalApi().hasChildren(tab.ptyId);
        } catch {
          busy = false;
        }
        if (busy && !window.confirm(`A process is still running in "${tab.title}". Close the tab anyway?`)) return;
      }
      const current = tabsRef.current;
      const index = current.findIndex((t) => t.id === id);
      if (index < 0) return;
      sessions.get(id)?.dispose();
      sessions.delete(id);
      startCommands.delete(id);
      const remaining = current.filter((t) => t.id !== id);
      if (remaining.length === 0) {
        commitTabs(remaining);
        newShell();
        return;
      }
      commitTabs(remaining);
      if (activeRef.current === id) commitActive(remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    },
    [commitActive, commitTabs, newShell, sessions, startCommands],
  );

  const stepTab = useCallback(
    (step: number) => {
      const current = tabsRef.current;
      if (current.length === 0) return;
      const index = current.findIndex((t) => t.id === activeRef.current);
      const target = current[(index + step + current.length) % current.length];
      if (target) commitActive(target.id);
    },
    [commitActive],
  );

  const restore = useCallback(
    (state: TerminalPaneState) => {
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
      startCommands.clear();
      const restored: TerminalTab[] = [];
      for (const saved of state.tabs) {
        if (saved.kind === 'claude' && saved.claude) {
          const { tab, start } = claudeTab(saved.id, saved.title, saved.claude.sessionId, true);
          startCommands.set(tab.id, start);
          restored.push(tab);
        } else if (saved.kind === 'shell') {
          restored.push({ id: saved.id, kind: 'shell', title: saved.title });
        }
      }
      commitTabs(restored);
      setComposerOpen(state.composerOpen);
      composerRef.current = state.composerOpen;
      if (restored.length === 0) {
        newShell();
        return;
      }
      commitActive(restored.find((t) => t.id === state.activeTabId)?.id ?? restored[0]?.id ?? null);
    },
    [claudeTab, commitActive, commitTabs, newShell, sessions, startCommands],
  );

  const getState = useCallback((): TerminalPaneState => {
    const persisted: PersistedTab[] = [];
    for (const tab of tabsRef.current) {
      if (tab.kind === 'shell') persisted.push({ id: tab.id, kind: 'shell', title: tab.title });
      else if (tab.kind === 'claude' && tab.claude) {
        persisted.push({
          id: tab.id,
          kind: 'claude',
          title: tab.title,
          claude: { sessionId: tab.claude.sessionId, name: tab.claude.name },
        });
      }
    }
    const active = persisted.find((t) => t.id === activeRef.current)?.id ?? null;
    return { tabs: persisted, activeTabId: active, composerOpen: composerRef.current };
  }, []);

  const toggleComposer = useCallback(() => {
    const next = !composerRef.current;
    composerRef.current = next;
    setComposerOpen(next);
    if (!next) requestAnimationFrame(focusActive);
  }, [focusActive]);

  const closeActiveTab = useCallback(() => {
    if (activeRef.current) void closeTab(activeRef.current);
  }, [closeTab]);

  useImperativeHandle(
    ref,
    () => ({
      newShell,
      newClaude,
      resumeClaude,
      runGate,
      restore,
      getState,
      toggleComposer,
      focus: focusActive,
      stepTab,
      closeActiveTab,
    }),
    [newShell, newClaude, resumeClaude, runGate, restore, getState, toggleComposer, focusActive, stepTab, closeActiveTab],
  );

  // The Claude panel asks for a resumed session through the bus.
  useEffect(() => bus.on('resumeClaude', ({ sessionId, name }) => void resumeClaude(sessionId, name)), [resumeClaude]);

  // Initial tabs.
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    // One-time mount initialisation of tabs.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (initialState) restore(initialState);
    else newShell();
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount
  }, []);

  // Menu accelerators (Cmd+T / Cmd+W / Cmd+Shift+] / [) arrive as events and never reach the page.
  useEffect(() => {
    if (!menuEvents) return;
    const offNew = window.acode.menu.onNewTab(() => void newShell());
    const offClose = window.acode.menu.onCloseTab(() => {
      if (activeRef.current) void closeTab(activeRef.current);
    });
    const offSelect = window.acode.menu.onSelectTab(stepTab);
    return () => {
      offNew();
      offClose();
      offSelect();
    };
  }, [menuEvents, newShell, closeTab, stepTab]);

  useClaudeStatus(tabsRef, patchTab);
  useAttentionBadge(tabs, activeId);

  // Persistable state and generic change notifications.
  useEffect(() => {
    if (!initialized.current) return;
    onTabsChange?.(tabs, activeId);
    const state = getState();
    const json = JSON.stringify(state);
    if (json === lastStateJson.current) return;
    lastStateJson.current = json;
    onStateChange?.(state);
  }, [tabs, activeId, composerOpen, getState, onStateChange, onTabsChange]);

  // Font size applies to every session and is remembered.
  useEffect(() => {
    saveFontSize(fontSize);
    for (const session of sessions.values()) session.setFontSize(fontSize);
  }, [fontSize, sessions]);

  // Switching tabs gives the terminal focus and closes the search bar of the previous one.
  useEffect(() => {
    const session = activeId ? sessions.get(activeId) : undefined;
    session?.refit();
    session?.focus();
  }, [activeId, sessions]);

  const runCommand = useCallback(
    (command: PaneCommand) => {
      switch (command) {
        case 'newShell':
          newShell();
          break;
        case 'newClaude':
          newClaude();
          break;
        case 'nextTab':
          stepTab(1);
          break;
        case 'prevTab':
          stepTab(-1);
          break;
        case 'closeTab':
          if (activeRef.current) void closeTab(activeRef.current);
          break;
        case 'find':
          setSearchFor(activeRef.current);
          break;
        case 'toggleComposer':
          toggleComposer();
          break;
        case 'fontLarger':
          setFontSize((size) => Math.min(FONT_MAX, size + 1));
          break;
        case 'fontSmaller':
          setFontSize((size) => Math.max(FONT_MIN, size - 1));
          break;
        case 'fontReset':
          setFontSize(FONT_DEFAULT);
          break;
      }
    },
    [closeTab, newClaude, newShell, stepTab, toggleComposer],
  );

  // Pane-level shortcuts. Events from the terminal textarea bubble up to here after xterm declined them.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = resolveKey(event.nativeEvent, false);
    if (action.kind !== 'command') return;
    event.preventDefault();
    event.stopPropagation();
    runCommand(action.command);
  };

  const handleFirstRender = useCallback(() => {
    if (reportedFirstRender.current) return;
    reportedFirstRender.current = true;
    requestAnimationFrame(() => propsRef.current.onFirstRender?.());
  }, []);

  const activeSession = activeId ? sessions.get(activeId) : undefined;
  const commitRename = (id: string, value: string): void => {
    const title = value.trim();
    const tab = tabsRef.current.find((t) => t.id === id);
    if (title && tab) patchTab(id, { title, ...(tab.claude ? { claude: { ...tab.claude, name: title } } : {}) });
    requestAnimationFrame(focusActive);
  };

  return (
    <div className="tp-root" onKeyDown={onKeyDown}>
      <TabStrip
        tabs={tabs}
        activeId={activeId}
        onActivate={commitActive}
        onClose={(id) => void closeTab(id)}
        onRename={commitRename}
        onRenameCancel={() => requestAnimationFrame(focusActive)}
        hideActions={hideActions}
        hideGate={hideGate}
        composerOpen={composerOpen}
        onNewShell={() => newShell()}
        onNewClaude={() => newClaude()}
        onRunGate={(target) => runGate(target)}
        onToggleComposer={toggleComposer}
      />
      {composerOpen && (
        <Composer
          projectRoot={projectRoot}
          autoFocus
          onEscape={focusActive}
          onSend={(text) => {
            const session = activeId ? sessions.get(activeId) : undefined;
            session?.sendPasted(text, true);
            session?.focus();
          }}
        />
      )}
      <div className="tp-terminals">
        {tabs.map((tab) => (
          <TabView
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            sessions={sessions}
            startCommands={startCommands}
            fontSize={fontSize}
            propsRef={propsRef}
            patchTab={patchTab}
            onStarted={handleFirstRender}
          />
        ))}
        {searchFor !== null && searchFor === activeId && activeSession && (
          <SearchBar
            key={activeId}
            session={activeSession}
            onClose={() => {
              setSearchFor(null);
              focusActive();
            }}
          />
        )}
      </div>
    </div>
  );
}
