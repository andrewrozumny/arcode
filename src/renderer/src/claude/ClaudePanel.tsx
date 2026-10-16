import { useState } from 'react';
import type { ReactNode } from 'react';
import { AgentsView, HooksView, McpView, MemoryView, PluginsView, SkillsView } from './ConfigViews';
import { GatesView } from './GatesView';
import { SessionsView } from './SessionsView';
import { UsageView } from './UsageView';
import './claude.css';

type SectionId = 'skills' | 'plugins' | 'mcp' | 'agents' | 'hooks' | 'memory' | 'usage' | 'sessions' | 'gates';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'mcp', label: 'MCP' },
  { id: 'agents', label: 'Agents' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'memory', label: 'CLAUDE.md' },
  { id: 'usage', label: 'Usage' },
  { id: 'gates', label: 'Gates' },
];


const VIEWS: Record<SectionId, (props: { root: string }) => ReactNode> = {
  sessions: SessionsView,
  skills: SkillsView,
  plugins: PluginsView,
  mcp: McpView,
  agents: AgentsView,
  hooks: HooksView,
  memory: MemoryView,
  usage: UsageView,
  gates: GatesView,
};

/** Claude Code configuration and usage for the project, as sub-tabs of one panel. */
export function ClaudePanel({ projectRoot }: { projectRoot: string }) {
  const [section, setSection] = useState<SectionId>('skills');
  const View = VIEWS[section];
  return (
    <div className="cl-root">
      <nav className="cl-tabs" role="tablist" aria-label="Claude sections">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={s.id === section}
            className={s.id === section ? 'cl-tab active' : 'cl-tab'}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="cl-body" key={section}>
        <View root={projectRoot} />
      </div>
    </div>
  );
}
