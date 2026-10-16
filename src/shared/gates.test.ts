import { describe, expect, it } from 'vitest';
import { buildGates, countTests, coverageAreas } from './gates';

describe('buildGates', () => {
  const scripts = { lint: 'eslint .', typecheck: 'tsc', test: 'vitest run', build: 'electron-vite build' };

  it('lists every gate in order with its commands', () => {
    const gates = buildGates(scripts, 'pnpm');
    expect(gates.map((g) => g.target)).toEqual(['all', 'lint', 'test', 'build', 'deploy']);
    expect(gates.find((g) => g.target === 'lint')?.commands).toEqual(['pnpm run lint', 'pnpm run typecheck']);
    expect(gates.find((g) => g.target === 'all')?.missing).toEqual([]);
  });

  it('marks a gate as missing the scripts it needs', () => {
    const gates = buildGates({ test: 'vitest run' }, 'npm');
    expect(gates.find((g) => g.target === 'build')?.missing).toEqual(['build']);
    expect(gates.find((g) => g.target === 'build')?.commands).toEqual([]);
    expect(gates.find((g) => g.target === 'all')?.missing).toEqual(['lint', 'build']);
  });

  it('says plainly that deploy does not deploy', () => {
    const deploy = buildGates(scripts, 'pnpm').find((g) => g.target === 'deploy');
    expect(deploy?.explanation).toContain('never deploys');
  });
});

describe('countTests', () => {
  it('counts it and test calls, including skip and only variants', () => {
    const text = "describe('x', () => {\n  it('a', () => {});\n  test('b', () => {});\n  it.skip('c', () => {});\n});";
    expect(countTests(text)).toBe(3);
  });

  it('returns zero for files without tests', () => {
    expect(countTests('export const x = 1;')).toBe(0);
  });
});

describe('coverageAreas', () => {
  it('attributes each test file to its most specific folder', () => {
    const areas = coverageAreas(
      ['src/main', 'src/main/files', 'src/shared'],
      [
        { path: 'src/main/files/index.test.ts', text: "it('a', () => {}); it('b', () => {});" },
        { path: 'src/main/root.test.ts', text: "it('c', () => {});" },
      ],
    );
    expect(areas.find((a) => a.folder === 'src/main/files')).toMatchObject({ testFiles: 1, tests: 2 });
    expect(areas.find((a) => a.folder === 'src/main')).toMatchObject({ testFiles: 1, tests: 1 });
  });

  it('keeps folders without tests so they show as untested', () => {
    const areas = coverageAreas(['src/shared'], []);
    expect(areas).toEqual([{ name: 'Shared types and rules', folder: 'src/shared', testFiles: 0, tests: 0 }]);
  });
});
