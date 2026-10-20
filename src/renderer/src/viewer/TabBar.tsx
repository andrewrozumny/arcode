import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, WheelEvent } from 'react';
import { CloseIcon } from './Icons';
import type { GitKind } from './paths';

export interface TabItem {
  id: string;
  title: string;
  /** Muted folder hint shown when two tabs share a name. */
  hint: string;
  kind: 'file' | 'diff' | 'claude' | 'feed' | 'deleted';
  /** Pinned tabs have no close button and ignore middle-click. */
  pinned: boolean;
  dirty: boolean;
  git: GitKind | null;
}

interface Props {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  onCopyPath: (id: string) => void;
  onReveal: (id: string) => void;
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseAll,
  onCopyPath,
  onReveal,
}: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!activeId) return;
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId, tabs.length]);

  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (stripRef.current && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      stripRef.current.scrollLeft += event.deltaY;
    }
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.id) : undefined;
  const item = (label: string, action: () => void, disabled = false) => (
    <button
      type="button"
      className="v-menu-item"
      disabled={disabled}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => {
        setMenu(null);
        action();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="v-tabbar">
      <div className="v-tabs" ref={stripRef} onWheel={onWheel}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className={`v-tab${tab.id === activeId ? ' active' : ''}${tab.git ? ` git-${tab.git}` : ''}${
              tab.kind === 'diff' ? ' diff' : tab.kind === 'claude' ? ' claude' : tab.kind === 'feed' ? ' feed' : ''
            }`}
            title={tab.title}
            onMouseDown={(event: MouseEvent) => {
              if (event.button === 1) event.preventDefault();
            }}
            onClick={() => onSelect(tab.id)}
            onAuxClick={(event: MouseEvent) => {
              if (event.button === 1 && !tab.pinned) onClose(tab.id);
            }}
            onContextMenu={(event: MouseEvent) => {
              event.preventDefault();
              setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
            }}
          >
            <span className="v-tab-title">
              {tab.kind === 'diff' ? `Diff: ${tab.title}` : tab.kind === 'deleted' ? `Deleted: ${tab.title}` : tab.title}
            </span>
            {tab.hint && <span className="v-tab-hint">{tab.hint}</span>}
            {!tab.pinned && (
            <button
              type="button"
              className={`v-tab-close${tab.dirty ? ' dirty' : ''}`}
              aria-label="Close tab"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {tab.dirty ? <span className="v-dot" /> : null}
              <span className="v-x">
                <CloseIcon />
              </span>
            </button>
            )}
          </div>
        ))}
      </div>
      {menu && menuTab && (
        <div className="v-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          {item('Close', () => onClose(menu.id), menuTab.pinned)}
          {item('Close Others', () => onCloseOthers(menu.id), tabs.length < 2)}
          {item('Close All', onCloseAll)}
          {menuTab.kind === 'file' && <div className="v-menu-sep" />}
          {menuTab.kind === 'file' && item('Copy Path', () => onCopyPath(menu.id))}
          {menuTab.kind === 'file' && item('Reveal in Tree', () => onReveal(menu.id))}
        </div>
      )}
    </div>
  );
}
