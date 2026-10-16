import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import type { SearchResult } from '@shared/files';
import { getFilesApi, highlightSegments, joinPath, parseQuery } from './model';
import './tree.css';

export interface FileSearchProps {
  open: boolean;
  onClose(): void;
  projectRoot: string;
  /** Receives an absolute path and, when the query had a `:line` suffix, the 1-based line. */
  onOpenFile(path: string, line?: number): void;
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

function FileSearchPanel({ onClose, projectRoot, onOpenFile }: FileSearchProps): ReactElement {
  const [input, setInput] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const { query, line } = parseQuery(input);

  useEffect(() => {
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
  }, [projectRoot, query]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

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
        setActive((a) => Math.min(results.length - 1, a + 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Enter':
        event.preventDefault();
        choose(results[active]);
        break;
    }
  };

  return (
    <div className="fs-scrim" onMouseDown={onClose}>
      <div className="fs-panel" role="dialog" aria-label="Go to file" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="fs-input"
          placeholder="Go to file  (add :line to jump)"
          value={input}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div ref={listRef} className="fs-list" role="listbox">
          {results.map((result, i) => {
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
          {results.length === 0 && query && <div className="fs-empty">No matching files</div>}
        </div>
      </div>
    </div>
  );
}
