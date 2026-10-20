import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_LAYOUT, baseName } from '@shared/app';
import type { GateTarget, PanelLayout, WindowContext } from '@shared/app';
import type { ChangedFile } from '@shared/files';
import type { TerminalPaneState } from '@shared/terminal';
import { bus } from './bus';
import { useHeaderClaude } from './claude/useHeaderClaude';
import { useIdeBridge } from './ide/useIdeBridge';
import { Header } from './layout/Header';
import { TerminalDock } from './layout/TerminalDock';
import { useGitStatus } from './layout/useGitStatus';
import type { TerminalPaneHandle } from './TerminalPane';
import { Workspace } from './layout/Workspace';
import type { LeftMode } from './layout/Workspace';
import { ProjectPalette } from './projects/ProjectPalette';
import { mentionLines, resolveShortcut } from './shortcuts';
import type { FocusZone } from './shortcuts';
import { loadFonts } from './theme/fonts';
import { FileSearch } from './tree/FileSearch';
import type { FileSearchMode } from './tree/recentFiles';
import { FileTree } from './tree/FileTree';
import { ChangesView } from './tree/ChangesView';
import { FindInFiles } from './tree/FindInFiles';
import type { FindFocusRequest } from './tree/FindInFiles';
import { prefillFromSelection } from './tree/findModel';
import { Viewer } from './viewer/Viewer';
import type { ActiveInfo, ViewerHandle } from './viewer/types';

const context: WindowContext = window.acode.app.context();

export function App() {
  if (context.view === 'palette') return <ProjectPalette home={context.home} />;
  return <ProjectWindow projectRoot={context.projectRoot} home={context.home} />;
}

function focusZone(): FocusZone {
  const active = document.activeElement;
  if (!active) return 'other';
  if (active.closest('.terminal-dock')) return 'terminal';
  if (active.closest('.viewer-pane')) return 'viewer';
  if (active.closest('.tree-pane')) return 'tree';
  return 'other';
}

/** Cmd+W goes to the terminal when it has focus, otherwise to the viewer. */
function routeCloseTab(): void {
  bus.emit(focusZone() === 'terminal' ? 'closeTerminalTab' : 'closeViewerTab');
}

function toAbsolute(root: string, path: string): string {
  return path.startsWith('/') ? path : `${root.replace(/\/+$/, '')}/${path}`;
}

function ProjectWindow({ projectRoot, home }: { projectRoot: string; home: string }) {
  const [layout, setLayout] = useState<PanelLayout | null>(null);
  const [savedTerminal, setSavedTerminal] = useState<TerminalPaneState | undefined>(undefined);
  const terminalRef = useRef<TerminalPaneHandle>(null);
  const [activePath, setActivePath] = useState<string | undefined>(undefined);
  const [revealPath, setRevealPath] = useState<string | undefined>(undefined);
  const [searchMode, setSearchMode] = useState<FileSearchMode | null>(null);
  const [leftMode, setLeftMode] = useState<LeftMode>('tree');
  const [findRequest, setFindRequest] = useState<FindFocusRequest>({ nonce: 0, prefill: null });
  const [changesFocus, setChangesFocus] = useState(0);
  const viewerRef = useRef<ViewerHandle>(null);
  const activeInfo = useRef<ActiveInfo | null>(null);
  const { files: gitStatus, branch } = useGitStatus(projectRoot);
  const ide = useIdeBridge(viewerRef);
  const { onTabsChange, usage, badgeModel, running, feedSessionId } = useHeaderClaude(projectRoot);

  useEffect(() => {
    document.title = baseName(projectRoot);
    // Wait for the saved layout, the saved terminal tabs and the monospace font so the
    // terminal measures cells once and restores its tabs on mount.
    void Promise.all([
      window.acode.layout.get(projectRoot).catch(() => null),
      window.acode.layout.getTerminal(projectRoot).catch(() => null),
      loadFonts(),
    ]).then(([saved, terminal]) => {
      setSavedTerminal(terminal ?? undefined);
      setLayout(saved ?? DEFAULT_LAYOUT);
    });
  }, [projectRoot]);

  // Menu tab commands, routed by focus. Inside the terminal the pane handles Cmd+T/W and
  // Cmd+Shift+]/[ on keydown, so these only arrive from menu clicks or from other panels.
  useEffect(() => {
    const offs = [
      window.acode.menu.onNewTab(() => {
        bus.emit('focusPanel', { panel: 'terminal' });
        terminalRef.current?.newShell();
      }),
      window.acode.menu.onCloseTab(routeCloseTab),
      window.acode.menu.onSelectTab((step) => {
        if (focusZone() === 'terminal') terminalRef.current?.stepTab(step);
        else viewerRef.current?.stepTab(step);
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, []);

  // Panels talk through the bus; the viewer and tree are wired here.
  useEffect(() => {
    const offs = [
      bus.on('openFile', ({ path, line, column, diff }) => viewerRef.current?.open(path, line, column, diff)),
      bus.on('closeViewerTab', () => viewerRef.current?.closeActive()),
      bus.on('closeTerminalTab', () => terminalRef.current?.closeActiveTab()),
      bus.on('runGate', ({ target }) => {
        bus.emit('focusPanel', { panel: 'terminal' });
        terminalRef.current?.runGate(target);
      }),
      bus.on('revealInTree', ({ path }) => setRevealPath(toAbsolute(projectRoot, path))),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [projectRoot]);

  const openFile = useCallback((path: string, line?: number) => {
    bus.openFile(line === undefined ? { path } : { path, line });
  }, []);

  /** Shows Find in files in the left column and focuses its query, prefilled with the editor selection. */
  const openFind = useCallback(() => {
    setLeftMode('find');
    setFindRequest((prev) => ({ nonce: prev.nonce + 1, prefill: prefillFromSelection(activeInfo.current?.text) }));
    bus.emit('focusPanel', { panel: 'tree' });
  }, []);

  /** Shows Changes in the left column and focuses its list. */
  const openChanges = useCallback(() => {
    setLeftMode('changes');
    setChangesFocus((n) => n + 1);
    bus.emit('focusPanel', { panel: 'tree' });
  }, []);

  /** Esc in Find in files or Changes: back to the tree, with focus on it. */
  const closeFind = useCallback(() => {
    setLeftMode('tree');
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.tree-pane .ft-body')?.focus());
  }, []);

  const openMatch = useCallback((path: string, line: number, column: number) => {
    bus.openFile({ path, line, column });
  }, []);

  const openChange = useCallback(
    (file: ChangedFile) => {
      bus.openFile({ path: toAbsolute(projectRoot, file.path), diff: file.status === 'D' ? 'deleted' : 'head' });
    },
    [projectRoot],
  );

  const onActiveChange = useCallback((info: ActiveInfo | null) => {
    activeInfo.current = info;
    setActivePath(info?.path);
    setRevealPath(undefined);
    if (info) window.acode.ide.selectionChanged({ filePath: info.path, selection: info.selection, text: info.text });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = resolveShortcut(event, focusZone());
      if (!action) return;
      const viewer = viewerRef.current;
      event.preventDefault();
      event.stopPropagation();
      switch (action) {
        case 'fileSearch':
          setSearchMode('files');
          break;
        case 'recentFiles':
          setSearchMode('recent');
          break;
        case 'findInFiles':
          setSearchMode(null);
          openFind();
          break;
        case 'changes':
          setSearchMode(null);
          openChanges();
          break;
        case 'reopenTab':
          viewer?.reopenClosed();
          break;
        case 'save':
          viewer?.saveActive();
          break;
        case 'toggleEdit':
          viewer?.toggleEdit();
          break;
        case 'nextTab':
          viewer?.stepTab(1);
          break;
        case 'prevTab':
          viewer?.stepTab(-1);
          break;
        case 'newClaude':
          bus.emit('focusPanel', { panel: 'terminal' });
          terminalRef.current?.newClaude();
          break;
        case 'atMention': {
          const info = activeInfo.current;
          if (!info) break;
          const lines = mentionLines(info.selection);
          window.acode.ide.atMentioned(lines ? { filePath: info.path, ...lines } : { filePath: info.path });
          break;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openFind, openChanges]);

  /** Gate buttons. The terminal runs `scripts/gates.sh <target>` in a new tab (see the `runGate` listener). */
  const onRunGate = useCallback((target: GateTarget) => {
    if (bus.count('runGate') === 0) console.info(`[arcode] no gate runner attached for "${target}"`);
    bus.emit('runGate', { target });
  }, []);

  const treePath = revealPath ?? activePath;

  return (
    <div className="window">
      <Header
        projectRoot={projectRoot}
        home={home}
        onRunGate={onRunGate}
        onOpenProjects={() => window.acode.app.showPalette()}
        ide={ide}
        claudeModel={badgeModel}
        onOpenClaude={() => viewerRef.current?.openClaude()}
        branch={branch}
        usage={usage}
        subagents={running}
      />
      {layout && (
        <Workspace
          projectRoot={projectRoot}
          initialLayout={layout}
          tree={
            <>
              <div className="tree-host" hidden={leftMode !== 'tree'}>
                <FileTree
                  projectRoot={projectRoot}
                  onOpenFile={openFile}
                  {...(treePath ? { activePath: treePath } : {})}
                />
              </div>
              <div className="tree-host" hidden={leftMode !== 'find'}>
                <FindInFiles
                  projectRoot={projectRoot}
                  focusRequest={findRequest}
                  onOpenMatch={openMatch}
                  onClose={closeFind}
                />
              </div>
              <div className="tree-host" hidden={leftMode !== 'changes'}>
                <ChangesView
                  projectRoot={projectRoot}
                  visible={leftMode === 'changes'}
                  focusNonce={changesFocus}
                  onOpenFile={openChange}
                  onClose={closeFind}
                />
              </div>
            </>
          }
          leftMode={leftMode}
          onLeftMode={setLeftMode}
          onOpenFind={openFind}
          onOpenChanges={openChanges}
          viewer={
            <Viewer
              ref={viewerRef}
              projectRoot={projectRoot}
              gitStatus={gitStatus}
              onActiveChange={onActiveChange}
              onRevealInTree={(path) => bus.emit('revealInTree', { path })}
              claudeSessionId={feedSessionId}
            />
          }
          terminal={<TerminalDock ref={terminalRef} projectRoot={projectRoot} initialState={savedTerminal} onTabsChange={onTabsChange} />}
          searchOpen={searchMode !== null}
          onOpenSearch={() => setSearchMode('files')}
          onOpenClaude={() => viewerRef.current?.openClaude()}
        />
      )}
      <FileSearch
        // A new mode remounts the palette with a fresh query.
        key={searchMode ?? 'closed'}
        open={searchMode !== null}
        mode={searchMode ?? 'files'}
        currentPath={activePath}
        onClose={() => setSearchMode(null)}
        projectRoot={projectRoot}
        onOpenFile={openFile}
      />
    </div>
  );
}
