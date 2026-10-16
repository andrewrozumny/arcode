import { describe, expect, it } from 'vitest';
import type { FeedToolDetail, FeedToolResult } from '@shared/claude';
import { phraseText, toolGroupLabel, toolPhrase } from './feedTools';
import type { ToolItem } from './feedTools';

const call = (name: string, detail: FeedToolDetail | null, summary = name): ToolItem => ({
  kind: 'tool',
  id: `${name}-${Math.random()}`,
  at: null,
  offset: 0,
  name,
  summary,
  input: '',
  detail,
});

const ok = (extra: Partial<FeedToolResult> = {}): FeedToolResult => ({ toolUseId: 'x', text: '', isError: false, ...extra });

const phrase = (item: ToolItem, result: FeedToolResult | undefined = ok()): string => phraseText(toolPhrase(item, result));

const read = (path: string) => call('Read', { type: 'read', path, offset: null, limit: null });
const bash = (command: string) => call('Bash', { type: 'bash', command, description: null, background: false });

describe('toolPhrase', () => {
  it('names reads, commands and searches', () => {
    expect(phrase(read('/repo/src/FeedView.tsx'))).toBe('Read FeedView.tsx');
    expect(phrase(call('Read', { type: 'read', path: '/r/a.ts', offset: 40, limit: 20 }))).toBe('Read a.ts (lines 40-59)');
    expect(phrase(bash('pnpm test'))).toBe('Ran `pnpm test`');
    expect(phraseText(toolPhrase(bash('pnpm test'), undefined))).toBe('Running `pnpm test`');
    expect(phraseText(toolPhrase(bash('pnpm test'), undefined, false))).toBe('Ran `pnpm test`');
    expect(phrase(call('Grep', { type: 'search', pattern: 'foo', path: null, glob: null }), ok({ matches: { count: 3, unit: 'files' } }))).toBe(
      'Searched for "foo" (3 files)',
    );
    expect(phrase(call('Glob', { type: 'search', pattern: '**/*.ts', path: null, glob: null }), ok({ matches: { count: 1, unit: 'files' } }))).toBe(
      'Found `**/*.ts` (1 file)',
    );
  });

  it('counts edit lines from the input, or from the reported patch', () => {
    const edit = call('Edit', { type: 'edit', path: '/repo/feed.css', edits: [{ oldText: 'a\nb\nc', newText: 'a\nB\nc\nd' }] });
    expect(phrase(edit)).toBe('Edited feed.css +2 -1');
    const patched = ok({ patch: [{ oldStart: 1, newStart: 1, lines: ['+x', '+y', '+z', '-w'] }] });
    expect(phrase(edit, patched)).toBe('Edited feed.css +3 -1');
    const write = call('Write', { type: 'write', path: '/repo/new.md', content: 'one\ntwo\n' });
    expect(phrase(write, ok({ created: true, patch: [] }))).toBe('Created new.md +2 -0');
  });

  it('names agents, MCP tools and task updates', () => {
    expect(phrase(call('Agent', { type: 'agent', agentType: 'Explore', description: 'Map the feed', prompt: '', model: null, background: false }))).toBe(
      'Agent: Map the feed (Explore)',
    );
    expect(phrase(call('mcp__plugin_playwright_playwright__browser_click', null))).toBe('playwright · browser_click');
    expect(phrase(call('TaskUpdate', { type: 'task', taskId: '3', subject: null, status: 'completed', activeForm: null }))).toBe('Completed task #3');
  });
});

describe('toolGroupLabel', () => {
  it('summarises a run by kind of work, counting files once', () => {
    expect(toolGroupLabel([read('/a.ts'), read('/b.ts'), read('/a.ts'), bash('ls'), bash('pwd')])).toBe('Read 2 files, ran 2 commands');
  });

  it('falls back to a tool count', () => {
    const other = call('mcp__x__y', null);
    expect(toolGroupLabel([other, other])).toBe('Used 2 tools');
    const web = call('WebFetch', { type: 'web', url: 'https://x', query: null, prompt: null });
    const grep = call('Grep', { type: 'search', pattern: 'x', path: null, glob: null });
    const edit = call('Edit', { type: 'edit', path: '/e', edits: [] });
    expect(toolGroupLabel([read('/a'), web, grep, edit])).toBe('Used 4 tools');
  });
});
