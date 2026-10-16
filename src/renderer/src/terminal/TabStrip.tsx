import { useState } from 'react';
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
}

function TabDot({ tab }: { tab: TerminalTab }) {
  if (tab.gate?.state === 'running' && !tab.exited) return <span className="tp-dot busy" />;
  if (tab.claudeStatus === 'busy') return <span className="tp-dot busy" />;
  if (tab.claudeStatus === 'waiting') return <span className="tp-dot waiting" />;
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
}: TabStripProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [gateMenuOpen, setGateMenuOpen] = useState(false);

  return (
    <div className="tp-toolbar">
      <div className="tp-tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            className={`tp-tab${tab.id === activeId ? ' active' : ''}${tab.exited ? ' exited' : ''}`}
            title={tab.waitingFor ?? tab.indicator?.text ?? tab.oscTitle ?? tab.title}
            onClick={() => onActivate(tab.id)}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
            onDoubleClick={() => setRenamingId(tab.id)}
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
          <button
            type="button"
            className={composerOpen ? 'tp-btn on' : 'tp-btn'}
            title="Composer (Cmd+Shift+Enter)"
            onClick={onToggleComposer}
          >
            Composer
          </button>
        </div>
      )}
    </div>
  );
}
