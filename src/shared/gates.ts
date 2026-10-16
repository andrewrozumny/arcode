/** Plain-language gates overview: which checks exist and which parts of the code have tests. No Electron imports. */
import { GATE_TARGETS } from './app';
import type { GateTarget } from './app';
import type { CoverageArea, GateInfo } from './claude';

interface GateDef {
  /** Package scripts the gate needs; a missing one makes the gate incomplete. */
  required: string[];
  /** Package scripts the gate runs when present, in order. */
  steps: string[];
  explanation: string;
}

/** Mirrors scripts/gates.sh: lint runs lint and typecheck, test runs test, build runs build. */
const GATE_DEFS: Record<GateTarget, GateDef> = {
  all: {
    required: ['lint', 'test', 'build'],
    steps: ['lint', 'typecheck', 'test', 'build'],
    explanation: 'Everything: lint, types, tests and the build. The full check before you call a change done.',
  },
  lint: {
    required: ['lint'],
    steps: ['lint', 'typecheck'],
    explanation: 'Code style and common mistakes (ESLint) plus type checking (TypeScript).',
  },
  test: {
    required: ['test'],
    steps: ['test'],
    explanation: 'Automated tests.',
  },
  build: {
    required: ['build'],
    steps: ['build'],
    explanation: 'Builds the app without running it.',
  },
  deploy: {
    required: ['lint', 'test', 'build'],
    steps: ['lint', 'typecheck', 'test', 'build'],
    explanation:
      'A preflight only: lint, types, tests and the build. This gate never deploys; shipping stays a manual step.',
  },
};

/** Builds the gate list from the package.json scripts. `pm` is the package manager name from the lockfile. */
export function buildGates(scripts: Record<string, string>, pm: string): GateInfo[] {
  const has = (name: string): boolean => typeof scripts[name] === 'string' && scripts[name].trim() !== '';
  return GATE_TARGETS.map((target) => {
    const def = GATE_DEFS[target];
    return {
      target,
      commands: def.steps.filter(has).map((step) => `${pm} run ${step}`),
      missing: def.required.filter((name) => !has(name)),
      explanation: def.explanation,
    };
  });
}

/** Human names for the areas we know; other folders use their own name. */
const AREA_NAMES: Record<string, string> = {
  'src/main/files': 'Project files and tree',
  'src/main/terminal': 'Terminal and Claude sessions',
  'src/main/claude': 'Claude panel (settings, sessions, limits)',
  'src/main/ide': 'IDE bridge',
  'src/main/viewer': 'File viewer',
  'src/main/projects': 'Project list',
  'src/main/state': 'Saved window state',
  'src/main': 'Main process: windows and startup',
  'src/shared': 'Shared types and rules',
  'src/preload': 'Preload bridge',
  'src/renderer/src/claude': 'Claude panel (UI)',
  'src/renderer/src/terminal': 'Terminal (UI)',
  'src/renderer/src/tree': 'File tree (UI)',
  'src/renderer/src/viewer': 'File viewer (UI)',
  'src/renderer/src/layout': 'Window layout',
  'src/renderer/src/theme': 'Theme and fonts',
  'src/renderer/src': 'UI: root files',
};

/** Folders whose subfolders count as separate areas; files sitting directly in them form one more area. */
export const AREA_ROOTS: readonly string[] = ['src/main', 'src/preload', 'src/shared', 'src/renderer/src'];

export function areaName(folder: string): string {
  return AREA_NAMES[folder] ?? folder.split('/').slice(-1)[0] ?? folder;
}

/** Counts `it(` and `test(` calls. An approximation: it also counts matches inside comments and strings. */
export function countTests(text: string): number {
  return (text.match(/\b(?:it|test)(?:\.(?:only|skip|todo))?\(/g) ?? []).length;
}

/**
 * Groups test files by the most specific area folder that contains them.
 * `folders` lists every area folder, including the empty ones, so untested areas show up too.
 */
export function coverageAreas(folders: string[], testFiles: { path: string; text: string }[]): CoverageArea[] {
  const counts = new Map(folders.map((folder) => [folder, { testFiles: 0, tests: 0 }]));
  for (const file of testFiles) {
    let best: string | null = null;
    for (const folder of folders) {
      if (file.path.startsWith(`${folder}/`) && (best === null || folder.length > best.length)) best = folder;
    }
    if (best === null) continue;
    const entry = counts.get(best);
    if (!entry) continue;
    entry.testFiles += 1;
    entry.tests += countTests(file.text);
  }
  return folders
    .map((folder) => ({ name: areaName(folder), folder, testFiles: counts.get(folder)?.testFiles ?? 0, tests: counts.get(folder)?.tests ?? 0 }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

export const RESULT_NOTE =
  'Gate results are not stored here: each run and its outcome stay in its terminal tab (the Gate buttons in the header).';
