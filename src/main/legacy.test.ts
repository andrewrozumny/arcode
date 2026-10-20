import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateLegacyUserData } from './legacy';

function appData(): string {
  return mkdtempSync(join(tmpdir(), 'arcode-legacy-'));
}

describe('migrateLegacyUserData', () => {
  it('copies state, usage records and local storage from the old folder', () => {
    const root = appData();
    mkdirSync(join(root, 'Acode', 'usage'), { recursive: true });
    writeFileSync(join(root, 'Acode', 'state.json'), '{"recent":[]}');
    writeFileSync(join(root, 'Acode', 'usage', 's1.json'), '{}');
    const userData = join(root, 'ARcode');
    mkdirSync(userData);
    expect(migrateLegacyUserData(root, userData)).toBe(true);
    expect(readFileSync(join(userData, 'state.json'), 'utf8')).toBe('{"recent":[]}');
    expect(readFileSync(join(userData, 'usage', 's1.json'), 'utf8')).toBe('{}');
  });

  it('never overwrites existing state', () => {
    const root = appData();
    mkdirSync(join(root, 'Acode'));
    writeFileSync(join(root, 'Acode', 'state.json'), 'old');
    mkdirSync(join(root, 'ARcode'));
    writeFileSync(join(root, 'ARcode', 'state.json'), 'new');
    expect(migrateLegacyUserData(root, join(root, 'ARcode'))).toBe(false);
    expect(readFileSync(join(root, 'ARcode', 'state.json'), 'utf8')).toBe('new');
  });

  it('leaves a custom data folder alone', () => {
    const root = appData();
    mkdirSync(join(root, 'Acode'));
    writeFileSync(join(root, 'Acode', 'state.json'), 'old');
    expect(migrateLegacyUserData(root, join(tmpdir(), 'elsewhere', 'data'))).toBe(false);
  });

  it('does nothing without a legacy folder', () => {
    const root = appData();
    expect(migrateLegacyUserData(root, join(root, 'ARcode'))).toBe(false);
  });
});
