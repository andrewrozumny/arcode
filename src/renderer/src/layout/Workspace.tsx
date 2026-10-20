import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LayoutCommand, PanelLayout } from '@shared/app';
import { bus } from '../bus';
import { ActivityBar } from './ActivityBar';
import { Splitter } from './Splitter';
import { terminalFraction, terminalHeightPx, togglePanels, treeFraction, treeWidthPx } from './layoutMath';

interface Props {
  projectRoot: string;
  initialLayout: PanelLayout;
  tree: ReactNode;
  viewer: ReactNode;
  terminal: ReactNode;
  searchOpen: boolean;
  /** What the left column shows: the project tree, Find in files or Changes. */
  leftMode: LeftMode;
  onLeftMode(mode: LeftMode): void;
  /** Opens Find in files (shows the column, switches to it and focuses the query). */
  onOpenFind(): void;
  /** Opens Changes (shows the column, switches to it and focuses the list). */
  onOpenChanges(): void;
  onOpenSearch(): void;
  onOpenClaude(): void;
}

export type LeftMode = 'tree' | 'find' | 'changes';

type Visibility = Pick<PanelLayout, 'treeVisible' | 'terminalVisible'>;

function useSize(ref: React.RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = (): void => setSize({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * Three zones: tree on the left and viewer on the right in the top row, terminal dock
 * across the full width below them. Panels stay mounted while hidden.
 */
export function Workspace({
  projectRoot,
  initialLayout,
  tree,
  viewer,
  terminal,
  searchOpen,
  leftMode,
  onLeftMode,
  onOpenFind,
  onOpenChanges,
  onOpenSearch,
  onOpenClaude,
}: Props) {
  const [layout, setLayout] = useState<PanelLayout>(initialLayout);
  const remembered = useRef<Visibility | null>(null);
  const dragStart = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const rootSize = useSize(rootRef);
  const topSize = useSize(topRef);

  const dragging = useRef(false);
  const saved = useRef(initialLayout);

  // Persist every settled change; during a splitter drag only the final size is saved.
  useEffect(() => {
    if (dragging.current || saved.current === layout) return;
    saved.current = layout;
    window.acode.layout.set(projectRoot, layout);
  }, [layout, projectRoot]);

  const update = useCallback((change: (prev: PanelLayout) => PanelLayout) => setLayout(change), []);
  const startDrag = (sizePx: number): void => {
    dragging.current = true;
    dragStart.current = sizePx;
  };
  const endDrag = (): void => {
    dragging.current = false;
    setLayout((prev) => ({ ...prev }));
  };

  useEffect(
    () =>
      window.acode.app.onLayoutCommand((command: LayoutCommand) => {
        if (command === 'toggle-tree') update((prev) => ({ ...prev, treeVisible: !prev.treeVisible }));
        else if (command === 'toggle-terminal') update((prev) => ({ ...prev, terminalVisible: !prev.terminalVisible }));
        else
          update((prev) => {
            const result = togglePanels(prev, remembered.current);
            remembered.current = result.remembered;
            return result.layout;
          });
      }),
    [update],
  );

  // A terminal action from elsewhere (new Claude tab, gate) brings a hidden dock back.
  useEffect(
    () =>
      bus.on('focusPanel', ({ panel }) => {
        if (panel === 'terminal') update((prev) => (prev.terminalVisible ? prev : { ...prev, terminalVisible: true }));
        else if (panel === 'tree') update((prev) => (prev.treeVisible ? prev : { ...prev, treeVisible: true }));
      }),
    [update],
  );

  const treePx = treeWidthPx(layout.treeWidth, topSize.width);
  const terminalPx = terminalHeightPx(layout.terminalHeight, rootSize.height);

  const toggleTree = (): void => update((prev) => ({ ...prev, treeVisible: !prev.treeVisible }));
  const toggleTerminal = (): void => update((prev) => ({ ...prev, terminalVisible: !prev.terminalVisible }));
  // The tree, Find in files and Changes share the left column: the button of a hidden mode switches to it,
  // the button of the shown mode behaves as before (the tree hides the column, the others go back to the tree).
  const onTreeButton = (): void => {
    if (layout.treeVisible && leftMode !== 'tree') onLeftMode('tree');
    else toggleTree();
  };
  const onFindButton = (): void => {
    if (layout.treeVisible && leftMode === 'find') onLeftMode('tree');
    else onOpenFind();
  };
  const onChangesButton = (): void => {
    if (layout.treeVisible && leftMode === 'changes') onLeftMode('tree');
    else onOpenChanges();
  };

  return (
    <div className="workspace" ref={rootRef}>
      <div className="workspace-main">
        <ActivityBar
          treeVisible={layout.treeVisible}
          leftMode={leftMode}
          terminalVisible={layout.terminalVisible}
          searchOpen={searchOpen}
          onToggleTree={onTreeButton}
          onToggleFind={onFindButton}
          onToggleChanges={onChangesButton}
          onToggleTerminal={toggleTerminal}
          onOpenSearch={onOpenSearch}
          onOpenClaude={onOpenClaude}
        />
        <div className="workspace-stack">
          <div className="top-row" ref={topRef}>
            <aside className="tree-pane" hidden={!layout.treeVisible} style={{ width: treePx }}>
              {tree}
            </aside>
            {layout.treeVisible && (
              <Splitter
                orientation="vertical"
                onDragStart={() => startDrag(treePx)}
                onDrag={(delta) =>
                  update((prev) => ({ ...prev, treeWidth: treeFraction(dragStart.current + delta, topSize.width) }))
                }
                onDragEnd={endDrag}
              />
            )}
            <section className="viewer-pane">{viewer}</section>
          </div>
          {layout.terminalVisible && (
            <Splitter
              orientation="horizontal"
              onDragStart={() => startDrag(terminalPx)}
              onDrag={(delta) =>
                update((prev) => ({
                  ...prev,
                  terminalHeight: terminalFraction(dragStart.current - delta, rootSize.height),
                }))
              }
              onDragEnd={endDrag}
            />
          )}
          <section className="terminal-dock" hidden={!layout.terminalVisible} style={{ height: terminalPx }}>
            {terminal}
          </section>
        </div>
      </div>
    </div>
  );
}
