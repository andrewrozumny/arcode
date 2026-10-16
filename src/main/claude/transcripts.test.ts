import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSubagentsDir, isSessionId, parseJsonLine, parseJsonLines, readTail } from './transcripts';

describe('transcript helpers', () => {
  it('accepts session ids and refuses path-like values', () => {
    expect(isSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(isSessionId('../etc/passwd')).toBe(false);
    expect(isSessionId(42)).toBe(false);
  });

  it('parses object lines and skips blank, cut and non-object lines', () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine('  ')).toBeNull();
    expect(parseJsonLine('"a":1}')).toBeNull();
    expect(parseJsonLine('[1,2]')).toBeNull();
    expect(parseJsonLines('{"a":1}\nnull\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reads the tail of a file', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'acode-tail-'));
    const file = join(dir, 'a.txt');
    writeFileSync(file, '0123456789');
    expect(await readTail(file, 10, 4)).toBe('6789');
    expect(await readTail(file, 10, 64)).toBe('0123456789');
  });

  it('finds a session subagents folder in any project folder', async () => {
    const home = mkdtempSync(join(os.tmpdir(), 'acode-sub-'));
    const id = '123e4567-e89b-12d3-a456-426614174000';
    const dir = join(home, '.claude', 'projects', '-work-app', id, 'subagents');
    mkdirSync(dir, { recursive: true });
    expect(await findSubagentsDir(id, home)).toBe(dir);
    expect(await findSubagentsDir('../x', home)).toBeNull();
  });
});
