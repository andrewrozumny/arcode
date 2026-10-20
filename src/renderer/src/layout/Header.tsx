import { GATE_LABELS, GATE_TARGETS, baseName, shortenPath } from '@shared/app';
import type { GateTarget } from '@shared/app';
import type { LiveUsage, SubagentInfo } from '@shared/claude';
import type { GitBranch } from '@shared/files';
import type { IdeStatus } from '@shared/ide-ipc';
import type { BadgeModel } from '../claude/liveUsage';
import { AgentsChip, ModelBadge } from './ClaudeBadges';
import { BranchLabel, IdeIndicator, ProjectAvatar } from './HeaderParts';
import { UsageBadge } from './UsageBadge';
import { WindowControls } from './WindowControls';

interface Props {
  projectRoot: string;
  home: string;
  onRunGate(target: GateTarget): void;
  onOpenProjects(): void;
  /** IDE bridge status; the indicator is hidden while undefined. */
  ide?: IdeStatus | undefined;
  /** Model of the active Claude tab in this window; hidden while null. */
  claudeModel?: BadgeModel | null;
  /** Opens the Claude panel (skills, plugins, MCP, usage) in the viewer area. */
  onOpenClaude(): void;
  /** Current git branch; hidden while null (not a repository or not loaded yet). */
  branch?: GitBranch | null;
  /** Plan usage of the active Claude session from the status line; hidden while null. */
  usage?: LiveUsage | null;
  /** Running subagents of the active Claude session; the chip is hidden while empty. */
  subagents?: readonly SubagentInfo[] | undefined;
  /** Session the subagents belong to, for their "Open transcript" entries. */
  subagentSessionId?: string | null | undefined;
}

/** Window title bar: traffic lights on the left, project name and path, gate buttons. */
export function Header({ projectRoot, home, onRunGate, onOpenProjects, ide, claudeModel, onOpenClaude, branch, usage, subagents, subagentSessionId }: Props) {
  const name = baseName(projectRoot);
  return (
    <header className="header">
      <WindowControls />
      <button type="button" className="header-project" title="Switch project (Cmd+Shift+O)" onClick={onOpenProjects}>
        <ProjectAvatar name={name} />
        <span className="header-name">{name}</span>
        <span className="header-path">{shortenPath(projectRoot, home)}</span>
      </button>
      {branch && <BranchLabel branch={branch} />}
      <div className="header-spacer" />
      <button type="button" className="header-claude" title="Claude: skills, plugins, MCP, agents, hooks, CLAUDE.md, usage" onClick={onOpenClaude}>
        Claude
      </button>
      {claudeModel && <ModelBadge model={claudeModel} />}
      {subagents && subagents.length > 0 && <AgentsChip agents={subagents} sessionId={subagentSessionId ?? null} />}
      {usage && <UsageBadge usage={usage} />}
      {ide && <IdeIndicator status={ide} />}
      <div className="gates" role="toolbar" aria-label="Quality gates">
        <span className="gates-label">Gate</span>
        {GATE_TARGETS.map((target) => (
          <button
            key={target}
            type="button"
            className={target === 'all' ? 'gate gate-all' : 'gate'}
            title={`scripts/gates.sh ${target}`}
            onClick={() => onRunGate(target)}
          >
            {GATE_LABELS[target]}
          </button>
        ))}
      </div>
    </header>
  );
}
