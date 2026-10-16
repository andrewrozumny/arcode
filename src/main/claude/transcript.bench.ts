/**
 * Micro-benchmarks for reading Claude Code transcripts: the feed's tail read, live poll and
 * "load earlier" on a 50 MB session, the line splitter and parser behind them, and the usage
 * summary that reads whole transcripts. The transcript is synthetic and lives in a temp folder
 * that stands in for $HOME. Run with `pnpm vitest bench`.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, bench, describe } from 'vitest';
import { readFeed } from './feed';
import { parseFeedLines, splitLines } from './feedParse';
import { projectDir } from './transcripts';
import { summarizeUsage } from './usage';

const ROOT = '/Users/bench/code/big-project';
const SESSION = '0b9c6a1e-4d2f-4b8a-9e3c-5f7a1d2c3b40';
const TARGET_BYTES = 50 * 1024 * 1024;

/** A file body of about `bytes` characters, so Read results weigh what real ones do. */
function source(bytes: number, n: number): string {
  const line = `export function handler${n}(input: Request): Response { return json(200, { ok: true, n: ${n} }); }\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

/**
 * Turns of prompt, reply, Read, Edit, Bash and a closing reply in the record format Claude Code
 * writes, repeated until the text reaches `target` bytes. Every assistant record carries usage.
 */
function makeTranscript(target: number): string {
  const out: string[] = [];
  let size = 0;
  let clock = Date.now() - 6 * 3_600_000;
  let parent: string | null = null;
  let tool = 0;
  const push = (record: Record<string, unknown>): void => {
    const uuid = randomUUID();
    clock += 2000;
    const line = JSON.stringify({ parentUuid: parent, isSidechain: false, cwd: ROOT, sessionId: SESSION, version: '2.1.0', gitBranch: 'main', uuid, timestamp: new Date(clock).toISOString(), ...record });
    out.push(line);
    size += line.length + 1;
    parent = uuid;
  };
  const usage = { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 1200 };
  const say = (content: unknown[]): void => push({ type: 'assistant', message: { id: `msg_${randomUUID().slice(0, 12)}`, role: 'assistant', model: 'claude-opus-5-5', content, usage } });
  const call = (name: string, input: Record<string, unknown>, result: string): void => {
    const id = `toolu_bench_${++tool}`;
    say([{ type: 'tool_use', id, name, input }]);
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
  };
  for (let n = 0; size < target; n++) {
    push({ type: 'user', message: { role: 'user', content: `Step ${n}: tighten the validation in src/handlers/h${n}.ts and keep the tests green.` } });
    say([{ type: 'text', text: `I'll read \`src/handlers/h${n}.ts\` first, then make the change.` }]);
    call('Read', { file_path: `${ROOT}/src/handlers/h${n}.ts` }, source(8000, n));
    call('Edit', { file_path: `${ROOT}/src/handlers/h${n}.ts`, old_string: `n: ${n} }`, new_string: `n: ${n}, checked: true }` }, 'The file has been updated successfully.');
    call('Bash', { command: 'pnpm test', description: 'Run the tests' }, ` ✓ test/h${n}.test.ts (3 tests) 6ms\n`.repeat(40));
    say([{ type: 'text', text: `Done: **h${n}** now rejects empty input.\n\n- \`src/handlers/h${n}.ts:12\` checks the body\n- tests pass` }]);
  }
  return out.join('\n') + '\n';
}

const HOME = mkdtempSync(join(tmpdir(), 'acode-bench-transcript-'));
const DIR = await projectDir(ROOT, HOME);
mkdirSync(DIR, { recursive: true });
const FILE = join(DIR, `${SESSION}.jsonl`);
const TEXT = makeTranscript(TARGET_BYTES);
writeFileSync(FILE, TEXT);
const SIZE = statSync(FILE).size;
const BYTES = Buffer.from(TEXT);
/** The window the feed's first load reads at most: the last 4 MB. */
const TAIL = BYTES.subarray(BYTES.length - 4 * 1024 * 1024);
const TAIL_LINES = splitLines(TAIL, SIZE - TAIL.length, true).lines;

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe(`feed on a ${Math.round(SIZE / 1024 / 1024)} MB transcript`, () => {
  bench('first load: tail read', async () => {
    await readFeed({ sessionId: SESSION }, HOME);
  });
  bench('load earlier from the middle', async () => {
    await readFeed({ sessionId: SESSION, before: Math.floor(SIZE / 2) }, HOME);
  });
  bench('live poll, nothing new', async () => {
    await readFeed({ sessionId: SESSION, from: SIZE }, HOME);
  });
  bench('live poll, last 64 KB new', async () => {
    await readFeed({ sessionId: SESSION, from: SIZE - 64 * 1024 }, HOME);
  });
});

describe('feed parsing, 4 MB of transcript', () => {
  bench('splitLines', () => {
    splitLines(TAIL, SIZE - TAIL.length, true);
  });
  bench('parseFeedLines', () => {
    parseFeedLines(TAIL_LINES);
  });
});

describe('usage summary', () => {
  bench(`summarizeUsage, one ${Math.round(SIZE / 1024 / 1024)} MB transcript`, async () => {
    await summarizeUsage(ROOT, HOME);
  }, { iterations: 5 });
});
