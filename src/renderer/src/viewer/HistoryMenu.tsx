import type { SnapshotInfo } from '@shared/viewer';
import { useEffect, useRef, useState } from 'react';
import { formatAge, formatDayTime, formatSize } from '../format';
import { viewerApi } from './api';
import { HistoryIcon } from './Icons';

interface Props {
  root: string;
  path: string;
  /** The snapshot shown in the diff right now, highlighted in the list. */
  selected: string | null;
  onPick: (snapshot: SnapshotInfo) => void;
}

export const sourceLabel = (snapshot: SnapshotInfo): string =>
  snapshot.source === 'external' ? 'changed outside' : 'before save';

export const snapshotAge = (snapshot: SnapshotInfo, now = Date.now()): string =>
  formatAge(new Date(snapshot.timestamp).toISOString(), now);

/** "History" button of the file header: lists the file's local history snapshots, newest first. */
export function HistoryMenu({ root, path, selected, onPick }: Props) {
  const [items, setItems] = useState<SnapshotInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** When the list was loaded; relative times are shown against it. */
  const [loadedAt, setLoadedAt] = useState(0);
  const boxRef = useRef<HTMLSpanElement>(null);
  const open = items !== null || error !== null;

  useEffect(() => {
    if (!open) return;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !boxRef.current?.contains(event.target as Node)) {
        setItems(null);
        setError(null);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);

  const toggle = async (): Promise<void> => {
    if (open) {
      setItems(null);
      setError(null);
      return;
    }
    try {
      const list = await viewerApi().listSnapshots(root, path);
      setLoadedAt(Date.now());
      setItems(list);
    } catch {
      setError('Local history is not available');
    }
  };

  return (
    <span className="v-history" ref={boxRef}>
      <button
        type="button"
        className={open || selected ? 'v-btn on' : 'v-btn'}
        title="Local history: versions kept before saves and outside changes"
        onClick={() => void toggle()}
      >
        <HistoryIcon /> History
      </button>
      {open && (
        <div className="v-menu v-history-menu" role="menu">
          {error && <div className="v-history-empty">{error}</div>}
          {items && items.length === 0 && (
            <div className="v-history-empty">No local history yet. Versions are kept before saves and when the file changes outside ARcode.</div>
          )}
          {items?.map((snapshot) => (
            <button
              key={snapshot.id}
              type="button"
              role="menuitem"
              className={snapshot.id === selected ? 'v-menu-item v-history-item on' : 'v-menu-item v-history-item'}
              title={formatDayTime(snapshot.timestamp)}
              onClick={() => {
                setItems(null);
                onPick(snapshot);
              }}
            >
              <span className="v-history-age">{snapshotAge(snapshot, loadedAt)}</span>
              <span className="v-history-meta">
                {sourceLabel(snapshot)} · {formatSize(snapshot.size)}
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
