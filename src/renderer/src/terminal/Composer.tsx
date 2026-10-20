import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { terminalApi } from './api';
import { loadHistory, pushHistory, saveHistory, searchHistory } from './history';

const MAX_ROWS = 10;

interface Props {
  /** History is kept per project. */
  projectRoot: string;
  /** Receives the composed text; the pane pastes it into the active terminal and presses Enter. */
  onSend: (text: string) => void;
  /** Esc: hand focus back to the terminal. */
  onEscape: () => void;
  autoFocus?: boolean;
}

/**
 * Multi-line prompt editor shown above the terminal. Cmd+Enter sends, Shift+Enter inserts a newline,
 * Up/Down step through this project's history, Ctrl+R searches it.
 */
export function Composer({ projectRoot, onSend, onEscape, autoFocus }: Props) {
  const [value, setValue] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>(loadHistory(projectRoot));
  const cursor = useRef<number | null>(null);
  // Ctrl+R search: the query is the text typed while the list is open.
  const [search, setSearch] = useState<{ query: string; index: number; entries: string[] } | null>(null);
  const matches = search ? searchHistory(search.entries, search.query) : [];

  useEffect(() => {
    history.current = loadHistory(projectRoot);
  }, [projectRoot]);

  useEffect(() => {
    if (autoFocus) areaRef.current?.focus();
  }, [autoFocus]);

  // Grow with the content up to MAX_ROWS lines, then scroll.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    const lineHeight = Number.parseFloat(getComputedStyle(area).lineHeight) || 18;
    const limit = lineHeight * MAX_ROWS;
    area.style.height = `${Math.min(area.scrollHeight, limit)}px`;
    area.style.overflowY = area.scrollHeight > limit ? 'auto' : 'hidden';
  }, [value]);

  const insert = useCallback((text: string) => {
    const area = areaRef.current;
    if (!area) return;
    area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
    setValue(area.value);
    cursor.current = null;
  }, []);

  const send = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    history.current = pushHistory(history.current, text);
    saveHistory(projectRoot, history.current);
    cursor.current = null;
    setValue('');
    onSend(text);
  }, [onSend, projectRoot, value]);

  const pick = (entry: string | undefined): void => {
    setSearch(null);
    if (entry === undefined) return;
    cursor.current = null;
    setValue(entry);
    requestAnimationFrame(() => {
      const area = areaRef.current;
      area?.focus();
      area?.setSelectionRange(entry.length, entry.length);
    });
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!search) return;
    const move = (delta: number): void =>
      setSearch({ ...search, index: Math.max(0, Math.min(matches.length - 1, search.index + delta)) });
    if (event.key === 'ArrowDown' || (event.key === 'r' && event.ctrlKey)) {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(matches[search.index]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      pick(undefined);
      areaRef.current?.focus();
    }
  };

  const step = (direction: -1 | 1): void => {
    const entries = history.current;
    if (entries.length === 0) return;
    let next: number | null;
    if (cursor.current === null) {
      if (direction === 1) return;
      next = entries.length - 1;
    } else {
      next = cursor.current + direction;
      if (next >= entries.length) next = null;
      if (next !== null && next < 0) next = 0;
    }
    cursor.current = next;
    setValue(next === null ? '' : (entries[next] ?? ''));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'r' && event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      setSearch({ query: value.trim(), index: 0, entries: history.current });
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    } else if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      (value === '' || cursor.current !== null)
    ) {
      event.preventDefault();
      step(event.key === 'ArrowUp' ? -1 : 1);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const image = [...event.clipboardData.files].find((file) => file.type.startsWith('image/'));
    if (!image) return;
    event.preventDefault();
    void image
      .arrayBuffer()
      .then((buffer) => terminalApi().savePastedImage(new Uint8Array(buffer), image.type))
      .then((path) => insert(path))
      .catch((error: unknown) => console.warn('Could not store pasted image', error));
  };

  const onDrop = (event: DragEvent<HTMLTextAreaElement>): void => {
    const files = [...event.dataTransfer.files];
    if (files.length === 0) return;
    event.preventDefault();
    const paths = files.map((file) => terminalApi().pathForFile(file)).filter((path) => path.length > 0);
    if (paths.length > 0) insert(paths.map((path) => `"${path.replace(/"/g, '\\"')}"`).join(' ') + ' ');
  };

  return (
    <div className="tp-composer">
      {search && (
        <div className="tp-history" role="dialog" aria-label="Prompt history">
          <input
            className="tp-history-input"
            autoFocus
            value={search.query}
            placeholder="Search this project's prompts"
            spellCheck={false}
            onChange={(event) => setSearch({ ...search, query: event.target.value, index: 0 })}
            onKeyDown={onSearchKey}
            onBlur={() => setSearch(null)}
          />
          <ul className="tp-history-list" role="listbox">
            {matches.length === 0 && <li className="tp-history-empty">No prompts match</li>}
            {matches.map((entry, i) => (
              <li
                key={entry}
                role="option"
                aria-selected={i === search.index}
                className={`tp-history-item${i === search.index ? ' active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(entry);
                }}
              >
                {entry}
              </li>
            ))}
          </ul>
        </div>
      )}
      <textarea
        ref={areaRef}
        className="tp-composer-input"
        value={value}
        rows={2}
        spellCheck={false}
        placeholder="Write a prompt. Cmd+Enter sends, Shift+Enter adds a line, Ctrl+R searches history."
        onChange={(event) => {
          cursor.current = null;
          setValue(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={onDrop}
      />
      <button type="button" className="tp-btn tp-composer-send" onClick={send} disabled={value.trim() === ''}>
        Send
      </button>
    </div>
  );
}
