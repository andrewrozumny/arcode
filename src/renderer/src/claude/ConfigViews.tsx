import { useState } from 'react';
import type { AgentInfo, HookInfo, McpServerInfo, MemoryFile, PluginInfo, SkillInfo } from '@shared/claude';
import { bus } from '../bus';
import { formatAge } from '../format';
import { Icon } from './FeedIcons';
import { mcpBadge } from './model';
import { usePanel } from './panelData';
import { agentFields, hookFields, hookSettingsPath, isInsideProject, mcpFields, mcpHealth, mcpSummaryText, pluginFields, skillFields } from './panelModel';
import { Badge, CopyButton, EmptyState, GroupedList, ItemRow, Notice, Toolbar, useDisplayPath } from './ui';

/** Rows of each config kind; the overview's search reuses them with a scope badge. */
export function SkillRow({ skill, showScope }: { skill: SkillInfo; showScope?: boolean }) {
  const display = useDisplayPath();
  return (
    <ItemRow
      icon="skill"
      name={skill.name}
      scope={showScope ? skill.scope : undefined}
      badges={skill.pluginName ? <Badge tone="neutral">{skill.pluginName}</Badge> : null}
      description={skill.description ?? 'No description in SKILL.md.'}
      meta={display(skill.path)}
      file={skill.path}
    />
  );
}

export function AgentRow({ agent, showScope }: { agent: AgentInfo; showScope?: boolean }) {
  const display = useDisplayPath();
  return (
    <ItemRow
      icon="agent"
      name={agent.name}
      scope={showScope ? agent.scope : undefined}
      badges={agent.model ? <Badge tone="neutral">{agent.model}</Badge> : null}
      description={agent.description ?? 'No description.'}
      meta={display(agent.path)}
      file={agent.path}
    />
  );
}

export function PluginRow({ plugin, showScope }: { plugin: PluginInfo; showScope?: boolean }) {
  const display = useDisplayPath();
  const facts = [
    plugin.marketplace,
    plugin.version ? `v${plugin.version}` : null,
    plugin.installedAt ? `installed ${formatAge(plugin.installedAt)}` : null,
  ].filter(Boolean);
  return (
    <ItemRow
      icon="plug"
      name={plugin.name}
      scope={showScope ? plugin.scope : undefined}
      badges={<Badge tone={plugin.enabled ? 'ok' : 'muted'}>{plugin.enabled ? 'Enabled' : 'Disabled'}</Badge>}
      description={facts.join(' · ')}
      meta={plugin.path ? display(plugin.path) : null}
      copyPath={plugin.path}
    />
  );
}

export function McpRow({ server, checked, showScope }: { server: McpServerInfo; checked: boolean; showScope?: boolean }) {
  const { root } = usePanel();
  const badge = server.state === 'unknown' && !checked ? { label: 'Not checked', tone: 'muted' as const } : mcpBadge(server.state);
  const target = server.url ?? server.command;
  return (
    <ItemRow
      icon="mcp"
      name={server.name}
      scope={showScope ? server.scope : undefined}
      badges={<Badge tone={badge.tone}>{badge.label}</Badge>}
      description={target}
      detail={server.state === 'failed' || server.state === 'needs-auth' ? server.detail : null}
      meta={server.transport ?? undefined}
      file={server.scope === 'project' ? `${root}/.mcp.json` : null}
    />
  );
}

export function HookRow({ hook, showScope }: { hook: HookInfo; showScope?: boolean }) {
  const { root, home } = usePanel();
  const display = useDisplayPath();
  const settings = hookSettingsPath(hook.scope, root, home);
  return (
    <ItemRow
      icon="hook"
      name={hook.event}
      scope={showScope ? hook.scope : undefined}
      badges={hook.matcher ? <Badge tone="neutral" title="Matcher: which tools trigger it">{hook.matcher}</Badge> : null}
      description={
        <code className="cl-code" title={hook.command}>
          {hook.command}
        </code>
      }
      meta={display(settings)}
      file={settings}
    />
  );
}

function SectionError({ error }: { error: string | null }) {
  return error ? <Notice tone="error">Could not read this section: {error}</Notice> : null;
}

function Loading({ show }: { show: boolean }) {
  return show ? <Notice>Loading…</Notice> : null;
}

/** Sections that list Claude Code configuration: skills, agents, plugins, MCP servers, hooks, CLAUDE.md files. */
export function SkillsView() {
  const { skills } = usePanel();
  const [query, setQuery] = useState('');
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Filter skills by name or description" />
      <SectionError error={skills.error} />
      <Loading show={!skills.data && !skills.error} />
      {skills.data && (
        <GroupedList
          items={skills.data}
          query={query}
          onClearQuery={() => setQuery('')}
          fieldsOf={skillFields}
          render={(s) => <SkillRow key={s.path} skill={s} />}
          empty={
            <EmptyState icon="skill" title="No skills yet">
              <p>A skill is a folder with a <code>SKILL.md</code> that teaches Claude one kind of task. Claude loads it when a request matches its description.</p>
              <ul className="cl-where">
                <li><code>~/.claude/skills/&lt;name&gt;/SKILL.md</code> for all your projects</li>
                <li><code>.claude/skills/&lt;name&gt;/SKILL.md</code> for this project only</li>
                <li>Plugins can bring skills too: run <code>/plugin</code> in Claude.</li>
              </ul>
            </EmptyState>
          }
        />
      )}
    </>
  );
}

export function AgentsView() {
  const { agents } = usePanel();
  const [query, setQuery] = useState('');
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Filter agents by name, model or description" />
      <SectionError error={agents.error} />
      <Loading show={!agents.data && !agents.error} />
      {agents.data && (
        <GroupedList
          items={agents.data}
          query={query}
          onClearQuery={() => setQuery('')}
          fieldsOf={agentFields}
          render={(a) => <AgentRow key={a.path} agent={a} />}
          empty={
            <EmptyState icon="agent" title="No custom agents">
              <p>Subagents are helpers Claude can delegate to, each with its own instructions, tools and model. Claude Code&apos;s built-in agents always work; custom ones are Markdown files.</p>
              <ul className="cl-where">
                <li><code>~/.claude/agents/&lt;name&gt;.md</code> for all your projects</li>
                <li><code>.claude/agents/&lt;name&gt;.md</code> for this project only</li>
                <li>Or run <code>/agents</code> in Claude to create one with a guide.</li>
              </ul>
            </EmptyState>
          }
        />
      )}
    </>
  );
}

export function PluginsView() {
  const { plugins } = usePanel();
  const [query, setQuery] = useState('');
  const enabled = plugins.data?.filter((p) => p.enabled).length ?? 0;
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Filter plugins">
        {plugins.data && plugins.data.length > 0 && (
          <span className="cl-toolbar-note">
            {enabled} of {plugins.data.length} enabled
          </span>
        )}
      </Toolbar>
      <SectionError error={plugins.error} />
      <Loading show={!plugins.data && !plugins.error} />
      {plugins.data && (
        <GroupedList
          items={plugins.data}
          query={query}
          onClearQuery={() => setQuery('')}
          fieldsOf={pluginFields}
          render={(p) => <PluginRow key={p.id} plugin={p} />}
          empty={
            <EmptyState icon="plug" title="No plugins installed">
              <p>Plugins bundle skills, agents, hooks and MCP servers into one install. Run <code>/plugin</code> in Claude to browse marketplaces and install one.</p>
            </EmptyState>
          }
        />
      )}
    </>
  );
}

export function McpView() {
  const { mcp, mcpStatus, mcpConfigured } = usePanel();
  const [query, setQuery] = useState('');
  const checked = mcpStatus.data !== null;
  const health = mcpHealth(mcp ?? []);
  const problems = health.failed + health.needsAuth;
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Filter servers by name or command">
        <button
          type="button"
          className={checked ? 'cl-btn' : 'cl-btn primary'}
          onClick={mcpStatus.reload}
          disabled={mcpStatus.loading}
          title="Runs claude mcp list in this project"
        >
          <Icon name={mcpStatus.loading ? 'clock' : 'refresh'} />
          {mcpStatus.loading ? 'Checking…' : checked ? 'Check again' : 'Check status'}
        </button>
      </Toolbar>
      {!checked && !mcpStatus.loading && (mcp?.length ?? 0) > 0 && (
        <Notice>
          Status not checked yet. <b>Check status</b> runs <code>claude mcp list</code>, which starts each server once and takes a few seconds.
          It also finds servers from plugins and claude.ai that are not in your settings files.
        </Notice>
      )}
      {checked && (
        <div className={problems > 0 ? 'cl-summary bad' : 'cl-summary good'}>
          <Icon name={problems > 0 ? 'alert' : 'check'} />
          {mcpSummaryText(health)}
        </div>
      )}
      <SectionError error={mcpStatus.error ?? mcpConfigured.error} />
      <Loading show={mcp === null && !mcpConfigured.error} />
      {mcp && (
        <GroupedList
          items={mcp}
          query={query}
          onClearQuery={() => setQuery('')}
          fieldsOf={mcpFields}
          render={(m) => <McpRow key={m.name} server={m} checked={checked} />}
          empty={
            <EmptyState icon="mcp" title={checked ? 'No MCP servers' : 'No MCP servers in your settings'}>
              <p>MCP servers give Claude extra tools: a browser, a database, GitHub, your own scripts.</p>
              <ul className="cl-where">
                <li><code>claude mcp add &lt;name&gt; -- &lt;command&gt;</code> in a terminal</li>
                <li><code>.mcp.json</code> in the project to share servers with your team</li>
                <li>{checked ? 'Plugins can add servers too.' : 'Check status to also list servers from plugins and claude.ai.'}</li>
              </ul>
            </EmptyState>
          }
        />
      )}
    </>
  );
}

export function HooksView() {
  const { hooks } = usePanel();
  const [query, setQuery] = useState('');
  return (
    <>
      <Toolbar query={query} onQuery={setQuery} placeholder="Filter hooks by event, matcher or command" />
      <SectionError error={hooks.error} />
      <Loading show={!hooks.data && !hooks.error} />
      {hooks.data && (
        <GroupedList
          items={hooks.data}
          query={query}
          onClearQuery={() => setQuery('')}
          fieldsOf={hookFields}
          render={(h, i) => <HookRow key={`${h.event}-${i}-${h.command}`} hook={h} />}
          empty={
            <EmptyState icon="hook" title="No hooks configured">
              <p>Hooks run your own shell commands at fixed moments: before or after a tool call, when you send a prompt, when Claude stops. Use them to format files, block risky commands or play a sound.</p>
              <ul className="cl-where">
                <li><code>hooks</code> in <code>~/.claude/settings.json</code> for all projects</li>
                <li><code>.claude/settings.json</code> (shared) or <code>.claude/settings.local.json</code> (just you)</li>
                <li>Or run <code>/hooks</code> in Claude.</li>
              </ul>
            </EmptyState>
          }
        />
      )}
    </>
  );
}

const MEMORY_HINTS: Record<string, string> = {
  'Global CLAUDE.md': 'Your personal instructions for every project. Create ~/.claude/CLAUDE.md to add preferences such as tone or commit style.',
  'Project CLAUDE.md': 'Shared instructions for this project, usually committed. Run /init in Claude to generate one from the code.',
  'Local CLAUDE.local.md': 'Your private notes for this project. Create CLAUDE.local.md and keep it out of git.',
};

function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function MemoryCard({ file }: { file: MemoryFile }) {
  const { root } = usePanel();
  const display = useDisplayPath();
  const inProject = isInsideProject(root, file.path);
  const missing = file.content === null;
  return (
    <section className={missing ? 'cl-memory missing' : 'cl-memory'}>
      <header className="cl-memory-head">
        <span className="cl-item-icon">
          <Icon name="file" />
        </span>
        <div className="cl-item-body">
          <div className="cl-item-title">
            <span className="cl-name">{file.label}</span>
            {missing ? (
              <Badge tone="muted">Not created</Badge>
            ) : (
              <Badge tone="ok">{lineCount(file.content ?? '')} lines</Badge>
            )}
          </div>
          <div className="cl-item-meta">{display(file.path)}</div>
        </div>
        <div className="cl-item-actions visible">
          <CopyButton text={file.path} label="Copy path" />
          {!missing && inProject && (
            <button type="button" className="cl-btn" onClick={() => bus.openFile({ path: file.path })}>
              Open in viewer
            </button>
          )}
        </div>
      </header>
      {missing ? (
        <p className="cl-memory-hint">{MEMORY_HINTS[file.label] ?? 'This file does not exist yet.'}</p>
      ) : (
        <>
          {!inProject && <div className="cl-preview-note">Outside the project folder, so it is shown read-only here.</div>}
          <pre className="cl-pre">{file.content}</pre>
        </>
      )}
    </section>
  );
}

export function MemoryView() {
  const { memory } = usePanel();
  return (
    <>
      <SectionError error={memory.error} />
      <Loading show={!memory.data && !memory.error} />
      <div className="cl-memory-list">
        {memory.data?.map((file) => (
          <MemoryCard key={file.path} file={file} />
        ))}
      </div>
    </>
  );
}
