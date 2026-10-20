import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { ChangedFile, ChangesResult } from '@shared/files';
import {
  CHANGES_DEBOUNCE_MS,
  OPEN_ALL_CONFIRM,
  buildChangeRows,
  firstFile,
  orderedFiles,
  statusClass,
  statusLetter,
  statusWord,
  stepFile,
  summaryLine,
  totals,
} from './changesModel';
import type { ChangeRow } from './changesModel';
import { EntryIcon } from './icons';
import { getFilesApi } from './model';
import './tree.css';
import './find.css';
import './changes.css';

export interface ChangesViewProps {
  projectRoot: string;
  /** The left column shows this view; while hidden it does not refetch. */
  visible: boolean;
  /** Focuses the list whenever it changes (activity bar button, Ctrl+Shift+G). */
  focusNonce: number;
  /** Opens a file with its diff against HEAD. */
  onOpenFile(file: ChangedFile): void;
  /** Esc: back to the project tree. */
  onClose(): void;
}

function Counts({ file }: { file: ChangedFile }): ReactElement | null {
  if (file.binary) return <span className="ch-counts ch-binary">binary</span>;
  if (file.added === null && file.deleted === null) return null;
  return (
    <span className="ch-counts">
      {file.added !== null && file.added > 0 && <span className="ch-add">+{file.added}</span>}
      {file.deleted !== null && file.deleted > 0 && <span className="ch-del">-{file.deleted}</span>}
    </span>
  );
}

/** Changes: the third mode of the left column, every file that differs from HEAD (Ctrl+Shift+G). */
export function ChangesView({ projectRoot, visible, focusNonce, onOpenFile, onClose }: ChangesViewProps): ReactElement {
  const [result, setResult] = useState<ChangesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [stale, setStale] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  const refresh = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    setStale(false);
    getFilesApi()
      .changes(projectRoot)
      .then(
        (next) => {
          if (id === requestId.current) setResult(next);
        },
        () => {
          if (id === requestId.current) setResult({ git: true, files: [] });
        },
      )
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [projectRoot]);

  // Any git status recompute (the watcher saw a working tree or index change) makes the list stale.
  useEffect(
    () =>
      getFilesApi().onGitStatus((event) => {
        if (event.root === projectRoot) setStale(true);
      }),
    [projectRoot],
  );

  // A stale list is refetched while shown, debounced so a burst of writes costs one run.
  useEffect(() => {
    if (!visible || !stale) return;
    const timer = window.setTimeout(refresh, result === null ? 0 : CHANGES_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [visible, stale, refresh, result]);

  useEffect(() => {
    if (focusNonce === 0) return;
    // The panel may have just been unhidden; focus once it is laid out.
    const frame = window.requestAnimationFrame(() => listRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusNonce]);

  const files = useMemo(() => result?.files ?? [], [result]);
  const rows = useMemo(() => buildChangeRows(files), [files]);
  const sum = useMemo(() => totals(files), [files]);

  const keyed = rows.findIndex((r) => r.key === activeKey);
  const active = keyed >= 0 ? keyed : firstFile(rows);

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const open = (row: ChangeRow | undefined): void => {
    if (row?.kind === 'file') onOpenFile(row.file);
  };

  const openAll = (): void => {
    const list = orderedFiles(rows);
    if (list.length > OPEN_ALL_CONFIRM && !window.confirm(`Open ${list.length} diff tabs?`)) return;
    for (const file of list) onOpenFile(file);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActiveKey(rows[stepFile(rows, active, 1)]?.key ?? null);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveKey(rows[stepFile(rows, active, -1)]?.key ?? null);
        break;
      case 'Enter':
        if ((event.target as HTMLElement).tagName === 'BUTTON') return;
        event.preventDefault();
        open(rows[active]);
        break;
    }
  };

  const notGit = result !== null && !result.git;

  return (
    <div className="ft-root ch-root" onKeyDown={onKeyDown}>
      <div className="ft-header">
        <span className="ft-title">Changes</span>
        <button
          type="button"
          className="ft-btn"
          title="Open all diffs"
          aria-label="Open all diffs"
          disabled={files.length === 0}
          onClick={openAll}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="1.5" y="3.5" width="8" height="9" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4.5 1.5h7a1 1 0 0 1 1 1v8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M5.5 6v4M3.5 8h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="ft-btn" title="Refresh" aria-label="Refresh" disabled={notGit} onClick={refresh}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className={loading ? 'ch-spin' : undefined}>
            <path
              d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2M11.5 1.8v2.4H9.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {!notGit && result !== null && (
        <div className="ch-summary" role="status">
          <span>{summaryLine(sum)} against HEAD</span>
          {sum.added > 0 && <span className="ch-add">+{sum.added.toLocaleString('en-US')}</span>}
          {sum.deleted > 0 && <span className="ch-del">-{sum.deleted.toLocaleString('en-US')}</span>}
        </div>
      )}
      <div
        ref={listRef}
        className="ff-list ch-list"
        role="listbox"
        aria-label="Changed files"
        tabIndex={0}
      >
        {notGit && (
          <div className="ch-empty">
            <strong>Not a git repository</strong>
            <span>Changes lists what differs from the last commit. Run git init in the terminal to start tracking this project.</span>
          </div>
        )}
        {!notGit && result !== null && files.length === 0 && (
          <div className="ch-empty">
            <strong>Nothing changed</strong>
            <span>The working tree matches HEAD.</span>
          </div>
        )}
        {rows.map((row, i) =>
          row.kind === 'dir' ? (
            <div key={row.key} className="ch-dir" title={row.dir || projectRoot}>
              <EntryIcon name={row.dir} dir open={false} />
              <span className="ch-dir-name">{row.dir || 'Project root'}</span>
              <span className="ff-count">{row.count}</span>
            </div>
          ) : (
            <div
              key={row.key}
              data-row={i}
              role="option"
              aria-selected={i === active}
              className={`ch-file ${statusClass(row.file.status)}${i === active ? ' active' : ''}`}
              title={row.file.origPath ? `${row.file.origPath} → ${row.file.path}` : row.file.path}
              onMouseDown={() => setActiveKey(row.key)}
              onClick={() => open(row)}
            >
              <EntryIcon name={row.name} dir={false} open={false} />
              <span className="ch-name">{row.name}</span>
              {row.file.origPath && <span className="ch-orig">from {row.file.origPath}</span>}
              <Counts file={row.file} />
              <span className="ch-letter" title={statusWord(row.file.status)}>
                {statusLetter(row.file.status)}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
