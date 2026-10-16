import { join } from 'node:path';
import type { MemoryFile } from '@shared/claude';
import { readText } from './common';

/** The CLAUDE.md files that shape this project's sessions. Read-only; content is null when missing. */
export function listMemory(root: string, home: string): MemoryFile[] {
  const files: { label: string; path: string }[] = [
    { label: 'Global CLAUDE.md', path: join(home, '.claude', 'CLAUDE.md') },
    { label: 'Project CLAUDE.md', path: join(root, 'CLAUDE.md') },
    { label: 'Local CLAUDE.local.md', path: join(root, 'CLAUDE.local.md') },
  ];
  return files.map((f) => ({ ...f, content: readText(f.path) }));
}
