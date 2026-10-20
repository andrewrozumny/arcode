import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { existingFiles } from './existing';

describe('existingFiles', () => {
  it('keeps regular files inside the root in order and drops the rest', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'arcode-existing-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'arcode-outside-')));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/a.ts'), 'a');
    writeFileSync(join(root, 'b.md'), 'b');
    writeFileSync(join(outside, 'secret.txt'), 's');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const result = await existingFiles(root, ['b.md', 'gone.ts', 'src', 'src/a.ts', '../x', 'link.txt']);
    expect(result).toEqual(['b.md', 'src/a.ts']);
  });
});
