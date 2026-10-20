import { useEffect, useState } from 'react';
import { GATE_LABELS, GATE_TARGETS } from '@shared/app';
import type { TerminalTab } from './types';

interface TabStripProps {
  tabs: readonly TerminalTab[];
  activeId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
  /** The user finished renaming a tab; `value` is the raw input. */
  onRename(id: string, value: string): void;
  /** Renaming was cancelled with Escape. */
  onRenameCancel(): void;
  /** Hides the action buttons (the host renders its own). */
  hideActions: boolean;
  /** Hides only the Gate menu. */
  hideGate: boolean;
  composerOpen: boolean;
  onNewShell(): void;
  onNewClaude(): void;
  onRunGate(target: string): void;
  onToggleComposer(): void;
  /** Dock column this strip belongs to (0 left, 1 right). */
  column: 0 | 1;
  /** The dock shows two columns. */
  split: boolean;
  /** This column receives keyboard commands; only drawn when the dock is split. */
  focused: boolean;
  /** Shows the Composer toggle (only one strip carries it). */
  showComposer: boolean;
  /** "Move to Other Side" is possible (there is another tab to keep a column). */
  canMove: boolean;
  onMove(id: string): void;
  /** Opens a shell in a new right column. */
  onSplit(): void;
  /** A click on the strip background: the column takes focus. */
  onFocusColumn(): void;
}

interface ContextMenu {
  id: string;
  x: number;
  y: number;
}

function TabDot({ tab }: { tab: TerminalTab }) {
  if (tab.gate?.state === 'running' && !tab.exited) return <span className="tp-dot busy" />;
  if (tab.claudeStatus === 'busy') return <span className="tp-dot busy" />;
  if (tab.claudeStatus === 'waiting') return <span className="tp-dot waiting" role="img" aria-label="Claude is waiting" />;
  if (tab.claudeStatus === 'idle') return <span className="tp-dot idle" />;
  if (tab.indicator?.color) return <span className="tp-dot" style={{ background: tab.indicator.color }} />;
  return null;
}

/** The terminal toolbar: tabs (rename on double click, middle click closes) and the action buttons. */
export function TabStrip({
  tabs,
  activeId,
  onActivate,
  onClose,
  onRename,
  onRenameCancel,
  hideActions,
  hideGate,
  composerOpen,
  onNewShell,
  onNewClaude,
  onRunGate,
  onToggleComposer,
  column,
  split,
  focused,
  showComposer,
  canMove,
  onMove,
  onSplit,
  onFocusColumn,
}: TabStripProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [gateMenuOpen, setGateMenuOpen] = useState(false);
  const [menu, setMenu] = useState<ContextMenu | null>(null);

  // The tab context menu closes on any outside press, on Escape and when the window loses focus.
  useEffect(() => {
    if (!menu) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu]);

  const runMenu = (action: (id: string) => void): void => {
    if (!menu) return;
    const { id } = menu;
    setMenu(null);
    action(id);
  };

  const className = `tp-toolbar${split ? (focused ? ' focused' : ' unfocused') : ''}${split && column === 0 ? ' left' : ''}`;

  return (
    <div
      className={className}
      data-column={column}
      style={{ gridColumn: column === 1 ? 3 : 1 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget || (event.target as Element).classList.contains('tp-tabs')) onFocusColumn();
      }}
    >
      <div className="tp-tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className={`tp-tab${tab.id === activeId ? ' active' : ''}${tab.exited ? ' exited' : ''}${tab.claudeStatus === 'waiting' ? ' waiting' : ''}`}
            title={tab.waitingFor ?? tab.indicator?.text ?? tab.oscTitle ?? tab.title}
            onClick={() => onActivate(tab.id)}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            onDoubleClick={() => setRenamingId(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ id: tab.id, x: event.clientX, y: event.clientY });
            }}
          >
            <TabDot tab={tab} />
            {renamingId === tab.id ? (
              <input
                className="tp-rename"
                defaultValue={tab.title}
                autoFocus
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onBlur={(event) => {
                  setRenamingId(null);
                  onRename(tab.id, event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') event.currentTarget.blur();
                  else if (event.key === 'Escape') {
                    setRenamingId(null);
                    onRenameCancel();
                  }
                }}
              />
            ) : (
              <span className="tp-tab-title">
                {tab.title}
                {tab.gate?.state === 'passed' && <span className="tp-gate-ok"> ✓</span>}
                {tab.gate?.state === 'failed' && <span className="tp-gate-fail"> ✗</span>}
              </span>
            )}
            <button
              type="button"
              className="tp-tab-close"
              title="Close tab"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {!hideActions && (
        <div className="tp-actions">
          <button type="button" className="tp-btn" title="New shell (Cmd+T)" onClick={onNewShell}>
            + Shell
          </button>
          <button type="button" className="tp-btn" title="New Claude tab (Ctrl+Esc)" onClick={onNewClaude}>
            + Claude
          </button>
          {!split && (
            <button type="button" className="tp-btn tp-split-btn" title={'Split right (Cmd+\\)'} aria-label="Split right" onClick={onSplit}>
              <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
                <rect x="0.5" y="0.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
                <line x1="7" y1="1" x2="7" y2="11" stroke="currentColor" />
              </svg>
            </button>
          )}
          {!hideGate && (
            <div className="tp-menu-anchor">
              <button
                type="button"
                className="tp-btn"
                title="Run a gate in a new tab"
                aria-haspopup="menu"
                aria-expanded={gateMenuOpen}
                onClick={() => setGateMenuOpen((open) => !open)}
                onBlur={() => setTimeout(() => setGateMenuOpen(false), 120)}
              >
                Gate ▾
              </button>
              {gateMenuOpen && (
                <div className="tp-menu" role="menu">
                  {GATE_TARGETS.map((target) => (
                    <button
                      key={target}
                      type="button"
                      role="menuitem"
                      className="tp-menu-item"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setGateMenuOpen(false);
                        onRunGate(target);
                      }}
                    >
                      {GATE_LABELS[target]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {showComposer && (
            <button
              type="button"
              className={composerOpen ? 'tp-btn on' : 'tp-btn'}
              title="Composer (Cmd+Shift+Enter)"
              onClick={onToggleComposer}
            >
              Composer
            </button>
          )}
        </div>
      )}
      {menu && (
        <div
          className="tp-menu tp-context"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="tp-menu-item"
            disabled={!canMove}
            onClick={() => runMenu(onMove)}
          >
            Move to Other Side
          </button>
          <button type="button" role="menuitem" className="tp-menu-item" onClick={() => runMenu(setRenamingId)}>
            Rename
          </button>
          <button type="button" role="menuitem" className="tp-menu-item" onClick={() => runMenu(onClose)}>
            Close Tab
          </button>
        </div>
      )}
    </div>
  );
}
