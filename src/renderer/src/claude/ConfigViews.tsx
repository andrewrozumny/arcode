import { useState } from 'react';
import { shortenPath } from '@shared/app';
import type { AgentInfo, HookInfo, McpServerInfo, MemoryFile, PluginInfo, SkillInfo } from '@shared/claude';
import { bus } from '../bus';
import { formatAge } from '../format';
import { claudeApi } from './api';
import { mcpBadge } from './model';
import { Badge, GroupedList, Notice, Toolbar } from './ui';
import { useLoad } from './useLoad';

let home: string | null = null;
/** A path with the home folder written as `~`. */
function displayPath(path: string): string {
  home ??= window.acode.app.context().home;
  return shortenPath(path, home);
}

/** Sections that list Claude Code configuration: skills, plugins, MCP servers, agents, hooks, CLAUDE.md files. */
export function SkillsView({ root }: { root: string }) {
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useLoad<SkillInfo[]>(() => claudeApi().skills(root), true);
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} onRefresh={reload} loading={loading} placeholder="Filter skills" />
      {error && <Notice>{error}</Notice>}
      {data && (
        <GroupedList
          items={data}
          query={query}
          fieldsOf={(s) => [s.name, s.description, s.pluginName]}
          emptyText="No skills in this project, your home folder or the installed plugins."
          render={(s) => (
            <>
              <div className="cl-row-main">
                <span className="cl-name">{s.name}</span>
                {s.pluginName && <Badge tone="neutral">{s.pluginName}</Badge>}
              </div>
              {s.description && <div className="cl-desc">{s.description}</div>}
              <div className="cl-path" title={s.path}>{displayPath(s.path)}</div>
            </>
          )}
        />
      )}
    </>
  );
}

export function PluginsView({ root }: { root: string }) {
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useLoad<PluginInfo[]>(() => claudeApi().plugins(root), true);
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} onRefresh={reload} loading={loading} placeholder="Filter plugins" />
      {error && <Notice>{error}</Notice>}
      {data && (
        <GroupedList
          items={data}
          query={query}
          fieldsOf={(p) => [p.name, p.marketplace, p.id]}
          emptyText="No plugins installed."
          render={(p) => (
            <>
              <div className="cl-row-main">
                <span className="cl-name">{p.name}</span>
                <Badge tone={p.enabled ? 'ok' : 'muted'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>
              </div>
              <div className="cl-desc">
                {p.marketplace}
                {p.version ? ` · ${p.version}` : ''}
                {p.installedAt ? ` · installed ${formatAge(p.installedAt)}` : ''}
              </div>
            </>
          )}
        />
      )}
    </>
  );
}

export function McpView({ root }: { root: string }) {
  const [query, setQuery] = useState('');
  // MCP status runs `claude mcp list` and takes seconds, so it loads only when asked.
  const { data, error, loading, reload } = useLoad<McpServerInfo[]>(() => claudeApi().mcp(root), false);
  const started = data !== null || loading || error !== null;
  return (
    <>
      <Toolbar
        query={query}
        onQuery={setQuery}
        onRefresh={started ? reload : undefined}
        loading={loading}
        placeholder="Filter servers"
      />
      {!started && (
        <div className="cl-cta">
          <p className="cl-desc">Checking runs <code>claude mcp list</code> and takes a few seconds.</p>
          <button type="button" className="cl-btn primary" onClick={reload}>
            Check status
          </button>
        </div>
      )}
      {loading && <Notice>Checking servers…</Notice>}
      {error && <Notice>{error}</Notice>}
      {data && (
        <GroupedList
          items={data}
          query={query}
          fieldsOf={(m) => [m.name, m.command, m.url, m.transport]}
          emptyText="No MCP servers configured."
          render={(m) => {
            const badge = mcpBadge(m.state);
            return (
              <>
                <div className="cl-row-main">
                  <span className="cl-name">{m.name}</span>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </div>
                <div className="cl-desc">
                  {m.transport ?? 'unknown transport'}
                  {m.command ? ` · ${m.command}` : ''}
                  {m.url ? ` · ${m.url}` : ''}
                </div>
                {m.detail && <div className="cl-detail">{m.detail}</div>}
              </>
            );
          }}
        />
      )}
    </>
  );
}

export function AgentsView({ root }: { root: string }) {
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useLoad<AgentInfo[]>(() => claudeApi().agents(root), true);
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} onRefresh={reload} loading={loading} placeholder="Filter agents" />
      {error && <Notice>{error}</Notice>}
      {data && (
        <GroupedList
          items={data}
          query={query}
          fieldsOf={(a) => [a.name, a.description, a.model]}
          emptyText="No subagents defined."
          render={(a) => (
            <>
              <div className="cl-row-main">
                <span className="cl-name">{a.name}</span>
                {a.model && <Badge tone="neutral">{a.model}</Badge>}
              </div>
              {a.description && <div className="cl-desc">{a.description}</div>}
              <div className="cl-path" title={a.path}>{displayPath(a.path)}</div>
            </>
          )}
        />
      )}
    </>
  );
}

export function HooksView({ root }: { root: string }) {
  const [query, setQuery] = useState('');
  const { data, error, loading, reload } = useLoad<HookInfo[]>(() => claudeApi().hooks(root), true);
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} onRefresh={reload} loading={loading} placeholder="Filter hooks" />
      {error && <Notice>{error}</Notice>}
      {data && (
        <GroupedList
          items={data}
          query={query}
          fieldsOf={(h) => [h.event, h.matcher, h.command]}
          emptyText="No hooks configured."
          render={(h) => (
            <>
              <div className="cl-row-main">
                <span className="cl-name">{h.event}</span>
                {h.matcher && <Badge tone="neutral">{h.matcher}</Badge>}
              </div>
              <div className="cl-path" title={h.command}>{h.command}</div>
            </>
          )}
        />
      )}
    </>
  );
}

/** The viewer reads files only inside the project folder. */
function isInsideProject(root: string, path: string): boolean {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  return path.startsWith(`${base}/`);
}

export function MemoryView({ root }: { root: string }) {
  const { data, error, loading, reload } = useLoad<MemoryFile[]>(() => claudeApi().memory(root), true);
  return (
    <>
      <div className="cl-toolbar">
        <span className="cl-desc cl-grow">Read-only here. Project files open in the viewer for editing.</span>
        <button type="button" className="cl-btn" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <Notice>{error}</Notice>}
      {data?.map((file) => (
        <section key={file.path} className="cl-memory">
          <h3 className="cl-group-title">{file.label}</h3>
          <div className="cl-path" title={file.path}>{displayPath(file.path)}</div>
          {file.content === null ? (
            <Notice>File not found.</Notice>
          ) : (
            <>
              {isInsideProject(root, file.path) ? (
                <button
                  type="button"
                  className="cl-btn"
                  onClick={() => bus.openFile({ path: file.path })}
                >
                  Open in viewer
                </button>
              ) : (
                <div className="cl-desc">Outside the project folder: not openable in the viewer.</div>
              )}
              <pre className="cl-pre">{file.content}</pre>
            </>
          )}
        </section>
      ))}
    </>
  );
}
