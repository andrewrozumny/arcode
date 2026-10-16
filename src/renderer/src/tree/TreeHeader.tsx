import type { ReactElement } from 'react';
import { baseName } from './model';

interface TreeHeaderProps {
  projectRoot: string;
  /** False while no file is open in the viewer. */
  canReveal: boolean;
  onReveal(): void;
  onCollapseAll(): void;
}

/** Project name and the "Select opened file" and "Collapse all" buttons above the tree. */
export function TreeHeader({ projectRoot, canReveal, onReveal, onCollapseAll }: TreeHeaderProps): ReactElement {
  return (
      <div className="ft-header">
        <span className="ft-title" title={projectRoot}>
          {baseName(projectRoot)}
        </span>
        <button
          type="button"
          className="ft-btn"
          title="Select opened file"
          disabled={!canReveal}
          onClick={onReveal}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7 1v3M7 10v3M1 7h3M10 7h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="ft-btn" title="Collapse all" onClick={onCollapseAll}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 5.5 7 2l4 3.5M3 8.5 7 12l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
  );
}
