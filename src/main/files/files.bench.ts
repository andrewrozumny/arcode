/**
 * Micro-benchmarks for the file side of a large project: "go to file" ranking over the cached
 * file list and parsing `git status --porcelain=v2 -z`. Inputs are synthetic and built once per
 * run, so numbers compare across machines and commits. Run with `pnpm vitest bench`.
 */
import { bench, describe } from 'vitest';
import { aggregateDirs, parsePorcelainV2 } from './gitStatus';
import { rankPaths } from './index';

/** Deterministic pseudo-random numbers (mulberry32), so every run ranks the same list. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['api', 'auth', 'billing', 'core', 'feed', 'files', 'git', 'hooks', 'layout', 'models', 'orders', 'panel', 'search', 'session', 'shared', 'tree', 'ui', 'users', 'utils', 'viewer'];
const EXTS = ['.ts', '.tsx', '.css', '.json', '.md', '.test.ts'];

/** `count` repo-relative paths shaped like a monorepo: packages/<pkg>/src/<dir>/<file>. */
function makePaths(count: number): string[] {
  const rnd = random(42);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const depth = 1 + Math.floor(rnd() * 3);
    const dirs = Array.from({ length: depth }, () => pick(WORDS));
    const name = `${pick(WORDS)}${pick(['', 'Service', 'View', 'Store', 'Utils'])}${i % 97}${pick(EXTS)}`;
    paths.push(`packages/${pick(WORDS)}/src/${dirs.join('/')}/${name}`);
  }
  return paths;
}

const PATHS_50K = makePaths(50_000);
const PATHS_200K = makePaths(200_000);

describe('rankPaths: go to file over 50k paths', () => {
  bench('short query "fv"', () => {
    rankPaths(PATHS_50K, 'fv');
  });
  bench('typical query "feedview"', () => {
    rankPaths(PATHS_50K, 'feedview');
  });
  bench('path query "src/tree/store"', () => {
    rankPaths(PATHS_50K, 'src/tree/store');
  });
  bench('no match "zzqx"', () => {
    rankPaths(PATHS_50K, 'zzqx');
  });
});

describe('rankPaths: go to file over 200k paths', () => {
  bench('typical query "feedview"', () => {
    rankPaths(PATHS_200K, 'feedview');
  });
});

/** Porcelain v2 output with `count` records: mostly modified, some untracked, renamed and added. */
function makePorcelain(count: number): string {
  const records: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = PATHS_50K[i % PATHS_50K.length] as string;
    switch (i % 10) {
      case 0:
        records.push(`? ${path}`);
        break;
      case 1:
        records.push(`2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 ${path}`, `old/${path}`);
        break;
      case 2:
        records.push(`1 A. N... 000000 100644 100644 0000000 bbbbbbb ${path}`);
        break;
      default:
        records.push(`1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb ${path}`);
    }
  }
  return records.join('\0') + '\0';
}

const STATUS_1K = makePorcelain(1_000);
const STATUS_20K = makePorcelain(20_000);
const PARSED_20K = parsePorcelainV2(STATUS_20K);

describe('git status porcelain v2', () => {
  bench('parse 1k changed files', () => {
    parsePorcelainV2(STATUS_1K);
  });
  bench('parse 20k changed files', () => {
    parsePorcelainV2(STATUS_20K);
  });
  bench('changed folders of 20k files', () => {
    aggregateDirs(PARSED_20K);
  });
});
