import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { SearchResult } from '@shared/files';
import { getFilesApi, highlightSegments, joinPath, parseQuery, toRel } from './model';
import { recentResults, withRecentFirst } from './recentFiles';
import type { FileSearchMode } from './recentFiles';
import './tree.css';

export interface FileSearchProps {
  open: boolean;
  onClose(): void;
  projectRoot: string;
  /** Receives an absolute path and, when the query had a `:line` suffix, the 1-based line. */
  onOpenFile(path: string, line?: number): void;
  /** 'recent' lists only recently opened files (Cmd+Shift+E). Default 'files'. */
  mode?: FileSearchMode | undefined;
  /** Absolute path of the file in front; left out of the recent list so Enter goes back to the previous one. */
  currentPath?: string | undefined;
}

function Highlighted({ result, from, to }: { result: SearchResult; from: number; to: number }): ReactElement {
  return (
    <>
      {highlightSegments(result.path, result.ranges, from, to).map((seg, i) =>
        seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

export function FileSearch(props: FileSearchProps): ReactElement | null {
  // Mounting only while open gives every opening a fresh query and selection.
  return props.open ? <FileSearchPanel {...props} /> : null;
}

function FileSearchPanel({ onClose, projectRoot, onOpenFile, mode = 'files', currentPath }: FileSearchProps): ReactElement {
  const [input, setInput] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.acode.layout.getRecentFiles(projectRoot).then(
      (found) => {
        if (!cancelled) setRecent(found);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  const { query, line } = parseQuery(input);
  const currentRel = currentPath ? toRel(projectRoot, currentPath) : null;
  const shown =
    mode === 'recent'
      ? recentResults(recent, query, currentRel)
      : query.trim()
        ? results
        : withRecentFirst(recentResults(recent, '', currentRel), results);

  useEffect(() => {
    if (mode === 'recent') return;
    const id = ++requestId.current;
    getFilesApi()
      .search(projectRoot, query, 50)
      .then(
        (found) => {
          if (id !== requestId.current) return;
          setResults(found);
          setActive(0);
        },
        () => {
          if (id === requestId.current) setResults([]);
        },
      );
  }, [projectRoot, query, mode]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, results, recent]);

  const choose = (result: SearchResult | undefined): void => {
    if (!result) return;
    onClose();
    onOpenFile(joinPath(projectRoot, result.path), line);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
      case 'ArrowDown':
        event.preventDefault();
        setActive((a) => Math.min(shown.length - 1, a + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Enter':
        event.preventDefault();
        choose(shown[active]);
        break;
    }
  };

  return (
    <div className="fs-scrim" onMouseDown={onClose}>
      <div
        className="fs-panel"
        role="dialog"
        aria-label={mode === 'recent' ? 'Recent files' : 'Go to file'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="fs-input"
          placeholder={mode === 'recent' ? 'Recent files  (type to filter)' : 'Go to file  (add :line to jump)'}
          value={input}
          spellCheck={false}
          onChange={(e) => {
            setInput(e.target.value);
            if (mode === 'recent') setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div ref={listRef} className="fs-list" role="listbox">
          {shown.map((result, i) => {
            const split = result.path.lastIndexOf('/') + 1;
            return (
              <div
                key={result.path}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'fs-item active' : 'fs-item'}
                onMouseMove={() => setActive(i)}
                onClick={() => choose(result)}
              >
                <span className="fs-base">
                  <Highlighted result={result} from={split} to={result.path.length} />
                </span>
                {split > 0 && (
                  <span className="fs-dir">
                    <Highlighted result={result} from={0} to={split - 1} />
                  </span>
                )}
              </div>
            );
          })}
          {shown.length === 0 && (query || mode === 'recent') && (
            <div className="fs-empty">{mode === 'recent' && !query ? 'No recent files' : 'No matching files'}</div>
          )}
        </div>
      </div>
    </div>
  );
}
