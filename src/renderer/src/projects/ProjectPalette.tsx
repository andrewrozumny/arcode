import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { shortenPath } from '@shared/app';
import type { ProjectEntry, ProjectList } from '@shared/app';
import { filterProjects, mergeProjects } from './fuzzy';

const EMPTY: ProjectList = { recent: [], registry: [] };

interface Row {
  kind: 'project' | 'open-folder';
  project?: ProjectEntry;
}

/** Project switcher shown in its own small window. */
export function ProjectPalette({ home }: { home: string }) {
  const [list, setList] = useState<ProjectList>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    window.acode.projects
      .list()
      .then(setList, () => setList(EMPTY))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    return window.acode.app.onPaletteShown(() => {
      setLoading(true);
      setQuery('');
      setSelected(0);
      refresh();
      inputRef.current?.focus();
    });
  }, [refresh]);

  const rows = useMemo<Row[]>(() => {
    const projects = filterProjects(query, mergeProjects(list.recent, list.registry));
    return [...projects.map((project) => ({ kind: 'project' as const, project })), { kind: 'open-folder' as const }];
  }, [list, query]);

  const recentCount = query.trim() ? 0 : list.recent.length;
  const current = Math.min(selected, rows.length - 1);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const activate = (row: Row | undefined): void => {
    if (!row) return;
    if (row.kind === 'open-folder') void window.acode.projects.openFolder();
    else if (row.project) window.acode.projects.open(row.project.root);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      setSelected((current + 1) % rows.length);
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      setSelected((current - 1 + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(rows[current]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      window.acode.app.hidePalette();
    }
  };

  return (
    <div className="palette">
      <input
        ref={inputRef}
        className="palette-input"
        autoFocus
        spellCheck={false}
        placeholder="Open project: type a name, slug or path"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="palette-list" ref={listRef}>
        {rows.map((row, index) => {
          const section =
            !query.trim() && row.kind === 'project'
              ? index === 0 && recentCount > 0
                ? 'Recent'
                : index === recentCount
                  ? 'Projects'
                  : undefined
              : undefined;
          return (
            <div key={row.project?.root ?? row.kind}>
              {section && <div className="palette-section">{section}</div>}
              {row.kind === 'open-folder' && <div className="palette-divider" />}
              <div
                data-index={index}
                className={index === current ? 'palette-row selected' : 'palette-row'}
                onMouseMove={() => setSelected(index)}
                onClick={() => activate(row)}
              >
                {row.kind === 'open-folder' ? (
                  <span className="palette-name">Open folder...</span>
                ) : (
                  row.project && <ProjectRow project={row.project} home={home} />
                )}
              </div>
            </div>
          );
        })}
        {loading && rows.length === 1 && <div className="palette-empty">Loading projects...</div>}
        {!loading && rows.length === 1 && query.trim() && <div className="palette-empty">No matching projects</div>}
      </div>
      <div className="palette-footer">
        <span>Enter open</span>
        <span>Esc close</span>
        <span>Cmd+Shift+O switch project</span>
      </div>
    </div>
  );
}

function ProjectRow({ project, home }: { project: ProjectEntry; home: string }) {
  return (
    <>
      <span className="palette-name">{project.name}</span>
      {project.status && <span className={`palette-badge status-${project.status}`}>{project.status}</span>}
      <span className="palette-path">{shortenPath(project.root, home)}</span>
    </>
  );
}
