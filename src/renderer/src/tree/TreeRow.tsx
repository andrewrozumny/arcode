import type { DragEvent, MouseEvent, ReactElement } from 'react';
import type { GitStatusCode } from '@shared/files';
import { Chevron, EntryIcon } from './icons';
import type { Row } from './model';

interface TreeRowProps {
  row: Row;
  /** Pixel offset inside the virtualised list. */
  top: number;
  /** Git status of a file row; undefined for folders and clean files. */
  status: GitStatusCode | undefined;
  /** Folder that contains a changed file. */
  changedDir: boolean;
  selected: boolean;
  /** The file open in the viewer. */
  active: boolean;
  /** Highlighted while Finder files are dragged over the folder it stands for. */
  dropTarget: boolean;
  /** Click with its modifiers: Cmd toggles the row, Shift selects a range. */
  onSelect(event: MouseEvent): void;
  onOpen(event: MouseEvent): void;
  onToggle(): void;
  onContextMenu(event: MouseEvent): void;
  onDragStart(event: DragEvent<HTMLDivElement>): void;
  onDragOver(event: DragEvent<HTMLDivElement>): void;
  onDrop(event: DragEvent<HTMLDivElement>): void;
}

/** One absolutely positioned row of the file tree. */
export function TreeRow(props: TreeRowProps): ReactElement {
  const { row, status } = props;
  const classes = ['ft-row'];
  if (props.selected) classes.push('selected');
  if (props.active) classes.push('active');
  if (row.ignored || row.heavy) classes.push('muted');
  if (props.dropTarget) classes.push('drop-target');
  if (status) classes.push(`git-${status === '?' ? 'untracked' : status}`);
  else if (props.changedDir) classes.push('git-dir');
  return (
    <div
      role="treeitem"
      aria-expanded={row.kind === 'dir' ? row.expanded : undefined}
      aria-selected={props.selected}
      className={classes.join(' ')}
      style={{ top: props.top, paddingLeft: 6 + row.depth * 14 }}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
      onContextMenu={props.onContextMenu}
      draggable
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <span
        className={row.kind === 'dir' ? 'ft-twist clickable' : 'ft-twist'}
        onClick={(e) => {
          // The chevron alone expands or collapses; a plain row click only selects, like JetBrains IDEs.
          if (row.kind !== 'dir') return;
          e.stopPropagation();
          props.onToggle();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {row.kind === 'dir' && <Chevron open={row.expanded} />}
      </span>
      <EntryIcon name={row.name} dir={row.kind === 'dir'} open={row.expanded} />
      <span className="ft-name">{row.name}</span>
    </div>
  );
}
