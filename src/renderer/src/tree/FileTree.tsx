import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, MouseEvent, ReactElement } from 'react';
import { ARCODE_PATH_TYPE, encodeDraggedPaths } from '@shared/files';
import { ipcErrorMessage } from '../format';
import { ContextMenu, PromptDialog } from './overlays';
import { ImportDialog } from './ImportDialog';
import type { MenuItem, PromptState } from './overlays';
import { useDirectoryTree } from './useDirectoryTree';
import { TreeHeader } from './TreeHeader';
import { TreeRow } from './TreeRow';
import {
  EMPTY_SELECTION,
  ROW_HEIGHT,
  ancestorsOf,
  baseName,
  clickSelection,
  flatten,
  getFilesApi,
  isUnderAny,
  joinPath,
  parentOf,
  partialDeleteMessage,
  remapPath,
  singleSelection,
  toRel,
  topmostPaths,
  withoutPaths,
} from './model';
import type { Row, TreeSelection } from './model';
import './tree.css';

export interface FileTreeProps {
  projectRoot: string;
  onOpenFile(path: string, line?: number): void;
  /** Absolute path of the file shown in the editor; the tree expands to it and highlights it. */
  activePath?: string;
}

interface MenuState {
  x: number;
  y: number;
  /** Built when the menu opens (and rebuilt once the clipboard has been checked), never during render. */
  items: MenuItem[];
}

const OVERSCAN = 8;

function copyText(text: string): void {
  const bridge = window.acode?.clipboard;
  if (bridge) bridge.writeText(text);
  else void navigator.clipboard.writeText(text);
}

export function FileTree(props: FileTreeProps): ReactElement {
  // Remount per project so every piece of state starts fresh.
  return <FileTreeInner key={props.projectRoot} {...props} />;
}

function FileTreeInner({ projectRoot, onOpenFile, activePath }: FileTreeProps): ReactElement {
  const api = getFilesApi();
  const { children, setChildren, childrenRef, expanded, setExpanded, git, loadDir, expandDir, collapseDir, toggleDir } =
    useDirectoryTree(projectRoot);
  const [selection, setSelection] = useState<TreeSelection>(EMPTY_SELECTION);
  /** The keyboard row: arrows move from it, Enter, F2 and Cmd+V act on it. */
  const selected = selection.focus;
  const setSelected = useCallback((rel: string | null): void => setSelection(singleSelection(rel)), []);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  /** Folder the Import from Mac dialog copies into; null while closed. */
  const [importTarget, setImportTarget] = useState<{ rel: string; label: string } | null>(null);
  /** Folder (project-relative) highlighted while files from Finder are dragged over it; '' is the root. */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | null>(null);
  const [scrollTick, setScrollTick] = useState(0);

  const rows = useMemo(() => flatten(children, expanded), [children, expanded]);
  const gitDirs = useMemo(() => new Set(git.dirs), [git.dirs]);
  const activeRel = activePath ? toRel(projectRoot, activePath) : null;

  // Track viewport height.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = (): void => setViewport(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const indexOf = useCallback((rel: string): number => rows.findIndex((r) => r.rel === rel), [rows]);

  /** Selected rows that are visible, in tree order. */
  const selectedRows = (): Row[] => rows.filter((r) => selection.items.has(r.rel));

  /** Rows a mouse action applies to: the whole selection when `row` is part of it, otherwise just `row`. */
  const targetsFor = (row: Row): Row[] => (selection.items.has(row.rel) ? selectedRows() : [row]);

  const scrollToIndex = useCallback((index: number, center: boolean): void => {
    const el = bodyRef.current;
    if (!el || index < 0) return;
    const top = index * ROW_HEIGHT;
    if (center) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2 + ROW_HEIGHT);
    } else if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    }
  }, []);

  // Complete a pending "scroll to" once the row exists.
  useEffect(() => {
    const target = pendingScroll.current;
    if (!target) return;
    const index = rows.findIndex((r) => r.rel === target);
    if (index >= 0) {
      pendingScroll.current = null;
      scrollToIndex(index, true);
    }
  }, [rows, scrollTick, scrollToIndex]);

  const revealRel = useCallback(
    async (rel: string): Promise<void> => {
      for (const dir of ancestorsOf(rel)) await expandDir(dir);
      pendingScroll.current = rel;
      setSelected(rel);
      setScrollTick((t) => t + 1);
    },
    [expandDir, setSelected],
  );

  useEffect(() => {
    if (!activeRel) return;
    const timer = setTimeout(() => void revealRel(activeRel), 0);
    return () => clearTimeout(timer);
  }, [activeRel, revealRel]);

  const collapseAll = useCallback((): void => {
    setExpanded(new Set());
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [setExpanded]);

  const openRow = useCallback(
    (row: Row): void => {
      if (row.kind === 'dir') toggleDir(row.rel);
      else onOpenFile(joinPath(projectRoot, row.rel));
    },
    [onOpenFile, projectRoot, toggleDir],
  );

  /** Moves the keyboard row; with `extend` (Shift) the selection grows from the anchor instead of being replaced. */
  const moveSelection = useCallback(
    (index: number, extend = false): void => {
      const clamped = Math.max(0, Math.min(rows.length - 1, index));
      const row = rows[clamped];
      if (!row) return;
      if (extend) setSelection((prev) => clickSelection(prev, rows, row.rel, { toggle: false, range: true }));
      else setSelected(row.rel);
      scrollToIndex(clamped, false);
    },
    [rows, scrollToIndex, setSelected],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const current = selected === null ? -1 : indexOf(selected);
    const row = current >= 0 ? rows[current] : undefined;
    const extend = event.shiftKey;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(current + 1, extend);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(current < 0 ? 0 : current - 1, extend);
        break;
      case 'Home':
        event.preventDefault();
        moveSelection(0, extend);
        break;
      case 'End':
        event.preventDefault();
        moveSelection(rows.length - 1, extend);
        break;
      case 'PageDown':
        event.preventDefault();
        moveSelection(current + Math.floor(viewport / ROW_HEIGHT), extend);
        break;
      case 'PageUp':
        event.preventDefault();
        moveSelection(current - Math.floor(viewport / ROW_HEIGHT), extend);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (row?.kind === 'dir') {
          if (!row.expanded) void expandDir(row.rel);
          else moveSelection(current + 1);
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (row?.kind === 'dir' && row.expanded) collapseDir(row.rel);
        else if (row && row.depth > 0) {
          const parent = indexOf(parentOf(row.rel));
          if (parent >= 0) moveSelection(parent);
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (row) openRow(row);
        break;
      case 'F2':
        event.preventDefault();
        if (row) startRename(row);
        break;
      case 'Backspace':
      case 'Delete':
        event.preventDefault();
        if (selectedRows().length > 0) startDelete(selectedRows());
        break;
    }
  };

  const reloadAfterOp = useCallback(
    async (...dirs: string[]): Promise<void> => {
      await Promise.all([...new Set(dirs)].map((d) => (childrenRef.current.has(d) ? loadDir(d) : undefined)));
    },
    [childrenRef, loadDir],
  );

  const runOp = useCallback(
    async (op: Parameters<typeof api.op>[1]): Promise<string | null> => {
      try {
        await api.op(projectRoot, op);
        return null;
      } catch (error) {
        return ipcErrorMessage(error, 'Operation failed');
      }
    },
    [api, projectRoot],
  );

  const startCreate = (kind: 'file' | 'dir', dirRel: string): void => {
    setPrompt({
      title: kind === 'file' ? 'New File' : 'New Folder',
      label: dirRel ? `in ${dirRel}/` : 'in project root',
      initial: '',
      confirmLabel: 'Create',
      onSubmit: async (value) => {
        const name = value.trim();
        if (!name) return 'Enter a name';
        const rel = dirRel ? `${dirRel}/${name}` : name;
        const error = await runOp(kind === 'file' ? { type: 'createFile', relPath: rel } : { type: 'createDir', relPath: rel });
        if (error) return error;
        if (dirRel) await expandDir(dirRel);
        await reloadAfterOp(dirRel, parentOf(rel));
        for (const dir of ancestorsOf(rel)) await expandDir(dir);
        await reloadAfterOp(parentOf(rel));
        pendingScroll.current = rel;
        setSelected(rel);
        setScrollTick((t) => t + 1);
        if (kind === 'file') onOpenFile(joinPath(projectRoot, rel));
        return null;
      },
    });
  };

  function startRename(row: Row): void {
    setPrompt({
      title: 'Rename',
      label: row.rel,
      initial: row.name,
      confirmLabel: 'Rename',
      onSubmit: async (value) => {
        const name = value.trim();
        if (!name) return 'Enter a name';
        if (name === row.name) return null;
        const parent = parentOf(row.rel);
        const target = parent ? `${parent}/${name}` : name;
        const error = await runOp({ type: 'rename', relPath: row.rel, newRelPath: target });
        if (error) return error;
        setExpanded((prev) => new Set([...prev].map((p) => remapPath(p, row.rel, target))));
        setChildren((prev) => new Map([...prev].map(([key, value]) => [remapPath(key, row.rel, target), value])));
        await reloadAfterOp(parent);
        setSelected(target);
        return null;
      },
    });
  }

  function startDelete(targets: Row[]): void {
    // A folder takes its selected contents with it; deleting those again would fail.
    const rels = topmostPaths(targets.map((r) => r.rel));
    const only = rels.length === 1 ? targets.find((r) => r.rel === rels[0]) : undefined;
    // Items still to trash: the prompt stays open on an error, and a retry must not redo what already went.
    const remaining = [...rels];
    let moved = 0;
    setPrompt({
      title: 'Move to Trash',
      label: only ? `Move "${only.name}" to the Trash?` : `Move ${rels.length} items to the Trash?`,
      confirmLabel: 'Move to Trash',
      onSubmit: async () => {
        const gone: string[] = [];
        let error: string | null = null;
        let failed = '';
        for (let rel = remaining[0]; rel !== undefined; rel = remaining[0]) {
          error = await runOp({ type: 'delete', relPath: rel });
          if (error) {
            failed = rel;
            break;
          }
          remaining.shift();
          gone.push(rel);
          moved += 1;
        }
        const kept = (p: string): boolean => !isUnderAny(p, gone);
        setExpanded((prev) => new Set([...prev].filter(kept)));
        setChildren((prev) => new Map([...prev].filter(([key]) => kept(key))));
        setSelection((prev) => withoutPaths(prev, gone));
        await reloadAfterOp(...gone.map(parentOf));
        if (error) return rels.length === 1 ? error : partialDeleteMessage(moved, rels.length, failed, error);
        return null;
      },
    });
  }

  /** Folder that receives pasted or dropped files: a folder row itself, a file's parent, or the root. */
  const folderFor = (row: Row | null): string => (row ? (row.kind === 'dir' ? row.rel : parentOf(row.rel)) : '');

  const copyIntoProject = useCallback(
    async (dirRel: string, sources: string[]): Promise<void> => {
      if (sources.length === 0) return;
      setOpError(null);
      try {
        const created = await api.importFiles(projectRoot, dirRel, sources);
        if (dirRel) await expandDir(dirRel);
        await reloadAfterOp(dirRel);
        const first = created[0];
        if (first) void revealRel(first);
      } catch (error) {
        setOpError(ipcErrorMessage(error, 'Copy failed'));
      }
    },
    [api, expandDir, projectRoot, reloadAfterOp, revealRel],
  );

  const pasteFiles = useCallback(
    async (dirRel: string): Promise<void> => {
      const sources = await api.clipboardFiles().catch(() => [] as string[]);
      await copyIntoProject(dirRel, sources);
    },
    [api, copyIntoProject],
  );

  // Cmd+V while the tree has focus: files copied in Finder go into the selected folder.
  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    const row = selected === null ? null : (rows.find((r) => r.rel === selected) ?? null);
    event.preventDefault();
    void pasteFiles(folderFor(row));
  };

  const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer.types).includes('Files');

  /** Cmd+C or the menu: the rows go on the clipboard as real files (Finder pastes them) and as their paths. */
  const copyRows = (targets: Row[]): void => {
    void api.copyToClipboard(targets.map((r) => joinPath(projectRoot, r.rel))).catch(() => undefined);
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>): void => {
    // Let text inputs (rename/create prompts) keep their own copy.
    if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
    const chosen = selectedRows();
    if (chosen.length === 0) return;
    event.preventDefault();
    copyRows(chosen);
  };

  /** Dragging a row (or the selection it belongs to) carries its absolute paths, so the terminal can type them. */
  const onRowDragStart = (event: DragEvent<HTMLDivElement>, row: Row): void => {
    const abs = targetsFor(row).map((r) => joinPath(projectRoot, r.rel));
    event.dataTransfer.setData(ARCODE_PATH_TYPE, encodeDraggedPaths(abs));
    event.dataTransfer.setData('text/plain', abs.join('\n'));
    event.dataTransfer.effectAllowed = 'copyLink';
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>, row: Row | null): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    const target = folderFor(row);
    if (target !== dropTarget) setDropTarget(target);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>, row: Row | null): void => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const sources: string[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      try {
        const path = api.pathForFile(file);
        if (path) sources.push(path);
      } catch {
        // Not a real file on disk (e.g. dragged from a browser): skip it.
      }
    }
    void copyIntoProject(folderFor(row), sources);
  };

  const openMenu = (event: MouseEvent, row: Row | null): void => {
    event.preventDefault();
    event.stopPropagation();
    // Right-clicking inside the selection keeps it, so the menu acts on all of it, like Finder.
    if (row && !selection.items.has(row.rel)) setSelected(row.rel);
    const targets = row ? targetsFor(row) : [];
    const at = { x: event.clientX, y: event.clientY };
    setMenu({ ...at, items: menuItems(row, targets, 0) });
    // The clipboard check is async; enable "Paste files" once it answers, if this menu is still open.
    void api
      .clipboardFiles()
      .then((files) =>
        setMenu((m) => (m && m.x === at.x && m.y === at.y ? { ...m, items: menuItems(row, targets, files.length) } : m)),
      )
      .catch(() => undefined);
  };

  /**
   * Row the menu was opened on; null for the empty area (project root). Copy, the paths and Delete
   * act on `targets` (the selection); create, import, paste, reveal and rename on the row itself.
   */
  const menuItems = (row: Row | null, targets: Row[], pasteCount: number): MenuItem[] => {
    const rel = row?.rel ?? '';
    const rels = targets.length > 0 ? targets.map((r) => r.rel) : [rel];
    const createDir = row ? (row.kind === 'dir' ? row.rel : parentOf(row.rel)) : '';
    const items: MenuItem[] = [
      { label: 'New File', run: () => startCreate('file', createDir) },
      { label: 'New Folder', run: () => startCreate('dir', createDir) },
      ...(!row || row.kind === 'dir'
        ? [{ label: 'Import from Mac…', run: () => setImportTarget({ rel, label: rel || baseName(projectRoot) }) }]
        : []),
      {
        label: pasteCount > 0 ? `Paste ${pasteCount} file${pasteCount === 1 ? '' : 's'}` : 'Paste files',
        hint: '⌘V',
        disabled: pasteCount === 0,
        run: () => void pasteFiles(createDir),
      },
      { separator: true },
      ...(row ? [{ label: 'Copy', hint: '⌘C', run: () => copyRows(targets) }] : []),
      { label: 'Reveal in Finder', run: () => void api.reveal(projectRoot, rel).catch(() => undefined) },
      { label: 'Copy Path', run: () => copyText(rels.map((r) => joinPath(projectRoot, r)).join('\n')) },
      { label: 'Copy Relative Path', run: () => copyText(rels.map((r) => r || '.').join('\n')) },
    ];
    if (row) {
      items.push(
        { separator: true },
        { label: 'Rename', hint: 'F2', run: () => startRename(row) },
        { label: 'Delete', hint: '⌫', run: () => startDelete(targets), danger: true },
      );
    }
    return items;
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  return (
    <div className="ft-root">
      <TreeHeader
        projectRoot={projectRoot}
        canReveal={!!activeRel}
        onReveal={() => activeRel && void revealRel(activeRel)}
        onCollapseAll={collapseAll}
      />
      <div
        ref={bodyRef}
        className="ft-body"
        tabIndex={0}
        role="tree"
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCopy={onCopy}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={(e) => openMenu(e, null)}
        onDragOver={(e) => onDragOver(e, null)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(e) => onDrop(e, null)}
      >
        <div className="ft-spacer" style={{ height: rows.length * ROW_HEIGHT }}>
          {visible.map((row, i) => (
            <TreeRow
              key={row.rel}
              row={row}
              top={(first + i) * ROW_HEIGHT}
              status={row.kind === 'dir' ? undefined : git.files[row.rel]}
              changedDir={row.kind === 'dir' && gitDirs.has(row.rel)}
              selected={selection.items.has(row.rel)}
              active={row.rel === activeRel}
              dropTarget={dropTarget !== null && dropTarget === folderFor(row)}
              onSelect={(e) =>
                setSelection((prev) => clickSelection(prev, rows, row.rel, { toggle: e.metaKey, range: e.shiftKey }))
              }
              onOpen={(e) => {
                // A double click with Cmd or Shift is two selection clicks, not an open.
                if (!e.metaKey && !e.shiftKey) openRow(row);
              }}
              onToggle={() => toggleDir(row.rel)}
              onContextMenu={(e) => openMenu(e, row)}
              onDragStart={(e) => onRowDragStart(e, row)}
              onDragOver={(e) => onDragOver(e, row)}
              onDrop={(e) => onDrop(e, row)}
            />
          ))}
        </div>
      </div>
      {opError && (
        <div className="ft-error" role="alert">
          <span>{opError}</span>
          <button type="button" className="ft-btn" title="Dismiss" onClick={() => setOpError(null)}>
            ×
          </button>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {prompt && <PromptDialog state={prompt} onClose={() => setPrompt(null)} />}
      {importTarget && (
        <ImportDialog
          projectRoot={projectRoot}
          targetRel={importTarget.rel}
          targetLabel={importTarget.label}
          onClose={() => setImportTarget(null)}
          onImported={(created) => {
            const first = created[0];
            if (first) void revealRel(first);
          }}
        />
      )}
    </div>
  );
}
