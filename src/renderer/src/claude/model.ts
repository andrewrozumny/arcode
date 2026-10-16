import type { ConfigScope, McpState } from '@shared/claude';

/** Groups are shown in this order; scopes missing from a list are skipped. */
export const SCOPE_ORDER: readonly ConfigScope[] = ['project', 'local', 'user', 'plugin', 'claudeai'];

export const SCOPE_LABELS: Record<ConfigScope, string> = {
  project: 'Project',
  local: 'Local',
  user: 'User',
  plugin: 'Plugin',
  claudeai: 'Claude.ai',
};

export interface ScopeGroup<T> {
  scope: ConfigScope;
  label: string;
  items: T[];
}

/** Case-insensitive match of the query against any of the fields; an empty query matches everything. */
export function matchesQuery(fields: ReadonlyArray<string | null | undefined>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(needle));
}

/** Splits items into scope groups in SCOPE_ORDER, keeping the input order inside each group. */
export function groupByScope<T extends { scope: ConfigScope }>(items: readonly T[]): ScopeGroup<T>[] {
  const groups: ScopeGroup<T>[] = [];
  for (const scope of SCOPE_ORDER) {
    const matching = items.filter((item) => item.scope === scope);
    if (matching.length > 0) groups.push({ scope, label: SCOPE_LABELS[scope], items: matching });
  }
  return groups;
}

export type BadgeTone = 'ok' | 'warn' | 'error' | 'muted' | 'neutral';

export interface McpBadge {
  label: string;
  tone: BadgeTone;
}

export function mcpBadge(state: McpState): McpBadge {
  switch (state) {
    case 'connected':
      return { label: 'Connected', tone: 'ok' };
    case 'needs-auth':
      return { label: 'Needs auth', tone: 'warn' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'disabled':
      return { label: 'Disabled', tone: 'muted' };
    default:
      return { label: 'Unknown', tone: 'neutral' };
  }
}
