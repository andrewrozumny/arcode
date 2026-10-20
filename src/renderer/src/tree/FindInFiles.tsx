import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import type { GrepMatch, GrepResult, SearchRange } from '@shared/files';
import { Chevron, EntryIcon } from './icons';
import { FIND_DEBOUNCE_MS, buildRows, firstMatch, splitPath, stepMatch, summary } from './findModel';
import type { FindRow } from './findModel';
import { getFilesApi, highlightSegments, joinPath } from './model';
import './tree.css';
import './find.css';

export interface FindFocusRequest {
  /** Changes on every request so the same query can be focused twice. */
  nonce: number;
  /** Replaces the query when set (the editor selection). */
  prefill: string | null;
}

export interface FindInFilesProps {
  projectRoot: string;
  /** Focuses the query field whenever `nonce` changes. */
  focusRequest: FindFocusRequest;
  /** Absolute path, 1-based line and column. */
  onOpenMatch(path: string, line: number, column: number): void;
  /** Esc: back to the project tree. */
  onClose(): void;
}

function Highlight({ text, ranges }: { text: string; ranges: readonly SearchRange[] }): ReactElement {
  return (
    <>
      {highlightSegments(text, ranges, 0, text.length).map((seg, i) =>
        seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

function Toggle({ label, title, on, onToggle }: { label: ReactNode; title: string; on: boolean; onToggle(): void }): ReactElement {
  return (
    <button
      type="button"
      className={on ? 'ff-toggle on' : 'ff-toggle'}
      title={title}
      aria-label={title}
      aria-pressed={on}
      // Keep focus in the query field while toggling.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

/** Find in files: the search mode of the left column (Cmd+Shift+F). */
export function FindInFiles({ projectRoot, focusRequest, onOpenMatch, onClose }: FindInFilesProps): ReactElement {
  const [query, setQuery] = useState('');
  const [include, setInclude] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  /** The latest answer and the query it belongs to; a different current query means a search is running. */
  const [answer, setAnswer] = useState<{ key: string; result: GrepResult } | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [seenNonce, setSeenNonce] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  // A focus request carrying the editor selection replaces the query (adjusted during render).
  if (focusRequest.nonce !== seenNonce) {
    setSeenNonce(focusRequest.nonce);
    if (focusRequest.prefill !== null) setQuery(focusRequest.prefill);
  }

  const queryKey = JSON.stringify([query, include, caseSensitive, wholeWord, regex]);
  const result = query === '' ? null : (answer?.result ?? null);
  const searching = query !== '' && answer?.key !== queryKey;

  useEffect(() => {
    if (focusRequest.nonce === 0) return;
    const input = inputRef.current;
    if (!input) return;
    // The panel may have just been unhidden; focus once it is laid out.
    const frame = window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  // Live search, debounced. Stale and cancelled answers are dropped.
  useEffect(() => {
    const id = ++requestId.current;
    if (query === '') return;
    const key = JSON.stringify([query, include, caseSensitive, wholeWord, regex]);
    const timer = window.setTimeout(() => {
      const settle = (found: GrepResult): void => {
        if (id !== requestId.current || found.cancelled) return;
        setAnswer({ key, result: found });
        setCollapsed(new Set());
        setActiveKey(null);
      };
      getFilesApi()
        .grep(projectRoot, { query, include, caseSensitive, wholeWord, regex })
        .then(settle, (error: unknown) =>
          settle({
            files: [],
            totalLines: 0,
            totalCount: 0,
            truncated: false,
            timedOut: false,
            cancelled: false,
            engine: 'node',
            error: error instanceof Error ? error.message : 'Search failed',
          }),
        );
    }, FIND_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [projectRoot, query, include, caseSensitive, wholeWord, regex]);

  const rows = useMemo(() => buildRows(result?.files ?? [], collapsed), [result, collapsed]);

  // Tracked by key so collapsing a file does not move the selection; a hidden or stale key falls back to the first match.
  const keyed = rows.findIndex((r) => r.key === activeKey);
  const active = keyed >= 0 ? keyed : firstMatch(rows);
  const step = (delta: 1 | -1): void => setActiveKey(rows[stepMatch(rows, active, delta)]?.key ?? null);

  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const open = useCallback(
    (row: FindRow | undefined) => {
      if (!row || row.kind !== 'match') return;
      onOpenMatch(joinPath(projectRoot, row.file.path), row.match.line, row.match.column);
    },
    [onOpenMatch, projectRoot],
  );

  const toggleFile = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
        step(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        break;
      case 'Enter':
        if ((event.target as HTMLElement).tagName === 'BUTTON') return;
        event.preventDefault();
        open(rows[active]);
        break;
    }
  };

  const status = summary(result, searching);

  return (
    <div className="ft-root ff-root" onKeyDown={onKeyDown}>
      <div className="ft-header">
        <span className="ft-title">Find in Files</span>
      </div>
      <div className="ff-form">
        <div className="ff-field">
          <input
            ref={inputRef}
            className="ff-input"
            placeholder="Search"
            aria-label="Search text"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Toggle label="Aa" title="Match case" on={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} />
          <Toggle label="W" title="Words" on={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
          <Toggle label=".*" title="Regex" on={regex} onToggle={() => setRegex((v) => !v)} />
        </div>
        <div className="ff-field">
          <input
            className="ff-input ff-include"
            placeholder="File mask, e.g. *.ts, !*.test.ts"
            aria-label="File mask"
            value={include}
            spellCheck={false}
            onChange={(e) => setInclude(e.target.value)}
          />
        </div>
        <div className={result?.error ? 'ff-status error' : 'ff-status'} role="status">
          {status}
        </div>
      </div>
      <div ref={listRef} className="ff-list" role="listbox" aria-label="Matches">
        {rows.map((row, i) =>
          row.kind === 'file' ? (
            <FileRow key={row.key} row={row} onToggle={() => toggleFile(row.file.path)} />
          ) : (
            <MatchRow
              key={row.key}
              index={i}
              match={row.match}
              active={i === active}
              onSelect={() => setActiveKey(row.key)}
              onOpen={() => open(row)}
            />
          ),
        )}
      </div>
    </div>
  );
}

function FileRow({ row, onToggle }: { row: Extract<FindRow, { kind: 'file' }>; onToggle(): void }): ReactElement {
  const { name, dir } = splitPath(row.file.path);
  return (
    <div className="ff-file" title={row.file.path} onClick={onToggle}>
      <span className="ft-twist">
        <Chevron open={!row.collapsed} />
      </span>
      <EntryIcon name={name} dir={false} open={false} />
      <span className="ff-file-name">{name}</span>
      {dir && <span className="ff-file-dir">{dir}</span>}
      <span className="ff-count">{row.file.count}</span>
    </div>
  );
}

function MatchRow({
  index,
  match,
  active,
  onSelect,
  onOpen,
}: {
  index: number;
  match: GrepMatch;
  active: boolean;
  onSelect(): void;
  onOpen(): void;
}): ReactElement {
  return (
    <div
      data-row={index}
      role="option"
      aria-selected={active}
      className={active ? 'ff-match active' : 'ff-match'}
      onMouseDown={onSelect}
      onClick={onOpen}
    >
      <span className="ff-line">{match.line}</span>
      <span className="ff-text">
        <Highlight text={match.text} ranges={match.ranges} />
      </span>
    </div>
  );
}
