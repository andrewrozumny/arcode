import { useState } from 'react';
import type { ReactNode } from 'react';
import type { LiveUsage } from '@shared/claude';
import { bus } from '../bus';
import { formatAge, formatTokens } from '../format';
import { modelFamily } from '../layout/modelFamily';
import { AgentRow, HookRow, McpRow, PluginRow, SkillRow } from './ConfigViews';
import { Icon } from './FeedIcons';
import type { IconName } from './FeedIcons';
import { headerUsage, useLiveUsage } from './liveUsage';
import { usePanel } from './panelData';
import { attentionItems, formatUntil, mcpHealth, scopeSummary, searchAll, sessionTitle } from './panelModel';
import type { SectionId } from './panelModel';
import { newClaudeTab, resumeSession, SessionRow, useMinuteClock } from './SessionsView';
import { Meter, NoMatches, SearchBox } from './ui';

function windowSub(win: LiveUsage['fiveHour'], now: number): string | null {
  if (!win?.resetsAt) return null;
  return `resets ${formatUntil(win.resetsAt, now)}`;
}

/** Model, context and plan windows from the status line; a pointer to the switch when it is off. */
function CurrentSessionCard({ now }: { now: number }) {
  const { root, sessions, statusLine, go } = usePanel();
  const records = useLiveUsage();
  const live = headerUsage(records, null, root, now);
  const latest = sessions.data?.[0] ?? null;
  const contextPercent =
    live?.contextPercent ??
    (live?.contextUsed != null && live.contextSize ? Math.round((live.contextUsed / live.contextSize) * 100) : null);
  return (
    <section className="cl-card">
      <div className="cl-card-head">
        <span className="cl-card-title">Current session</span>
        {live?.modelName && <span className={`cl-model model-family-${modelFamily(live.modelName)}`}>{live.modelName}</span>}
        {live && live.updatedAt > 0 && <span className="cl-card-aside">updated {formatAge(new Date(live.updatedAt).toISOString(), now)}</span>}
      </div>
      {latest ? (
        <div className="cl-current">
          <span className="cl-current-title" title={latest.firstPrompt ?? undefined}>
            {sessionTitle(latest)}
          </span>
          <span className="cl-current-meta">
            {formatAge(latest.lastActiveAt, now)} · {latest.messages} messages
          </span>
        </div>
      ) : (
        <div className="cl-current muted">No session in this project yet.</div>
      )}
      {live ? (
        <div className="cl-meters">
          <Meter
            label="Context"
            percent={contextPercent}
            value={contextPercent === null ? 'n/a' : `${contextPercent}%`}
            sub={live.contextUsed != null ? `${formatTokens(live.contextUsed)} of ${live.contextSize ? formatTokens(live.contextSize) : '?'} tokens` : 'No reply yet'}
          />
          <Meter
            label="5-hour limit"
            percent={live.fiveHour?.usedPercent ?? null}
            value={live.fiveHour?.usedPercent != null ? `${live.fiveHour.usedPercent}%` : 'n/a'}
            sub={windowSub(live.fiveHour, now)}
          />
          <Meter
            label="Weekly limit"
            percent={live.sevenDay?.usedPercent ?? null}
            value={live.sevenDay?.usedPercent != null ? `${live.sevenDay.usedPercent}%` : 'n/a'}
            sub={windowSub(live.sevenDay, now)}
          />
        </div>
      ) : (
        <div className="cl-hint">
          <Icon name="gauge" />
          <span>
            {statusLine.data?.state === 'acode'
              ? 'Context and plan usage appear after the next reply from Claude in this project.'
              : 'Context fill and plan limits appear here once the ARcode status line is on.'}
          </span>
          {statusLine.data?.state !== 'acode' && (
            <button type="button" className="cl-link" onClick={() => go('usage')}>
              Set up in Usage
            </button>
          )}
        </div>
      )}
      <QuickActions />
    </section>
  );
}

function QuickActions() {
  const { root, sessions, memory, mcpStatus, go } = usePanel();
  const latest = sessions.data?.[0] ?? null;
  const projectMd = memory.data?.find((f) => f.path === `${root.replace(/\/$/, '')}/CLAUDE.md`);
  const hasProjectMd = Boolean(projectMd && projectMd.content !== null);
  return (
    <div className="cl-quick">
      <button
        type="button"
        className="cl-btn primary"
        disabled={!latest}
        title={latest ? `Resume: ${sessionTitle(latest)}` : 'No session yet'}
        onClick={() => latest && resumeSession(latest)}
      >
        <Icon name="play" />
        Resume last session
      </button>
      <button type="button" className="cl-btn" onClick={newClaudeTab} title="Start a fresh Claude session in the terminal">
        <Icon name="plus" />
        New Claude tab
      </button>
      <button
        type="button"
        className="cl-btn"
        title={hasProjectMd ? 'Open the project CLAUDE.md in the viewer' : 'No CLAUDE.md yet: run /init in Claude'}
        onClick={() => (hasProjectMd && projectMd ? bus.openFile({ path: projectMd.path }) : go('memory'))}
      >
        <Icon name="file" />
        {hasProjectMd ? 'Open CLAUDE.md' : 'Set up CLAUDE.md'}
      </button>
      <button type="button" className="cl-btn" disabled={mcpStatus.loading} onClick={mcpStatus.reload} title="Runs claude mcp list in this project">
        <Icon name="mcp" />
        {mcpStatus.loading ? 'Checking MCP…' : 'Check MCP servers'}
      </button>
    </div>
  );
}

interface TileProps {
  section: SectionId;
  icon: IconName;
  label: string;
  count: number | null;
  sub: ReactNode;
  tone?: 'bad' | 'warn' | undefined;
}

function Tile({ section, icon, label, count, sub, tone }: TileProps) {
  const { go } = usePanel();
  return (
    <button type="button" className={tone ? `cl-tile ${tone}` : 'cl-tile'} onClick={() => go(section)}>
      <span className="cl-tile-top">
        <span className="cl-tile-icon">
          <Icon name={icon} />
        </span>
        <span className="cl-tile-count">{count ?? '…'}</span>
      </span>
      <span className="cl-tile-label">{label}</span>
      <span className="cl-tile-sub">{sub}</span>
    </button>
  );
}

function SetupTiles() {
  const { skills, agents, plugins, hooks, memory, mcp, mcpStatus } = usePanel();
  const health = mcpHealth(mcp ?? []);
  const checked = mcpStatus.data !== null;
  const memoryFound = memory.data?.filter((f) => f.content !== null).length ?? null;
  const enabledPlugins = plugins.data?.filter((p) => p.enabled).length ?? 0;
  const hookEvents = [...new Set((hooks.data ?? []).map((h) => h.event))];
  const mcpSub = !checked
    ? mcpStatus.loading
      ? 'Checking…'
      : 'Status not checked'
    : health.failed > 0
      ? `${health.failed} failing`
      : health.needsAuth > 0
        ? `${health.needsAuth} need${health.needsAuth === 1 ? 's' : ''} sign-in`
        : `${health.connected} connected`;
  return (
    <div className="cl-tiles">
      <Tile section="memory" icon="file" label="CLAUDE.md" count={memoryFound} sub={memory.data ? `${memoryFound} of ${memory.data.length} files exist` : ''} />
      <Tile section="skills" icon="skill" label="Skills" count={skills.data?.length ?? null} sub={skills.data?.length ? scopeSummary(skills.data) : 'None yet'} />
      <Tile section="agents" icon="agent" label="Agents" count={agents.data?.length ?? null} sub={agents.data?.length ? scopeSummary(agents.data) : 'Built-in only'} />
      <Tile
        section="plugins"
        icon="plug"
        label="Plugins"
        count={plugins.data?.length ?? null}
        sub={plugins.data?.length ? `${enabledPlugins} enabled` : 'None installed'}
      />
      <Tile
        section="mcp"
        icon="mcp"
        label="MCP servers"
        count={mcp?.length ?? null}
        sub={mcpSub}
        tone={health.failed > 0 ? 'bad' : health.needsAuth > 0 ? 'warn' : undefined}
      />
      <Tile section="hooks" icon="hook" label="Hooks" count={hooks.data?.length ?? null} sub={hookEvents.length ? hookEvents.join(', ') : 'None configured'} />
    </div>
  );
}

function Attention() {
  const { root, memory, hooks, statusLine, mcpStatus, go } = usePanel();
  const items = attentionItems({
    mcpChecked: mcpStatus.data,
    memory: memory.data,
    hooks: hooks.data,
    statusLine: statusLine.data,
    projectClaudeMd: `${root.replace(/\/$/, '')}/CLAUDE.md`,
  });
  return (
    <section className="cl-card">
      <div className="cl-card-head">
        <span className="cl-card-title">Worth a look</span>
      </div>
      {items.length === 0 ? (
        <div className="cl-allgood">
          <Icon name="check" />
          Nothing needs attention.
        </div>
      ) : (
        <div className="cl-attention">
          {items.map((item) => (
            <button key={item.id} type="button" className={`cl-attn ${item.tone}`} onClick={() => go(item.section)}>
              <Icon name={item.tone === 'info' ? 'info' : 'alert'} />
              <span className="cl-attn-text">
                <span className="cl-attn-title">{item.title}</span>
                <span className="cl-attn-detail">{item.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function RecentSessions({ now }: { now: number }) {
  const { sessions, go } = usePanel();
  const recent = (sessions.data ?? []).slice(0, 3);
  return (
    <section className="cl-card">
      <div className="cl-card-head">
        <span className="cl-card-title">Recent sessions</span>
        {(sessions.data?.length ?? 0) > 3 && (
          <button type="button" className="cl-link cl-card-aside" onClick={() => go('sessions')}>
            All {sessions.data?.length}
          </button>
        )}
      </div>
      {recent.length === 0 ? (
        <div className="cl-current muted">Sessions you run in this project show up here.</div>
      ) : (
        <div className="cl-list flush">
          {recent.map((s, i) => (
            <SessionRow key={s.sessionId} session={s} now={now} latest={i === 0} />
          ))}
        </div>
      )}
    </section>
  );
}

function SearchResultsView({ query, onClear }: { query: string; onClear(): void }) {
  const { skills, agents, plugins, hooks, mcp, mcpStatus } = usePanel();
  const results = searchAll({ skills: skills.data, agents: agents.data, plugins: plugins.data, mcp, hooks: hooks.data }, query);
  if (results.total === 0) return <NoMatches query={query} onClear={onClear} />;
  const group = (label: string, count: number, rows: ReactNode) =>
    count > 0 && (
      <section className="cl-group">
        <h3 className="cl-group-title">
          {label} <span className="cl-count">{count}</span>
        </h3>
        <div className="cl-list">{rows}</div>
      </section>
    );
  return (
    <>
      {group('Skills', results.skills.length, results.skills.map((s) => <SkillRow key={s.path} skill={s} showScope />))}
      {group('Agents', results.agents.length, results.agents.map((a) => <AgentRow key={a.path} agent={a} showScope />))}
      {group('Plugins', results.plugins.length, results.plugins.map((p) => <PluginRow key={p.id} plugin={p} showScope />))}
      {group('MCP servers', results.mcp.length, results.mcp.map((m) => <McpRow key={m.name} server={m} checked={mcpStatus.data !== null} showScope />))}
      {group('Hooks', results.hooks.length, results.hooks.map((h, i) => <HookRow key={`${h.event}-${i}`} hook={h} showScope />))}
    </>
  );
}

/** First section: the session at a glance, what is set up, what needs attention, and shortcuts. */
export function OverviewView() {
  const [query, setQuery] = useState('');
  const now = useMinuteClock();
  return (
    <>
      <div className="cl-toolbar">
        <SearchBox query={query} onQuery={setQuery} placeholder="Search skills, agents, plugins, MCP servers and hooks" />
      </div>
      {query.trim() ? (
        <SearchResultsView query={query} onClear={() => setQuery('')} />
      ) : (
        <div className="cl-overview">
          <CurrentSessionCard now={now} />
          <h3 className="cl-group-title">Setup</h3>
          <SetupTiles />
          <div className="cl-grid even">
            <Attention />
            <RecentSessions now={now} />
          </div>
        </div>
      )}
    </>
  );
}
