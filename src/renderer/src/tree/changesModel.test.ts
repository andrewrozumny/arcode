import { describe, expect, it } from 'vitest';
import type { ChangedFile, GitStatusCode } from '@shared/files';
import { buildChangeRows, firstFile, orderedFiles, statusClass, statusLetter, stepFile, summaryLine, totals } from './changesModel';

const file = (path: string, status: GitStatusCode = 'M', added: number | null = 1, deleted: number | null = 0): ChangedFile => ({
  path,
  status,
  added,
  deleted,
  binary: false,
});

describe('buildChangeRows', () => {
  it('groups by folder: root files first, folders by path, files by name', () => {
    const rows = buildChangeRows([file('src/b.ts'), file('z.md'), file('docs/x.md'), file('src/a.ts'), file('a.md'), file('src/util/c.ts')]);
    expect(rows.map((r) => (r.kind === 'dir' ? `[${r.dir}] ${r.count}` : r.name))).toEqual([
      '[] 2',
      'a.md',
      'z.md',
      '[docs] 1',
      'x.md',
      '[src] 2',
      'a.ts',
      'b.ts',
      '[src/util] 1',
      'c.ts',
    ]);
  });

  it('sorts names case-insensitively and numerically', () => {
    const rows = buildChangeRows([file('f10.ts'), file('F2.ts'), file('e.ts')]);
    expect(orderedFiles(rows).map((f) => f.path)).toEqual(['e.ts', 'F2.ts', 'f10.ts']);
  });

  it('returns no rows for no files', () => {
    expect(buildChangeRows([])).toEqual([]);
  });
});

describe('stepFile', () => {
  const rows = buildChangeRows([file('a.ts'), file('src/b.ts'), file('src/c.ts')]);
  it('skips folder rows and stops at both ends', () => {
    const first = firstFile(rows);
    expect(first).toBe(1);
    const second = stepFile(rows, first, 1);
    expect(rows[second]?.kind === 'file' && rows[second].file.path).toBe('src/b.ts');
    expect(stepFile(rows, second, -1)).toBe(first);
    expect(stepFile(rows, first, -1)).toBe(first);
    const last = stepFile(rows, second, 1);
    expect(stepFile(rows, last, 1)).toBe(last);
    expect(stepFile(rows, -1, 1)).toBe(first);
  });
});

describe('totals and summary', () => {
  it('adds up counts, treating unknown as zero', () => {
    const t = totals([file('a', 'M', 3, 1), file('b', '?', 10, 0), file('c', 'M', null, null)]);
    expect(t).toEqual({ files: 3, added: 13, deleted: 1 });
    expect(summaryLine(t)).toBe('3 files');
    expect(summaryLine({ files: 1, added: 0, deleted: 0 })).toBe('1 file');
    expect(summaryLine({ files: 0, added: 0, deleted: 0 })).toBe('No changes');
  });
});

describe('status letters', () => {
  it('maps codes to letters and the tree colour classes', () => {
    expect(statusLetter('?')).toBe('U');
    expect(statusLetter('U')).toBe('!');
    expect(statusLetter('D')).toBe('D');
    expect(statusClass('?')).toBe('git-untracked');
    expect(statusClass('R')).toBe('git-R');
  });
});
