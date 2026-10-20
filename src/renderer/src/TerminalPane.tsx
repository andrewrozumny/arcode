import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, Ref } from 'react';
import { SPLIT_RATIO_DEFAULT, clampSplitRatio } from '@shared/terminal';
import { bus } from './bus';
import { resolveKey } from './keys';
import type { PaneCommand } from './keys';
import { Splitter } from './layout/Splitter';
import type { TerminalSession } from './terminalSession';
import { Composer } from './terminal/Composer';
import { SearchBar } from './terminal/SearchBar';
import { terminalApi } from './terminal/api';
import { claudeNewCommand, claudeResumeCommand, gateCommand, gateTitle } from './terminal/commands';
import { FONT_DEFAULT, FONT_MAX, FONT_MIN, loadFontSize, saveFontSize } from './terminal/fontSize';
import {
  EMPTY_VIEW,
  activateTab,
  applySavedSplit,
  canMoveTab,
  columnOf,
  displayOrder,
  focusColumn,
  focusedTabId,
  isSplit,
  moveTab,
  normalize,
  placeTab,
  removeTab,
  stepTab as stepInColumn,
  tabsIn,
} from './terminal/split';
import type { Column, SplitView } from './terminal/split';
import { TabStrip } from './terminal/TabStrip';
import { TabView } from './terminal/TabView';
import { useAttentionBadge, useClaudeStatus, useTabTitlesReport } from './terminal/useTabStatus';
import { nextWaitingTab } from './terminal/waiting';
import type { StartCommand } from './terminal/TabView';
import type { PersistedTab, TerminalPaneState, TerminalTab } from './terminal/types';
import './terminal/terminal.css';

export type { PersistedTab, TerminalPaneState, TerminalTab } from './terminal/types';
export { EMPTY_PANE_STATE } from './terminal/types';

/** Imperative API for the window header and for persistence. */
export interface TerminalPaneHandle {
  /** Opens a shell tab in the focused column and returns its id. */
  newShell(): string;
  /** Opens a Claude tab (new session) in the focused column and returns its id. */
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
  /** Activates the next (+1) or previous (-1) tab of the focused column. */
  stepTab(step: number): void;
  /**
   * Cmd+\: opens a shell in a new right column when the dock has one column, otherwise moves
   * focus to the other column.
   */
  splitRight(): void;
  /** Closes the active tab of the focused column, asking first when a process is still running in it. */
  closeActiveTab(): void;
  /**
   * Activates and focuses the next tab where Claude waits for the user (cycling in strip order,
   * left column first). False when no tab waits.
   */
  jumpToWaiting(): boolean;
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
  /** Called when tabs change in any way (title, status, pty id). The active tab is the focused column's. */
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

/** Grid column of a dock column: the splitter sits in grid column 2 between them. */
const gridColumn = (column: Column): number => (column === 1 ? 3 : 1);

/** Docked terminal with shell, Claude and gate tabs, in one column or split into two. */
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
  const [view, setView] = useState<SplitView>(EMPTY_VIEW);
  const [ratio, setRatio] = useState(SPLIT_RATIO_DEFAULT);
  const [composerOpen, setComposerOpen] = useState(initialState?.composerOpen ?? false);
  const [searchFor, setSearchFor] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(loadFontSize);
  const activeId = focusedTabId(view);

  // Refs hold the source of truth so the imperative API sees changes made in the same tick.
  const tabsRef = useRef<TerminalTab[]>([]);
  const viewRef = useRef<SplitView>(EMPTY_VIEW);
  const ratioRef = useRef(SPLIT_RATIO_DEFAULT);
  const composerRef = useRef(composerOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ ratio: number; width: number } | null>(null);
  const [sessions] = useState(() => new Map<string, TerminalSession>());
  const [startCommands] = useState(() => new Map<string, StartCommand>());
  const propsRef = useRef({ projectRoot, extraEnv, onOpenFile, onFirstRender });
  const reportedFirstRender = useRef(false);
  const initialized = useRef(false);
  const lastStateJson = useRef('');

  useEffect(() => {
    propsRef.current = { projectRoot, extraEnv, onOpenFile, onFirstRender };
  });

  /** Commits tabs and columns together, after restoring the split invariants. */
  const commit = useCallback((nextTabs: readonly TerminalTab[], nextView: SplitView) => {
    const result = normalize(nextTabs, nextView);
    tabsRef.current = result.tabs;
    viewRef.current = result.view;
    setTabs(result.tabs);
    setView(result.view);
  }, []);

  /** Makes a tab the active one of its column and gives that column focus. */
  const commitActive = useCallback(
    (id: string) => {
      const result = activateTab(tabsRef.current, viewRef.current, id);
      commit(result.tabs, result.view);
    },
    [commit],
  );

  const patchTab = useCallback(
    (id: string, patch: Partial<TerminalTab>) => {
      if (!tabsRef.current.some((t) => t.id === id)) return;
      commit(
        tabsRef.current.map((t) => (t.id === id ? { ...t, ...patch } : t)),
        viewRef.current,
      );
    },
    [commit],
  );

  const focusActive = useCallback(() => {
    const id = focusedTabId(viewRef.current);
    if (id) sessions.get(id)?.focus();
  }, [sessions]);

  /** Adds a tab to a column (default: the focused one) and activates it there. */
  const addTab = useCallback(
    (tab: TerminalTab, start?: StartCommand, column?: Column): string => {
      if (start) startCommands.set(tab.id, start);
      const result = placeTab(tabsRef.current, viewRef.current, tab, column ?? viewRef.current.focused);
      commit(result.tabs, result.view);
      return tab.id;
    },
    [commit, startCommands],
  );

  const newShell = useCallback(
    (column?: Column): string => {
      const id = crypto.randomUUID();
      return addTab({ id, kind: 'shell', title: uniqueTitle('Shell', tabsRef.current) }, undefined, column);
    },
    [addTab],
  );

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
    (name?: string, column?: Column): string => {
      const id = crypto.randomUUID();
      const title = name?.trim() ? name.trim() : uniqueTitle('Claude', tabsRef.current);
      const { tab, start } = claudeTab(id, title, crypto.randomUUID(), false);
      return addTab(tab, start, column);
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
    (target: string, column?: Column): string => {
      const id = crypto.randomUUID();
      const tab: TerminalTab = {
        id,
        kind: 'gate',
        title: uniqueTitle(gateTitle(target), tabsRef.current),
        gate: { target, state: 'running' },
      };
      return addTab(tab, () => Promise.resolve(gateCommand(target)), column);
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
      if (!tabsRef.current.some((t) => t.id === id)) return;
      sessions.get(id)?.dispose();
      sessions.delete(id);
      startCommands.delete(id);
      // Closing the last tab of a column collapses the dock back to one column.
      const result = removeTab(tabsRef.current, viewRef.current, id);
      commit(result.tabs, result.view);
      if (result.tabs.length === 0) newShell(0);
    },
    [commit, newShell, sessions, startCommands],
  );

  const stepTab = useCallback(
    (step: number) => {
      const result = stepInColumn(tabsRef.current, viewRef.current, step);
      commit(result.tabs, result.view);
    },
    [commit],
  );

  /** Context menu "Move to Other Side": the tab keeps its session and lands at the end of the other strip. */
  const moveToOtherSide = useCallback(
    (id: string) => {
      if (!canMoveTab(tabsRef.current)) return;
      const result = moveTab(tabsRef.current, viewRef.current, id);
      commit(result.tabs, result.view);
      requestAnimationFrame(() => {
        const session = sessions.get(id);
        session?.refit();
        session?.focus();
      });
    },
    [commit, sessions],
  );

  const splitRight = useCallback(() => {
    if (isSplit(tabsRef.current)) {
      const other: Column = viewRef.current.focused === 0 ? 1 : 0;
      const result = focusColumn(tabsRef.current, viewRef.current, other);
      commit(result.tabs, result.view);
      requestAnimationFrame(focusActive);
      return;
    }
    newShell(1);
  }, [commit, focusActive, newShell]);

  const onFocusColumn = useCallback(
    (column: Column) => {
      if (viewRef.current.focused === column || !isSplit(tabsRef.current)) return;
      const result = focusColumn(tabsRef.current, viewRef.current, column);
      commit(result.tabs, result.view);
    },
    [commit],
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
      setComposerOpen(state.composerOpen);
      composerRef.current = state.composerOpen;
      const nextRatio = clampSplitRatio(state.split?.ratio);
      ratioRef.current = nextRatio;
      setRatio(nextRatio);
      // State saved before the split existed has no `split` and loads as one column.
      const placed = applySavedSplit(restored, state.activeTabId, state.split);
      commit(placed.tabs, placed.view);
      if (restored.length === 0) newShell(0);
    },
    [claudeTab, commit, newShell, sessions, startCommands],
  );

  const getState = useCallback((): TerminalPaneState => {
    const persisted: PersistedTab[] = [];
    const right = new Set<string>();
    for (const tab of tabsRef.current) {
      if (columnOf(tab) === 1) right.add(tab.id);
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
    const saved = new Set(persisted.map((t) => t.id));
    const [leftActive, rightActive] = viewRef.current.active;
    const known = (id: string | null): string | null => (id !== null && saved.has(id) ? id : null);
    const state: TerminalPaneState = {
      tabs: persisted,
      activeTabId: known(leftActive),
      composerOpen: composerRef.current,
    };
    // Gate tabs are not saved, so a column that holds only gates does not survive as a split.
    const rightTabIds = persisted.filter((t) => right.has(t.id)).map((t) => t.id);
    if (rightTabIds.length > 0 && rightTabIds.length < persisted.length) {
      state.split = { rightTabIds, rightActiveTabId: known(rightActive), ratio: ratioRef.current };
    }
    return state;
  }, []);

  const toggleComposer = useCallback(() => {
    const next = !composerRef.current;
    composerRef.current = next;
    setComposerOpen(next);
    if (!next) requestAnimationFrame(focusActive);
  }, [focusActive]);

  const closeActiveTab = useCallback(() => {
    const id = focusedTabId(viewRef.current);
    if (id) void closeTab(id);
  }, [closeTab]);

  const jumpToWaiting = useCallback((): boolean => {
    // Strip order across both columns: the left strip, then the right one.
    const id = nextWaitingTab(displayOrder(tabsRef.current), focusedTabId(viewRef.current));
    if (!id) return false;
    commitActive(id);
    // The dock may have just been shown; focus once it is laid out.
    requestAnimationFrame(() => sessions.get(id)?.focus());
    return true;
  }, [commitActive, sessions]);

  useImperativeHandle(
    ref,
    () => ({
      newShell: () => newShell(),
      newClaude: (name?: string) => newClaude(name),
      resumeClaude,
      runGate: (target: string) => runGate(target),
      restore,
      getState,
      toggleComposer,
      focus: focusActive,
      stepTab,
      splitRight,
      closeActiveTab,
      jumpToWaiting,
    }),
    [
      newShell,
      newClaude,
      resumeClaude,
      runGate,
      restore,
      getState,
      toggleComposer,
      focusActive,
      stepTab,
      splitRight,
      closeActiveTab,
      jumpToWaiting,
    ],
  );

  // The Claude panel asks for a resumed session through the bus.
  useEffect(() => bus.on('resumeClaude', ({ sessionId, name }) => void resumeClaude(sessionId, name)), [resumeClaude]);
  useEffect(() => bus.on('newClaude', () => void newClaude()), [newClaude]);

  // The Claude feed sends the user to the tab whose prompt needs typing, in whichever column it sits.
  useEffect(
    () =>
      bus.on('focusPty', ({ ptyId }) => {
        const tab = tabsRef.current.find((t) => t.ptyId === ptyId);
        if (!tab) return;
        commitActive(tab.id);
        requestAnimationFrame(() => sessions.get(tab.id)?.focus());
      }),
    [commitActive, sessions],
  );

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
    const offClose = window.acode.menu.onCloseTab(closeActiveTab);
    const offSelect = window.acode.menu.onSelectTab(stepTab);
    return () => {
      offNew();
      offClose();
      offSelect();
    };
  }, [menuEvents, newShell, closeActiveTab, stepTab]);

  useClaudeStatus(tabsRef, patchTab);
  useAttentionBadge(tabs, view.active);
  useTabTitlesReport(tabs);

  // Persistable state and generic change notifications.
  useEffect(() => {
    if (!initialized.current) return;
    onTabsChange?.(tabs, activeId);
    const state = getState();
    const json = JSON.stringify(state);
    if (json === lastStateJson.current) return;
    lastStateJson.current = json;
    onStateChange?.(state);
  }, [tabs, activeId, view, ratio, composerOpen, getState, onStateChange, onTabsChange]);

  // Font size applies to every session and is remembered.
  useEffect(() => {
    saveFontSize(fontSize);
    for (const session of sessions.values()) session.setFontSize(fontSize);
  }, [fontSize, sessions]);

  // Switching tabs or columns gives the terminal of the focused column focus.
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
          closeActiveTab();
          break;
        case 'find':
          setSearchFor(focusedTabId(viewRef.current));
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
    [closeActiveTab, newClaude, newShell, stepTab, toggleComposer],
  );

  // Pane-level shortcuts. Events from the terminal textarea bubble up to here after xterm declined them.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const action = resolveKey(event.nativeEvent, false);
    if (action.kind !== 'command') return;
    event.preventDefault();
    event.stopPropagation();
    runCommand(action.command);
  };

  // Focus moving into a column's terminal (a click in it) makes it the focused column. Strip clicks are
  // handled by the strip itself, so a rename field there keeps its focus.
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>): void => {
    const owner = (event.target as Element).closest<HTMLElement>('.tp-cell[data-column]');
    if (owner) onFocusColumn(owner.dataset.column === '1' ? 1 : 0);
  };

  const onSplitDragStart = (): void => {
    dragStart.current = { ratio: ratioRef.current, width: rootRef.current?.getBoundingClientRect().width ?? 0 };
  };
  const onSplitDrag = (delta: number): void => {
    const start = dragStart.current;
    if (!start || start.width <= 0) return;
    const next = clampSplitRatio(start.ratio + delta / start.width);
    ratioRef.current = next;
    setRatio(next);
  };
  const onSplitDragEnd = (): void => {
    dragStart.current = null;
  };

  const handleFirstRender = useCallback(() => {
    if (reportedFirstRender.current) return;
    reportedFirstRender.current = true;
    requestAnimationFrame(() => propsRef.current.onFirstRender?.());
  }, []);

  const commitRename = (id: string, value: string): void => {
    const title = value.trim();
    const tab = tabsRef.current.find((t) => t.id === id);
    if (title && tab) patchTab(id, { title, ...(tab.claude ? { claude: { ...tab.claude, name: title } } : {}) });
    requestAnimationFrame(focusActive);
  };

  const split = isSplit(tabs);
  const canMove = canMoveTab(tabs);
  const columns: Column[] = split ? [0, 1] : [0];
  const searchTab = searchFor !== null && view.active.includes(searchFor) ? tabs.find((t) => t.id === searchFor) : undefined;
  const searchSession = searchTab ? sessions.get(searchTab.id) : undefined;
  const gridTemplateColumns = split
    ? `minmax(0, ${ratio}fr) var(--splitter-size, 1px) minmax(0, ${1 - ratio}fr)`
    : 'minmax(0, 1fr)';

  return (
    <div
      ref={rootRef}
      className={split ? 'tp-root split' : 'tp-root'}
      style={{ gridTemplateColumns }}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocusCapture}
    >
      {columns.map((column) => (
        <TabStrip
          key={column}
          column={column}
          split={split}
          focused={view.focused === column}
          tabs={split ? tabsIn(tabs, column) : tabs}
          activeId={view.active[column]}
          onActivate={commitActive}
          onClose={(id) => void closeTab(id)}
          onRename={commitRename}
          onRenameCancel={() => requestAnimationFrame(focusActive)}
          hideActions={hideActions}
          hideGate={hideGate}
          composerOpen={composerOpen}
          showComposer={column === columns.length - 1}
          canMove={canMove}
          onMove={moveToOtherSide}
          onSplit={splitRight}
          onFocusColumn={() => onFocusColumn(column)}
          onNewShell={() => newShell(column)}
          onNewClaude={() => newClaude(undefined, column)}
          onRunGate={(target) => runGate(target, column)}
          onToggleComposer={toggleComposer}
        />
      ))}
      {split && <div className="tp-strip-divider" aria-hidden="true" />}
      {composerOpen && (
        <Composer
          projectRoot={projectRoot}
          autoFocus
          onEscape={focusActive}
          onSend={(text) => {
            const id = focusedTabId(viewRef.current);
            const session = id ? sessions.get(id) : undefined;
            session?.sendPasted(text, true);
            session?.focus();
          }}
        />
      )}
      {split && (
        <Splitter orientation="vertical" onDragStart={onSplitDragStart} onDrag={onSplitDrag} onDragEnd={onSplitDragEnd} />
      )}
      {tabs.map((tab) => (
        <TabView
          key={tab.id}
          tab={tab}
          active={view.active[columnOf(tab)] === tab.id}
          sessions={sessions}
          startCommands={startCommands}
          fontSize={fontSize}
          propsRef={propsRef}
          patchTab={patchTab}
          onStarted={handleFirstRender}
        />
      ))}
      {searchTab && searchSession && (
        <div className="tp-overlay" style={{ gridColumn: gridColumn(columnOf(searchTab)) }}>
          <SearchBar
            key={searchTab.id}
            session={searchSession}
            onClose={() => {
              setSearchFor(null);
              focusActive();
            }}
          />
        </div>
      )}
    </div>
  );
}
