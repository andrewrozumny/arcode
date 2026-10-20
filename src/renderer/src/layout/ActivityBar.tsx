import type { ReactElement, ReactNode } from 'react';
import type { LeftMode } from './Workspace';

interface Props {
  treeVisible: boolean;
  /** What the left column shows (while it is visible). */
  leftMode: LeftMode;
  terminalVisible: boolean;
  searchOpen: boolean;
  onToggleTree(): void;
  onToggleFind(): void;
  onToggleChanges(): void;
  onToggleTerminal(): void;
  onOpenSearch(): void;
  onOpenClaude(): void;
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const ICONS: Record<'tree' | 'search' | 'find' | 'changes' | 'claude' | 'terminal', ReactElement> = {
  tree: (
    <svg {...ICON_PROPS}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h9A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  ),
  search: (
    <svg {...ICON_PROPS}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  ),
  find: (
    <svg {...ICON_PROPS}>
      <path d="M4 5.5h10M4 10h5M4 14.5h4M4 19h8" />
      <circle cx="15.5" cy="13.5" r="3.8" />
      <path d="m18.3 16.3 2.7 2.7" />
    </svg>
  ),
  changes: (
    <svg {...ICON_PROPS}>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="8.5" r="2" />
      <path d="M6.5 7.5v9M17.5 10.5c0 4-4.5 3.5-9.6 6.6" />
    </svg>
  ),
  claude: (
    <svg {...ICON_PROPS}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.8 2.8M15.2 15.2 18 18M6 18l2.8-2.8M15.2 8.8 18 6" />
    </svg>
  ),
  terminal: (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7.5 9.5 3 2.5-3 2.5M13 15h4" />
    </svg>
  ),
};

function Button({
  label,
  shortcut,
  active,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      className={active ? 'activity-btn active' : 'activity-btn'}
      title={title}
      aria-label={label}
      aria-pressed={active ?? false}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Thin strip of panel toggles on the left edge of the project window. */
export function ActivityBar({
  treeVisible,
  leftMode,
  terminalVisible,
  searchOpen,
  onToggleTree,
  onToggleFind,
  onToggleChanges,
  onToggleTerminal,
  onOpenSearch,
  onOpenClaude,
}: Props) {
  return (
    <nav className="activity-bar" aria-label="Panels">
      <Button label="Project files" shortcut="⌘1" active={treeVisible && leftMode === 'tree'} onClick={onToggleTree}>
        {ICONS.tree}
      </Button>
      <Button label="Search files" shortcut="⌘P" active={searchOpen} onClick={onOpenSearch}>
        {ICONS.search}
      </Button>
      <Button label="Find in files" shortcut="⇧⌘F" active={treeVisible && leftMode === 'find'} onClick={onToggleFind}>
        {ICONS.find}
      </Button>
      <Button label="Changes" shortcut="⌃⇧G" active={treeVisible && leftMode === 'changes'} onClick={onToggleChanges}>
        {ICONS.changes}
      </Button>
      <Button label="Claude" onClick={onOpenClaude}>
        {ICONS.claude}
      </Button>
      <div className="activity-spacer" />
      <Button label="Terminal" shortcut="⌘2" active={terminalVisible} onClick={onToggleTerminal}>
        {ICONS.terminal}
      </Button>
    </nav>
  );
}
