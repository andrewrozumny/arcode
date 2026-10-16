import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ISearchOptions } from '@xterm/addon-search';
import type { TerminalSession } from '../terminalSession';

const DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#3a4a5c',
  matchBorder: '#3a4a5c',
  matchOverviewRuler: '#56a8f5',
  activeMatchBackground: '#7a5d1f',
  activeMatchBorder: '#e5c07b',
  activeMatchColorOverviewRuler: '#e5c07b',
};

interface Props {
  session: TerminalSession;
  onClose: () => void;
}

/** Find-in-buffer overlay backed by xterm's search addon. */
export function SearchBar({ session, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const subscription = session.search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResult({ index: resultIndex, count: resultCount }),
    );
    return () => {
      subscription.dispose();
      session.search.clearDecorations();
    };
  }, [session]);

  const options = (): ISearchOptions => ({ caseSensitive, decorations: DECORATIONS });
  const next = (): void => {
    if (query) session.search.findNext(query, options());
  };
  const previous = (): void => {
    if (query) session.search.findPrevious(query, options());
  };

  useEffect(() => {
    if (query) session.search.findNext(query, { caseSensitive, decorations: DECORATIONS, incremental: true });
    else session.search.clearDecorations();
  }, [query, caseSensitive, session]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) previous();
      else next();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="tp-search" role="search">
      <input
        ref={inputRef}
        className="tp-search-input"
        value={query}
        placeholder="Find"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="tp-search-count">
        {query && result ? (result.count === 0 ? 'No results' : `${result.index + 1}/${result.count}`) : ''}
      </span>
      <button
        type="button"
        className={caseSensitive ? 'tp-btn tp-icon-btn on' : 'tp-btn tp-icon-btn'}
        title="Match case"
        onClick={() => setCaseSensitive((v) => !v)}
      >
        Aa
      </button>
      <button type="button" className="tp-btn tp-icon-btn" title="Previous (Shift+Enter)" onClick={previous}>
        ↑
      </button>
      <button type="button" className="tp-btn tp-icon-btn" title="Next (Enter)" onClick={next}>
        ↓
      </button>
      <button type="button" className="tp-btn tp-icon-btn" title="Close (Esc)" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
