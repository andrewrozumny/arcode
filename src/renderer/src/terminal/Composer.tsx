import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react';
import { terminalApi } from './api';
import { loadHistory, pushHistory, saveHistory } from './history';

const MAX_ROWS = 10;

interface Props {
  /** Receives the composed text; the pane pastes it into the active terminal and presses Enter. */
  onSend: (text: string) => void;
  /** Esc: hand focus back to the terminal. */
  onEscape: () => void;
  autoFocus?: boolean;
}

/** Multi-line prompt editor shown above the terminal. Cmd+Enter sends, Shift+Enter inserts a newline. */
export function Composer({ onSend, onEscape, autoFocus }: Props) {
  const [value, setValue] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>(loadHistory());
  const cursor = useRef<number | null>(null);

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
    saveHistory(history.current);
    cursor.current = null;
    setValue('');
    onSend(text);
  }, [onSend, value]);

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
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
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
      <textarea
        ref={areaRef}
        className="tp-composer-input"
        value={value}
        rows={2}
        spellCheck={false}
        placeholder="Write a prompt. Cmd+Enter sends, Shift+Enter adds a line."
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
