import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { DEFAULT_EDITOR_SETTINGS } from '@shared/editorState';
import type { ViewerTabsState } from '@shared/editorState';
import logoUrl from '../../../../design/empty-mark.svg';
import { ClaudePanel } from '../claude/ClaudePanel';
import { FeedView } from '../claude/FeedView';
import { DiffTab } from './DiffTab';
import { FilePane } from './FilePane';
import type { FilePaneHandle, RevealRequest } from './FilePane';
import { basename, dirname, gitKind, toAbsolute, toRelative } from './paths';
import { TabBar } from './TabBar';
import type { TabItem } from './TabBar';
import type { DiffOutcome, DiffRequest, FeedTabRequest, SelectionInfo, ViewerHandle, ViewerProps } from './types';
import './viewer.css';

interface TabModel {
  id: string;
  /** `feed` is the pinned live feed; `session` a closable read-only feed of a session or subagent. */
  kind: 'file' | 'diff' | 'claude' | 'feed' | 'session';
  /** Project-relative path (file tabs), the tab name (diff tabs) or the title (Claude and session tabs). */
  path: string;
  request?: DiffRequest;
  feed?: { sessionId: string; agentId: string | null };
}

const fileId = (path: string): string => `file:${path}`;
const diffId = (tabName: string): string => `diff:${tabName}`;
const CLAUDE_ID = 'claude:panel';
/** The Claude feed: always the first tab, cannot be closed. */
const FEED_ID = 'claude:feed';
const FEED_TAB: TabModel = { id: FEED_ID, kind: 'feed', path: 'Claude' };
const sessionTabId = (sessionId: string, agentId: string | null): string => `session:${sessionId}${agentId ? `/${agentId}` : ''}`;

const ZERO = { line: 0, character: 0 };
/** Delay before the open tabs are written to state.json. */
const TABS_SAVE_DELAY_MS = 300;

const HINTS: [string, string][] = [
  ['Cmd+F', 'Find in file'],
  ['Cmd+L', 'Go to line'],
  ['Cmd+E', 'Toggle edit mode'],
  ['Cmd+S', 'Save'],
  ['Cmd+Shift+E', 'Recent files'],
  ['Cmd+W', 'Close tab'],
  ['Cmd+Shift+T', 'Reopen closed tab'],
];

function EmptyState() {
  return (
    <div className="v-empty">
      <img className="v-empty-logo" src={logoUrl} alt="" draggable={false} />
      <dl className="v-hints">
        {HINTS.map(([keys, label]) => (
          <div key={keys}>
            <dt>{keys}</dt>
            <dd>{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const ViewerInner = forwardRef<ViewerHandle, ViewerProps>(function ViewerInner(
  { projectRoot, gitStatus, onActiveChange, onRevealInTree, claudeSessionId },
  ref,
) {
  const [tabs, setTabs] = useState<TabModel[]>([FEED_TAB]);
  const [selectedId, setSelectedId] = useState<string>(FEED_ID);
  // A closed tab can stay selected (closing several tabs in one go); the pinned feed takes over then.
  const activeId = tabs.some((t) => t.id === selectedId) ? selectedId : FEED_ID;
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const [reveal, setReveal] = useState<(RevealRequest & { id: string }) | null>(null);
  const [autosave, setAutosave] = useState(DEFAULT_EDITOR_SETTINGS.autosave);
  /** Saved tabs were read (or there were none); only then are changes written back. */
  const restored = useRef(false);
  const pendingTabs = useRef<ViewerTabsState | null>(null);
  const tabsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeId);
  const dirtyRef = useRef(dirtyMap);
  const panes = useRef(new Map<string, FilePaneHandle>());
  const resolvers = useRef(new Map<string, (outcome: DiffOutcome) => void>());
  const closedStack = useRef<string[]>([]);
  const nonce = useRef(0);
  const onActiveRef = useRef(onActiveChange);

  useEffect(() => {
    tabsRef.current = tabs;
    activeRef.current = activeId;
    dirtyRef.current = dirtyMap;
    onActiveRef.current = onActiveChange;
  });

  // Nothing selectable is active (no tab, or a diff tab).
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab || tab.kind !== 'file') onActiveRef.current?.(null);
  }, [tabs, activeId]);

  const reportSelection = useCallback(
    (path: string, info: SelectionInfo | null) => {
      const sel = info ?? { start: ZERO, end: ZERO, text: null };
      onActiveRef.current?.({
        path: toAbsolute(projectRoot, path),
        selection: { start: sel.start, end: sel.end },
        text: sel.text,
      });
    },
    [projectRoot],
  );

  const reportDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyMap((prev) => ({ ...prev, [fileId(path)]: dirty }));
  }, []);

  const removeTab = useCallback((id: string) => {
    const list = tabsRef.current;
    const index = list.findIndex((t) => t.id === id);
    if (index < 0) return;
    const neighbor = list[index + 1] ?? list[index - 1];
    panes.current.delete(id);
    setTabs((prev) => prev.filter((t) => t.id !== id));
    setDirtyMap((prev) => ({ ...prev, [id]: false }));
    setSelectedId((prev) => (prev === id ? (neighbor?.id ?? FEED_ID) : prev));
  }, []);

  const settle = useCallback((tabName: string, outcome: DiffOutcome) => {
    const resolve = resolvers.current.get(tabName);
    if (!resolve) return;
    resolvers.current.delete(tabName);
    resolve(outcome);
  }, []);

  const closeById = useCallback(
    (id: string): boolean => {
      const tab = tabsRef.current.find((t) => t.id === id);
      // The feed is pinned: closing it is a no-op that does not stop "Close All".
      if (!tab || tab.kind === 'feed') return true;
      if (tab.kind === 'claude' || tab.kind === 'session') {
        removeTab(id);
        return true;
      }
      if (tab.kind === 'file') {
        if (
          dirtyRef.current[id] &&
          !panes.current.get(id)?.saveBeforeClose() &&
          !window.confirm(`Discard unsaved changes in ${basename(tab.path)}?`)
        ) {
          return false;
        }
        closedStack.current.push(tab.path);
      } else {
        settle(tab.path, { result: 'rejected' });
      }
      removeTab(id);
      return true;
    },
    [removeTab, settle],
  );

  const openFile = useCallback(
    (path: string, line?: number, column?: number) => {
      const rel = toRelative(projectRoot, path);
      if (!rel) return;
      const id = fileId(rel);
      setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, kind: 'file', path: rel }]));
      setSelectedId(id);
      if (line !== undefined) setReveal({ id, line, column: column ?? 1, nonce: ++nonce.current });
    },
    [projectRoot],
  );

  const openDiff = useCallback(
    (request: DiffRequest): Promise<DiffOutcome> => {
      const id = diffId(request.tabName);
      settle(request.tabName, { result: 'closed' });
      const model: TabModel = { id, kind: 'diff', path: request.tabName, request };
      setTabs((prev) =>
        prev.some((t) => t.id === id) ? prev.map((t) => (t.id === id ? model : t)) : [...prev, model],
      );
      setSelectedId(id);
      return new Promise<DiffOutcome>((resolve) => {
        resolvers.current.set(request.tabName, resolve);
      });
    },
    [settle],
  );

  const openClaude = useCallback(() => {
    setTabs((prev) =>
      prev.some((t) => t.id === CLAUDE_ID) ? prev : [...prev, { id: CLAUDE_ID, kind: 'claude', path: 'Claude panel' }],
    );
    setSelectedId(CLAUDE_ID);
  }, []);

  /** Opens (or focuses) a read-only feed tab; titles are not paths, so they keep their slashes. */
  const openFeed = useCallback((request: FeedTabRequest) => {
    const agentId = request.agentId ?? null;
    const id = sessionTabId(request.sessionId, agentId);
    setTabs((prev) =>
      prev.some((t) => t.id === id)
        ? prev
        : [...prev, { id, kind: 'session', path: request.title, feed: { sessionId: request.sessionId, agentId } }],
    );
    setSelectedId(id);
  }, []);

  const closeActive = useCallback(() => {
    if (activeRef.current) closeById(activeRef.current);
  }, [closeById]);

  const stepTab = useCallback((step: number) => {
    const list = tabsRef.current;
    if (list.length === 0) return;
    const index = list.findIndex((t) => t.id === activeRef.current);
    const next = list[(index + step + list.length) % list.length];
    if (next) setSelectedId(next.id);
  }, []);

  const saveActive = useCallback(() => {
    const id = activeRef.current;
    if (id) void panes.current.get(id)?.save();
  }, []);

  const toggleEdit = useCallback(() => {
    const id = activeRef.current;
    if (id) panes.current.get(id)?.toggleEdit();
  }, []);

  useImperativeHandle(ref, () => ({
    open: openFile,
    openDiff,
    openClaude,
    openFeed,
    closeTab: (tabName) => {
      settle(tabName, { result: 'closed' });
      removeTab(diffId(tabName));
    },
    closeAllDiffTabs: () => {
      for (const tab of tabsRef.current) {
        if (tab.kind !== 'diff') continue;
        settle(tab.path, { result: 'closed' });
        removeTab(tab.id);
      }
    },
    closeActive,
    reopenClosed: () => {
      const path = closedStack.current.pop();
      if (path) openFile(toAbsolute(projectRoot, path));
    },
    saveActive,
    toggleEdit,
    stepTab,
  }));

  useEffect(() => {
    void window.acode.settings
      .get()
      .then((settings) => setAutosave(settings.autosave))
      .catch(() => undefined);
    return window.acode.settings.onChange((settings) => setAutosave(settings.autosave));
  }, []);

  // Reopen the file tabs of the last session behind the pinned feed, before any opened since.
  useEffect(() => {
    let cancelled = false;
    void window.acode.layout
      .getViewerTabs(projectRoot)
      .catch(() => null)
      .then((saved) => {
        if (cancelled) return;
        restored.current = true;
        if (!saved || saved.files.length === 0) return;
        setTabs((prev) => {
          const restoredTabs: TabModel[] = saved.files
            .map((path): TabModel => ({ id: fileId(path), kind: 'file', path }))
            .filter((tab) => !prev.some((t) => t.id === tab.id));
          return [...prev.filter((t) => t.kind === 'feed'), ...restoredTabs, ...prev.filter((t) => t.kind !== 'feed')];
        });
        const active = saved.active;
        if (active !== null) setSelectedId((prev) => (prev === FEED_ID ? fileId(active) : prev));
      });
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  const flushTabs = useCallback(() => {
    if (tabsTimer.current) clearTimeout(tabsTimer.current);
    tabsTimer.current = undefined;
    if (pendingTabs.current) window.acode.layout.setViewerTabs(projectRoot, pendingTabs.current);
    pendingTabs.current = null;
  }, [projectRoot]);

  // Persist file tabs (not diff, feed or panel tabs) and the active one, debounced.
  useEffect(() => {
    if (!restored.current) return;
    const active = tabs.find((t) => t.id === activeId);
    pendingTabs.current = {
      files: tabs.filter((t) => t.kind === 'file').map((t) => t.path),
      active: active?.kind === 'file' ? active.path : null,
    };
    if (tabsTimer.current) clearTimeout(tabsTimer.current);
    tabsTimer.current = setTimeout(flushTabs, TABS_SAVE_DELAY_MS);
  }, [tabs, activeId, flushTabs]);

  useEffect(() => {
    window.addEventListener('beforeunload', flushTabs);
    return () => {
      window.removeEventListener('beforeunload', flushTabs);
      flushTabs();
    };
  }, [flushTabs]);

  // The file in front goes to the top of the project's recent files.
  const activeTab = tabs.find((t) => t.id === activeId);
  const activeFile = activeTab?.kind === 'file' ? activeTab.path : null;
  useEffect(() => {
    if (activeFile) window.acode.layout.addRecentFile(projectRoot, activeFile);
  }, [activeFile, projectRoot]);

  // Pending diffs must never hang when the viewer goes away.
  useEffect(() => {
    const pending = resolvers.current;
    return () => {
      for (const resolve of pending.values()) resolve({ result: 'closed' });
      pending.clear();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!event.metaKey || event.altKey || event.ctrlKey) return;
    if (event.key === 's' && !event.shiftKey) {
      event.preventDefault();
      saveActive();
    } else if (event.key === 'e' && !event.shiftKey) {
      event.preventDefault();
      toggleEdit();
    }
  };

  const nameCount = new Map<string, number>();
  for (const tab of tabs) nameCount.set(basename(tab.path), (nameCount.get(basename(tab.path)) ?? 0) + 1);
  const items: TabItem[] = tabs.map((tab) => ({
    id: tab.id,
    title: tab.kind === 'session' ? tab.path : basename(tab.path),
    hint: tab.kind === 'file' && (nameCount.get(basename(tab.path)) ?? 0) > 1 ? dirname(tab.path) : '',
    kind: tab.kind,
    pinned: tab.kind === 'feed',
    dirty: dirtyMap[tab.id] === true,
    git: tab.kind === 'file' ? gitKind(gitStatus?.[tab.path]) : null,
  }));

  const pathOf = (id: string): string => tabs.find((t) => t.id === id)?.path ?? '';

  return (
    <div className="acode-viewer" onKeyDown={onKeyDown}>
      <TabBar
        tabs={items}
        activeId={activeId}
        onSelect={setSelectedId}
        onClose={closeById}
        onCloseOthers={(id) => {
          for (const tab of tabsRef.current) if (tab.id !== id && !closeById(tab.id)) break;
          setSelectedId(id);
        }}
        onCloseAll={() => {
          for (const tab of tabsRef.current) {
            // A tab whose close was cancelled stays open and in front.
            if (!closeById(tab.id)) {
              setSelectedId(tab.id);
              return;
            }
          }
          setSelectedId(FEED_ID);
        }}
        onCopyPath={(id) => void navigator.clipboard?.writeText(toAbsolute(projectRoot, pathOf(id)))}
        onReveal={(id) => onRevealInTree?.(pathOf(id))}
      />
      <div className="v-content">
        {/* The app mark in the corner of every tab; the feed and the Claude panel place their own. */}
        {activeTab?.kind !== 'feed' && activeTab?.kind !== 'session' && activeTab?.kind !== 'claude' && <img className="v-corner-logo" src={logoUrl} alt="" draggable={false} />}
        {tabs.map((tab) => (
          <div key={tab.id} className={tab.id === activeId ? 'v-slot active' : 'v-slot'}>
            {tab.kind === 'feed' ? (
              <FeedView
                projectRoot={projectRoot}
                sessionId={claudeSessionId ?? null}
                visible={tab.id === activeId}
                empty={<EmptyState />}
                interactive
              />
            ) : tab.kind === 'session' && tab.feed ? (
              <FeedView
                projectRoot={projectRoot}
                sessionId={tab.feed.sessionId}
                agentId={tab.feed.agentId}
                visible={tab.id === activeId}
                interactive={false}
              />
            ) : tab.kind === 'claude' ? (
              <ClaudePanel projectRoot={projectRoot} />
            ) : tab.kind === 'file' ? (
              <FilePane
                ref={(handle) => {
                  if (handle) panes.current.set(tab.id, handle);
                  else panes.current.delete(tab.id);
                }}
                root={projectRoot}
                path={tab.path}
                active={tab.id === activeId}
                autosave={autosave}
                reveal={reveal?.id === tab.id ? reveal : null}
                onDirtyChange={reportDirty}
                onSelection={reportSelection}
                onOpenFile={openFile}
              />
            ) : (
              tab.request && (
                <DiffTab
                  request={tab.request}
                  onApply={(contents) => {
                    settle(tab.path, { result: 'saved', contents });
                    removeTab(tab.id);
                  }}
                  onReject={() => closeById(tab.id)}
                />
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
});

/** File viewer: tabs, CodeMirror editor, markdown preview, images and diffs. */
export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(props, ref) {
  // Remount when the project changes so no tab leaks across projects.
  return <ViewerInner key={props.projectRoot} ref={ref} {...props} />;
});
