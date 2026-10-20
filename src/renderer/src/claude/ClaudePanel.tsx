import { useState } from 'react';
import type { ReactNode } from 'react';
import logoUrl from '../../../../design/empty-mark.svg';
import { AgentsView, HooksView, McpView, MemoryView, PluginsView, SkillsView } from './ConfigViews';
import { Icon } from './FeedIcons';
import { GatesView } from './GatesView';
import { OverviewView } from './OverviewView';
import { PanelDataProvider, usePanel } from './panelData';
import { isSectionId, mcpHealth, SECTIONS, sectionInfo } from './panelModel';
import type { SectionId, SectionInfo } from './panelModel';
import { SessionsView } from './SessionsView';
import { UsageView } from './UsageView';
import './claude.css';

const STORAGE_KEY = 'arcode.claudePanel.section';

const VIEWS: Record<SectionId, (props: { root: string }) => ReactNode> = {
  overview: OverviewView,
  sessions: SessionsView,
  usage: UsageView,
  gates: GatesView,
  memory: MemoryView,
  skills: SkillsView,
  agents: AgentsView,
  plugins: PluginsView,
  mcp: McpView,
  hooks: HooksView,
};

function storedSection(): SectionId {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return isSectionId(value) ? value : 'overview';
  } catch {
    return 'overview';
  }
}

/** Count (and problem marker) next to a section in the navigation. */
function useNavCounts(): Partial<Record<SectionId, { count: number; bad?: boolean }>> {
  const { skills, agents, plugins, hooks, sessions, memory, mcp } = usePanel();
  const health = mcpHealth(mcp ?? []);
  const out: Partial<Record<SectionId, { count: number; bad?: boolean }>> = {};
  if (sessions.data) out.sessions = { count: sessions.data.length };
  if (memory.data) out.memory = { count: memory.data.filter((f) => f.content !== null).length };
  if (skills.data) out.skills = { count: skills.data.length };
  if (agents.data) out.agents = { count: agents.data.length };
  if (plugins.data) out.plugins = { count: plugins.data.length };
  if (mcp) out.mcp = { count: mcp.length, bad: health.failed + health.needsAuth > 0 };
  if (hooks.data) out.hooks = { count: hooks.data.length };
  return out;
}

function Nav({ section, onSelect }: { section: SectionId; onSelect(id: SectionId): void }) {
  const counts = useNavCounts();
  const groups: { title: string | null; items: SectionInfo[] }[] = [];
  for (const s of SECTIONS) {
    const last = groups[groups.length - 1];
    if (last && last.title === s.group) last.items.push(s);
    else groups.push({ title: s.group, items: [s] });
  }
  return (
    <nav className="cl-nav" role="tablist" aria-label="Claude sections" aria-orientation="vertical">
      {groups.map((group) => (
        <div key={group.title ?? 'top'} className="cl-nav-group">
          {group.title && <div className="cl-nav-title">{group.title}</div>}
          {group.items.map((s) => {
            const info = counts[s.id];
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === section}
                className={s.id === section ? 'cl-nav-item active' : 'cl-nav-item'}
                onClick={() => onSelect(s.id)}
              >
                <Icon name={s.icon} />
                <span className="cl-nav-label">{s.label}</span>
                {info?.bad && <span className="cl-nav-dot" title="Needs attention" />}
                {info && <span className="cl-nav-count">{info.count}</span>}
              </button>
            );
          })}
        </div>
      ))}
      <img className="cl-nav-logo" src={logoUrl} alt="" draggable={false} />
    </nav>
  );
}

function Shell({ section, onSelect }: { section: SectionId; onSelect(id: SectionId): void }) {
  const { root, reloadAll } = usePanel();
  const info = sectionInfo(section);
  const View = VIEWS[section];
  return (
    <div className="cl-root">
      <Nav section={section} onSelect={onSelect} />
      <main className="cl-main">
        <header className="cl-head">
          <div className="cl-head-text">
            <h2 className="cl-title">{info.label}</h2>
            <p className="cl-blurb">{info.blurb}</p>
          </div>
          <button type="button" className="cl-icon-btn large" onClick={reloadAll} title="Reload from disk" aria-label="Reload from disk">
            <Icon name="refresh" />
          </button>
        </header>
        <div className="cl-body" key={section}>
          <View root={root} />
        </div>
      </main>
    </div>
  );
}

/** Claude Code configuration and usage for the project: an overview plus one section per kind. */
export function ClaudePanel({ projectRoot }: { projectRoot: string }) {
  const [section, setSection] = useState<SectionId>(storedSection);
  const select = (id: SectionId): void => {
    setSection(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Remembering the section is a convenience only.
    }
  };
  return (
    <PanelDataProvider root={projectRoot} go={select}>
      <Shell section={section} onSelect={select} />
    </PanelDataProvider>
  );
}
