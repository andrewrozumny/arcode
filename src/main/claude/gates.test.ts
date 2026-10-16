import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGatesOverview } from './gates';

describe('readGatesOverview', () => {
  it('survives broken symlinks and symlink loops under src', () => {
    const root = mkdtempSync(join(os.tmpdir(), 'acode-gates-'));
    mkdirSync(join(root, 'src', 'main', 'files'), { recursive: true });
    writeFileSync(join(root, 'src', 'main', 'files', 'a.test.ts'), "it('a', () => {});\n");
    symlinkSync(join(root, 'nowhere'), join(root, 'src', 'main', 'broken'));
    symlinkSync(join(root, 'src'), join(root, 'src', 'main', 'files', 'loop'));
    const overview = readGatesOverview(root);
    const files = overview.areas.find((a) => a.folder === 'src/main/files');
    expect(files?.tests).toBe(1);
  });
});
