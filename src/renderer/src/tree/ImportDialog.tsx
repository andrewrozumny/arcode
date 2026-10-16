import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { ExternalEntry, ExternalPlace, ExternalPreview } from '@shared/files';
import { formatDayTime, formatSizeShort } from '../format';
import { DEFAULT_EXTERNAL_SORT, getFilesApi, nextExternalSort, sortExternalEntries } from './model';
import type { ExternalSort, ExternalSortKey } from './model';

interface Props {
  projectRoot: string;
  /** Project-relative folder the files are copied into ('' for the project root). */
  targetRel: string;
  /** Shown in the title, e.g. "incoming" or the project name. */
  targetLabel: string;
  onClose(): void;
  /** Called after a successful import with the created project-relative paths. */
  onImported?(created: string[]): void;
}

const SORT_KEY = 'acode.import.sort';
const COLUMNS: { key: ExternalSortKey; label: string; className: string }[] = [
  { key: 'name', label: 'Name', className: 'ft-import-name' },
  { key: 'size', label: 'Size', className: 'ft-import-size' },
  { key: 'date', label: 'Modified', className: 'ft-import-date' },
];
const PREVIEW_DEBOUNCE_MS = 150;

function readSort(): ExternalSort {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      const { key, dir } = parsed as Partial<ExternalSort>;
      if ((key === 'name' || key === 'date' || key === 'size') && (dir === 'asc' || dir === 'desc')) return { key, dir };
    }
  } catch {
    // storage unavailable or corrupt: use the default
  }
  return DEFAULT_EXTERNAL_SORT;
}

function writeSort(sort: ExternalSort): void {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sort));
  } catch {
    // not remembered, nothing else to do
  }
}

/** Parent folder, or null when `path` is `root` or lies outside it. */
function parentWithin(path: string, root: string): string | null {
  if (path === root || !path.startsWith(root + '/')) return null;
  const parent = path.slice(0, path.lastIndexOf('/'));
  return parent.length >= root.length ? parent : null;
}

/**
 * Picks files from the Mac (Downloads, Recent, Screenshots, or any folder under home) and copies
 * them into a project folder. Selection survives navigation, so files from several places can be mixed.
 */
export function ImportDialog({ projectRoot, targetRel, targetLabel, onClose, onImported }: Props): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [places, setPlaces] = useState<ExternalPlace[]>([]);
  const [placeId, setPlaceId] = useState<ExternalPlace['id'] | null>(null);
  // Folder entered inside the current place (via double-click or Back); null shows the place itself.
  const [folder, setFolder] = useState<string | null>(null);
  const [entries, setEntries] = useState<ExternalEntry[]>([]);
  const [sort, setSort] = useState<ExternalSort>(readSort);
  // Starts true: the first list loads as soon as the places arrive.
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Map<string, ExternalEntry>>(new Map());
  // Row the preview follows: the last row clicked or reached with the arrow keys.
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const place = places.find((p) => p.id === placeId) ?? null;
  // Recent has no folder (null); other places show the folder entered, or their own folder.
  const currentPath = place && place.path !== null ? (folder ?? place.path) : null;
  const parentPath = place && currentPath !== null ? parentWithin(currentPath, place.root) : null;
  const sorted = useMemo(() => sortExternalEntries(entries, sort), [entries, sort]);
  const focused = sorted.find((e) => e.path === focusedPath) ?? null;

  // Keyboard goes to the dialog itself, so Escape and the arrows work without clicking into it first.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Escape closes even when focus wandered off (e.g. onto a button that was then disabled).
  useEffect(() => {
    const onDocKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onDocKey, true);
    return () => document.removeEventListener('keydown', onDocKey, true);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getFilesApi()
      .externalPlaces()
      .then((list) => {
        if (cancelled) return;
        setPlaces(list);
        setPlaceId(list[0]?.id ?? null);
      })
      .catch((err: unknown) => setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!place) return;
    let cancelled = false;
    getFilesApi()
      .externalList(currentPath)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `place` is derived from placeId and places; the list reloads when the folder changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeId, currentPath]);

  // Every navigation clears the list and shows "Loading…" until the effect above delivers the new one.
  const startLoading = (): void => {
    setLoading(true);
    setError(null);
    setEntries([]);
    setFocusedPath(null);
  };

  const choosePlace = (id: ExternalPlace['id']): void => {
    startLoading();
    setPlaceId(id);
    setFolder(null);
  };

  const enter = (entry: ExternalEntry): void => {
    if (entry.kind !== 'dir') return;
    startLoading();
    setFolder(entry.path);
  };

  // Up one folder, never above home; at a place's own folder this goes to its parent (e.g. Downloads -> home).
  const back = (): void => {
    if (parentPath === null) return;
    startLoading();
    setFolder(parentPath);
  };

  const chooseSort = (key: ExternalSortKey): void => {
    setSort((prev) => {
      const next = nextExternalSort(prev, key);
      writeSort(next);
      return next;
    });
  };

  const toggle = (entry: ExternalEntry): void => {
    if (entry.kind !== 'file') return;
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      return next;
    });
  };

  const clickRow = (entry: ExternalEntry): void => {
    setFocusedPath(entry.path);
    toggle(entry);
  };

  const moveFocus = (delta: number): void => {
    if (sorted.length === 0) return;
    const index = sorted.findIndex((e) => e.path === focusedPath);
    const next = index < 0 ? (delta > 0 ? 0 : sorted.length - 1) : Math.min(sorted.length - 1, Math.max(0, index + delta));
    const entry = sorted[next];
    if (!entry) return;
    setFocusedPath(entry.path);
    dialogRef.current?.querySelector(`[data-path="${CSS.escape(entry.path)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const importSelected = async (): Promise<void> => {
    if (busy || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const created = await getFilesApi().importFiles(projectRoot, targetRel, [...selected.keys()]);
      onImported?.(created);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === ' ' && focused) {
      event.preventDefault();
      toggle(focused);
    } else if (event.key === 'Enter' && !event.metaKey) {
      event.preventDefault();
      if (focused?.kind === 'dir') enter(focused);
      else void importSelected();
    } else if (event.key === 'Backspace' && !(event.target instanceof HTMLInputElement)) {
      event.preventDefault();
      back();
    }
  };

  const count = selected.size;

  return (
    <div className="ft-scrim" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="ft-dialog ft-import"
        role="dialog"
        aria-label="Import from Mac"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="ft-dialog-title">Import from Mac</div>
        <div className="ft-dialog-label">into {targetLabel}</div>

        <div className="ft-import-body">
          <div className="ft-import-places" role="list" aria-label="Quick places">
            {places.map((p) => (
              <button
                key={p.id}
                type="button"
                role="listitem"
                className={p.id === placeId ? 'ft-import-place active' : 'ft-import-place'}
                onClick={() => choosePlace(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="ft-import-main">
            <div className="ft-import-nav">
              <button
                type="button"
                className="ft-dialog-btn"
                disabled={parentPath === null}
                title={parentPath ?? 'Already at the top'}
                onClick={back}
              >
                Back
              </button>
              <span className="ft-import-path" title={currentPath ?? 'Recent'}>
                {currentPath ?? 'Recent'}
              </span>
            </div>

            <div className="ft-import-list" role="listbox" aria-multiselectable="true" aria-label="Files">
              <div className="ft-import-row ft-import-head" role="presentation">
                <span />
                {COLUMNS.map((col) => (
                  <button
                    key={col.key}
                    type="button"
                    className={`ft-import-col ${col.className}${sort.key === col.key ? ' active' : ''}`}
                    title={`Sort by ${col.label.toLowerCase()}`}
                    onClick={() => chooseSort(col.key)}
                  >
                    {col.label}
                    {sort.key === col.key && <span aria-hidden="true">{sort.dir === 'asc' ? ' ↑' : ' ↓'}</span>}
                  </button>
                ))}
              </div>
              {loading && <div className="ft-import-empty">Loading…</div>}
              {!loading && entries.length === 0 && <div className="ft-import-empty">Nothing here</div>}
              {sorted.map((entry) => {
                const isSelected = selected.has(entry.path);
                const isFocused = entry.path === focusedPath;
                return (
                  <div
                    key={entry.path}
                    role="option"
                    aria-selected={isSelected}
                    data-path={entry.path}
                    className={`ft-import-row${entry.kind === 'dir' ? ' dir' : ''}${isSelected ? ' selected' : ''}${isFocused ? ' focused' : ''}`}
                    onClick={() => clickRow(entry)}
                    onDoubleClick={() => enter(entry)}
                  >
                    <input
                      type="checkbox"
                      tabIndex={-1}
                      checked={isSelected}
                      disabled={entry.kind !== 'file'}
                      onChange={() => toggle(entry)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="ft-import-name" title={entry.path}>
                      {entry.kind === 'dir' ? `${entry.name}/` : entry.name}
                    </span>
                    <span className="ft-import-size">{entry.kind === 'file' ? formatSizeShort(entry.size) : ''}</span>
                    <span className="ft-import-date">{formatDayTime(entry.mtimeMs)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <PreviewPane entry={focused} />
        </div>

        {error && <div className="ft-dialog-error">{error}</div>}
        <div className="ft-dialog-actions">
          <span className="ft-import-count">
            {count > 0 ? `${count} selected` : 'Click files to select, double-click a folder to open it'}
          </span>
          <button type="button" className="ft-dialog-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ft-dialog-btn primary"
            disabled={busy || count === 0}
            onClick={() => void importSelected()}
          >
            {count > 0 ? `Import ${count}` : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

type PreviewState = { path: string; preview: ExternalPreview | null; error: string | null };

/** Right column: the focused entry as a picture, a text head, or a plain file card. */
function PreviewPane({ entry }: { entry: ExternalEntry | null }): ReactElement {
  const [state, setState] = useState<PreviewState | null>(null);
  // Keyed by path so a stale measurement never shows under another file.
  const [dims, setDims] = useState<{ path: string; w: number; h: number } | null>(null);

  useEffect(() => {
    if (!entry || entry.kind !== 'file') return;
    const path = entry.path;
    let cancelled = false;
    // Debounced so arrowing through a folder does not read every file on the way.
    const timer = setTimeout(() => {
      getFilesApi()
        .externalPreview(path)
        .then((preview) => {
          if (!cancelled) setState({ path, preview, error: null });
        })
        .catch((err: unknown) => {
          if (!cancelled) setState({ path, preview: null, error: err instanceof Error ? err.message : String(err) });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [entry]);

  if (!entry) {
    return (
      <div className="ft-import-preview">
        <div className="ft-import-empty">Select a file to preview it</div>
      </div>
    );
  }

  const facts = (
    <dl className="ft-import-facts">
      <div>
        <dt>Name</dt>
        <dd title={entry.path}>{entry.name}</dd>
      </div>
      {entry.kind === 'file' && (
        <div>
          <dt>Size</dt>
          <dd>{formatSizeShort(entry.size)}</dd>
        </div>
      )}
      <div>
        <dt>Modified</dt>
        <dd>{formatDayTime(entry.mtimeMs)}</dd>
      </div>
      {dims && dims.path === entry.path && (
        <div>
          <dt>Pixels</dt>
          <dd>
            {dims.w} × {dims.h}
          </dd>
        </div>
      )}
    </dl>
  );

  if (entry.kind === 'dir') {
    return (
      <div className="ft-import-preview">
        <div className="ft-import-preview-body">
          <div className="ft-import-card">
            <span className="ft-import-card-icon" aria-hidden="true">
              📁
            </span>
            <div className="ft-import-preview-note">Double-click to open</div>
          </div>
        </div>
        {facts}
      </div>
    );
  }

  const current = state && state.path === entry.path ? state : null;
  let body: ReactElement;
  if (!current) {
    body = <div className="ft-import-empty">Loading…</div>;
  } else if (current.error) {
    body = <div className="ft-import-preview-note">{current.error}</div>;
  } else if (current.preview?.kind === 'image') {
    body = (
      <img
        className="ft-import-preview-img"
        src={current.preview.dataUrl}
        alt=""
        draggable={false}
        onLoad={(e) => setDims({ path: entry.path, w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
    );
  } else if (current.preview?.kind === 'text') {
    body = (
      <pre className="ft-import-preview-text">
        {current.preview.text}
        {current.preview.truncated ? '\n…' : ''}
      </pre>
    );
  } else {
    body = (
      <div className="ft-import-card">
        <span className="ft-import-card-icon" aria-hidden="true">
          📄
        </span>
        <div className="ft-import-preview-note">
          {current.preview?.kind === 'none' ? current.preview.reason : 'No preview'}
        </div>
      </div>
    );
  }

  return (
    <div className="ft-import-preview">
      <div className="ft-import-preview-body">{body}</div>
      {facts}
    </div>
  );
}
