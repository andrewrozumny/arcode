import { useEffect, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { shortenPath } from '@shared/app';
import type { ConfigFileContent, ConfigScope } from '@shared/claude';
import { bus } from '../bus';
import { claudeApi } from './api';
import { Chevron, Icon } from './FeedIcons';
import type { IconName } from './FeedIcons';
import { groupByScope, matchesQuery, SCOPE_LABELS } from './model';
import type { BadgeTone, ScopeGroup } from './model';
import { usePanel } from './panelData';
import { isInsideProject } from './panelModel';

/** Small building blocks shared by the Claude panel's sections. */
export function Badge({ tone, children, title }: { tone: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`cl-badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ScopeBadge({ scope }: { scope: ConfigScope }) {
  return <span className={`cl-scope ${scope}`}>{SCOPE_LABELS[scope]}</span>;
}

export function Notice({ children, tone }: { children: ReactNode; tone?: 'error' }) {
  return <div className={tone ? `cl-notice ${tone}` : 'cl-notice'}>{children}</div>;
}

/** A path with the home folder written as `~`. */
export function useDisplayPath(): (path: string) => string {
  const { home } = usePanel();
  return (path) => shortenPath(path, home);
}

export function Toolbar({ query, onQuery, placeholder, children }: {
  query: string;
  onQuery(value: string): void;
  placeholder: string;
  children?: ReactNode;
}) {
  return (
    <div className="cl-toolbar">
      <SearchBox query={query} onQuery={onQuery} placeholder={placeholder} />
      {children}
    </div>
  );
}

export function SearchBox({ query, onQuery, placeholder }: { query: string; onQuery(value: string): void; placeholder: string }) {
  return (
    <label className="cl-search">
      <Icon name="search" className="cl-search-icon" />
      <input
        type="search"
        value={query}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) {
            e.stopPropagation();
            onQuery('');
          }
        }}
      />
    </label>
  );
}

/** Explains an empty section: what it is and where things come from. */
export function EmptyState({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="cl-empty">
      <span className="cl-empty-icon">
        <Icon name={icon} />
      </span>
      <div className="cl-empty-title">{title}</div>
      <div className="cl-empty-text">{children}</div>
      {action && <div className="cl-empty-action">{action}</div>}
    </div>
  );
}

export function NoMatches({ query, onClear }: { query: string; onClear(): void }) {
  return (
    <div className="cl-nomatch">
      Nothing matches “{query.trim()}”.{' '}
      <button type="button" className="cl-link" onClick={onClear}>
        Clear search
      </button>
    </div>
  );
}

/** Icon button that copies text and confirms with a check mark. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={copied ? 'cl-icon-btn copied' : 'cl-icon-btn'}
      title={copied ? 'Copied' : label}
      aria-label={label}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        window.acode.clipboard.writeText(text);
        setCopied(true);
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} />
    </button>
  );
}

/** Read-only text of a file outside the project, loaded when the row is expanded. */
function FilePreview({ path }: { path: string }) {
  const { root } = usePanel();
  const [content, setContent] = useState<ConfigFileContent | null>(null);
  useEffect(() => {
    let live = true;
    claudeApi()
      .readConfigFile(root, path)
      .then(
        (result) => live && setContent(result),
        (err: unknown) => live && setContent({ ok: false, reason: String(err) }),
      );
    return () => {
      live = false;
    };
  }, [root, path]);
  if (!content) return <div className="cl-preview muted">Loading…</div>;
  if (!content.ok) return <div className="cl-preview muted">{content.reason}</div>;
  return (
    <div className="cl-preview">
      <div className="cl-preview-note">Read-only preview. This file lives outside the project, so edit it in your editor.</div>
      <pre className="cl-pre">
        {content.text}
        {content.truncated ? '\n…' : ''}
      </pre>
    </div>
  );
}

export interface ItemRowProps {
  icon: IconName;
  name: string;
  /** Scope badge; omitted inside a list that is already grouped by scope. */
  scope?: ConfigScope | undefined;
  badges?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  /** Error or warning text under the description. */
  detail?: string | null | undefined;
  /** The file behind the item: opens in the viewer (inside the project) or previews in place. */
  file?: string | null | undefined;
  /** Copy-path target when it differs from `file` (for example a plugin folder). */
  copyPath?: string | null | undefined;
  trailing?: ReactNode;
}

/**
 * One config item: name, scope, one-line description and a mono meta line. Clicking opens its
 * file in the viewer when it is inside the project, otherwise it expands a read-only preview.
 */
export function ItemRow({ icon, name, scope, badges, description, meta, detail, file, copyPath, trailing }: ItemRowProps) {
  const { root } = usePanel();
  const [open, setOpen] = useState(false);
  const inProject = file ? isInsideProject(root, file) : false;
  const previewable = Boolean(file) && !inProject;
  const clickable = Boolean(file);
  const activate = (): void => {
    if (!file) return;
    if (inProject) bus.openFile({ path: file });
    else setOpen((o) => !o);
  };
  const copyTarget = copyPath ?? file;
  return (
    <div className={`cl-item${clickable ? ' clickable' : ''}${open ? ' open' : ''}`}>
      <div
        className="cl-item-head"
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        aria-expanded={previewable ? open : undefined}
        title={inProject ? 'Open in the viewer' : previewable ? (open ? 'Hide preview' : 'Show preview') : undefined}
        onClick={activate}
        onKeyDown={(e: KeyboardEvent) => {
          // Keys on the copy button inside the row belong to that button.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
      >
        <span className="cl-item-icon">
          <Icon name={icon} />
        </span>
        <div className="cl-item-body">
          <div className="cl-item-title">
            <span className="cl-name" title={name}>
              {name}
            </span>
            {scope && <ScopeBadge scope={scope} />}
            {badges}
          </div>
          {description && (
            <div className="cl-item-desc" title={typeof description === 'string' ? description : undefined}>
              {description}
            </div>
          )}
          {detail && <div className="cl-detail">{detail}</div>}
          {meta && <div className="cl-item-meta">{meta}</div>}
        </div>
        <div className="cl-item-actions">
          {trailing}
          {copyTarget && <CopyButton text={copyTarget} label="Copy path" />}
          {inProject && (
            <span className="cl-item-go" aria-hidden="true">
              Open
            </span>
          )}
          {previewable && (
            <span className="cl-item-chevron" aria-hidden="true">
              <Chevron open={open} />
            </span>
          )}
        </div>
      </div>
      {open && file && <FilePreview path={file} />}
    </div>
  );
}

/** Filtered list grouped by scope, with a guided empty state and a no-match line. */
export function GroupedList<T extends { scope: ConfigScope }>({
  items,
  query,
  onClearQuery,
  fieldsOf,
  render,
  empty,
}: {
  items: T[];
  query: string;
  onClearQuery(): void;
  fieldsOf(item: T): (string | null | undefined)[];
  render(item: T, index: number): ReactNode;
  empty: ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;
  const visible = items.filter((item) => matchesQuery(fieldsOf(item), query));
  if (visible.length === 0) return <NoMatches query={query} onClear={onClearQuery} />;
  const groups: ScopeGroup<T>[] = groupByScope(visible);
  return (
    <>
      {groups.map((group) => (
        <section key={group.scope} className="cl-group">
          <h3 className="cl-group-title">
            {group.label} <span className="cl-count">{group.items.length}</span>
          </h3>
          <div className="cl-list">{group.items.map((item, index) => render(item, index))}</div>
        </section>
      ))}
    </>
  );
}

/** Horizontal meter for a percentage, amber from 70 and red from 90 like the header bars. */
export function Meter({ label, percent, value, sub }: { label: string; percent: number | null; value: string; sub?: string | null }) {
  const clamped = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const tone = percent === null ? 'muted' : percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok';
  return (
    <div className={`cl-meter ${tone}`}>
      <div className="cl-meter-head">
        <span className="cl-meter-label">{label}</span>
        <span className="cl-meter-value">{value}</span>
      </div>
      <div className="cl-meter-track" aria-hidden="true">
        <div className="cl-meter-fill" style={{ width: `${clamped}%` }} />
      </div>
      {sub && <div className="cl-meter-sub">{sub}</div>}
    </div>
  );
}
