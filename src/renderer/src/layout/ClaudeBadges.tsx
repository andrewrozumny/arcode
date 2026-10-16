import type { SubagentInfo } from '@shared/claude';
import type { BadgeModel } from '../claude/liveUsage';
import { shortAge } from '../format';
import { modelFamily } from './modelFamily';

/** `claude-opus-5-5` -> `Opus 5.5`; unknown shapes are shown as they are. */
export function modelLabel(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (!match?.[1]) return id;
  const family = match[1];
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`;
}

export function ModelBadge({ model }: { model: BadgeModel }) {
  return (
    <span className={`model-badge family-${modelFamily(model.id)}`} title={model.id}>
      {model.name ?? modelLabel(model.id)}
    </span>
  );
}

/** `⤷ 2 agents` with one family-coloured dot per running subagent; the tooltip names them. */
export function AgentsChip({ agents }: { agents: readonly SubagentInfo[] }) {
  const title = agents
    .map((a) => `${a.label ?? a.agentType ?? a.id} · ${a.modelName ?? (a.model ? modelLabel(a.model) : 'model unknown')} · ${shortAge(a.startedAt)}`)
    .join('\n');
  return (
    <span className="agents-chip" title={title}>
      <span className="agents-chip-dots" aria-hidden="true">
        {agents.map((a) => (
          <span key={a.id} className={`agents-chip-dot model-family-${a.model ? modelFamily(a.model) : 'other'}`} />
        ))}
      </span>
      ⤷ {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
    </span>
  );
}
