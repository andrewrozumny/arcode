import type { ReactNode } from 'react';
import type { ConfigScope } from '@shared/claude';
import { groupByScope, matchesQuery } from './model';
import type { BadgeTone, ScopeGroup } from './model';

/** Small building blocks shared by the Claude panel's sections. */
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <span className={`cl-badge ${tone}`}>{children}</span>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="cl-notice">{children}</div>;
}

export function Toolbar({ query, onQuery, onRefresh, loading, placeholder }: {
  query: string;
  onQuery(value: string): void;
  onRefresh?: (() => void) | undefined;
  loading: boolean;
  placeholder: string;
}) {
  return (
    <div className="cl-toolbar">
      <input
        className="cl-search"
        type="search"
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
      />
      {onRefresh && (
        <button type="button" className="cl-btn" onClick={onRefresh} disabled={loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      )}
    </div>
  );
}

/** Filtered list grouped by scope, with a plain empty state. */
export function GroupedList<T extends { scope: ConfigScope }>({
  items,
  query,
  fieldsOf,
  render,
  emptyText,
}: {
  items: T[];
  query: string;
  fieldsOf(item: T): (string | null | undefined)[];
  render(item: T): ReactNode;
  emptyText: string;
}) {
  const visible = items.filter((item) => matchesQuery(fieldsOf(item), query));
  if (items.length === 0) return <Notice>{emptyText}</Notice>;
  if (visible.length === 0) return <Notice>Nothing matches “{query.trim()}”.</Notice>;
  const groups: ScopeGroup<T>[] = groupByScope(visible);
  return (
    <div className="cl-list">
      {groups.map((group) => (
        <section key={group.scope} className="cl-group">
          <h3 className="cl-group-title">
            {group.label} <span className="cl-count">{group.items.length}</span>
          </h3>
          {group.items.map((item, index) => (
            <div key={index} className="cl-row">
              {render(item)}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
