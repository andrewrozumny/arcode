/**
 * Synthetic inputs for the app-level benchmarks, layered on the demo sandbox: a shell hook that
 * stamps the first prompt, a stand-in `claude` that keeps resumed transcripts, a transcript of
 * tens of megabytes and a project with tens of thousands of files. All of it lives in the sandbox.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { buildSandbox } from '../demo/sandbox.mjs';
import { BENCH_DIR } from './lib.mjs';

/** Text of the last reply in a grown transcript; the feed has rendered once this is on screen. */
export const TAIL_MARKER = 'Benchmark tail reached';

const slugOf = (root) => root.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * A fresh demo sandbox in BENCH_DIR/<name>. The shell writes the time of its first prompt
 * (epoch seconds, from zsh's $EPOCHREALTIME) to ~/.prompt-ready, which is how "terminal ready"
 * is measured without reading the terminal canvas.
 */
export function benchSandbox(name) {
  const sandbox = buildSandbox(join(BENCH_DIR, name));
  appendFileSync(
    join(sandbox.home, '.zshrc'),
    [
      'zmodload zsh/datetime',
      '_acode_bench_ready() { [[ -f "$HOME/.prompt-ready" ]] || print -r -- "$EPOCHREALTIME" > "$HOME/.prompt-ready"; }',
      'precmd_functions+=(_acode_bench_ready)',
      '',
    ].join('\n'),
  );
  return sandbox;
}

/** Epoch ms of the first shell prompt, or null when no prompt has been drawn yet. */
export function promptReadyAt(sandbox) {
  try {
    const seconds = Number(readFileSync(join(sandbox.home, '.prompt-ready'), 'utf8').trim());
    // The file can be read while zsh is still writing it: empty means not yet.
    return seconds > 0 ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}

export function transcriptPath(sandbox, sessionId = sandbox.sessionId) {
  return join(sandbox.home, '.claude', 'projects', slugOf(sandbox.root), `${sessionId}.jsonl`);
}

/**
 * The sandbox's stand-in `claude` serves the demo conversation under whatever session id it is
 * started with. Make it leave sessions that already have a transcript alone, so a resumed
 * benchmark session stays as written: right after argument parsing, such an id is taken as is.
 */
export function keepResumedTranscripts(sandbox) {
  const file = join(sandbox.bin, 'claude');
  const text = readFileSync(file, 'utf8');
  const loopEnd = text.indexOf('\ndone\n');
  if (loopEnd < 0 || !text.includes('NEW="$2"')) throw new Error('unexpected stand-in claude script');
  const keep = 'if [ -n "$NEW" ] && ls "$HOME"/.claude/projects/*/"$NEW".jsonl >/dev/null 2>&1; then SID="$NEW"; NEW=""; fi\n';
  const at = loopEnd + '\ndone\n'.length;
  writeFileSync(file, text.slice(0, at) + keep + text.slice(at));
}

/** A file body of about `bytes` characters, so Read results weigh what real ones do. */
function source(bytes, n) {
  const line = `export function handler${n}(input: Request): Response { return json(200, { ok: true, n: ${n} }); }\n`;
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

/**
 * Writes turns (prompt, reply, Read, Edit, Bash, reply) to the transcript of `sessionId` in the
 * sandbox project until it is `targetBytes` long, ending with a reply that contains TAIL_MARKER.
 * An existing transcript is appended to. Returns the final size.
 */
export function growTranscript(sandbox, targetBytes, sessionId = sandbox.sessionId) {
  const file = transcriptPath(sandbox, sessionId);
  const root = sandbox.root;
  let size = existsSync(file) ? readFileSync(file).length : 0;
  const fd = openSync(file, 'a');
  let clock = Date.now() - 6 * 3_600_000;
  let parent = null;
  let tool = 0;
  let buffer = [];
  const flush = () => {
    if (buffer.length) writeSync(fd, buffer.join(''));
    buffer = [];
  };
  const push = (record) => {
    const uuid = randomUUID();
    clock += 1000;
    const line = JSON.stringify({ parentUuid: parent, isSidechain: false, cwd: root, sessionId, version: '2.1.0', gitBranch: 'main', uuid, timestamp: new Date(clock).toISOString(), ...record }) + '\n';
    buffer.push(line);
    size += Buffer.byteLength(line);
    parent = uuid;
    if (buffer.length >= 500) flush();
  };
  const usage = { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 1200 };
  const say = (content) => push({ type: 'assistant', message: { id: `msg_${randomUUID().slice(0, 12)}`, role: 'assistant', model: 'claude-opus-5-5', content, usage } });
  const call = (name, input, result) => {
    const id = `toolu_bench_${++tool}`;
    say([{ type: 'tool_use', id, name, input }]);
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: false }] } });
  };
  for (let n = 0; size < targetBytes; n++) {
    push({ type: 'user', message: { role: 'user', content: `Step ${n}: tighten the validation in src/handlers/h${n}.ts and keep the tests green.` } });
    say([{ type: 'text', text: `I'll read \`src/handlers/h${n}.ts\` first, then make the change.` }]);
    call('Read', { file_path: `${root}/src/handlers/h${n}.ts` }, source(8000, n));
    call('Edit', { file_path: `${root}/src/handlers/h${n}.ts`, old_string: `n: ${n} }`, new_string: `n: ${n}, checked: true }` }, 'The file has been updated successfully.');
    call('Bash', { command: 'pnpm test', description: 'Run the tests' }, ` ✓ test/h${n}.test.ts (3 tests) 6ms\n`.repeat(40));
    say([{ type: 'text', text: `Done: **h${n}** now rejects empty input.\n\n- \`src/handlers/h${n}.ts:12\` checks the body\n- tests pass` }]);
  }
  push({ type: 'user', message: { role: 'user', content: 'Wrap up.' } });
  say([{ type: 'text', text: `${TAIL_MARKER}: all steps are done.` }]);
  flush();
  closeSync(fd);
  return size;
}

/**
 * A committed git repository with `files` small TypeScript files spread over nested folders
 * (src/m<NN>/s<NN>/feature<i>.ts), plus `flatDirs` folders flat1, flat2... with `flat` files each. File names
 * are unique, so a query like "feature12345" has exactly one best match.
 */
export function bigProject(sandbox, { files, flat, flatDirs = 1 }) {
  const root = join(sandbox.home, 'code', 'big-project');
  mkdirSync(root, { recursive: true });
  const perDir = 50;
  for (let i = 0; i < files; i++) {
    const dir = join(root, 'src', `m${String(Math.floor(i / (perDir * 20))).padStart(2, '0')}`, `s${String(Math.floor(i / perDir) % 20).padStart(2, '0')}`);
    if (i % perDir === 0) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `feature${i}.ts`), `export const feature${i} = ${i};\n`);
  }
  for (let d = 1; d <= flatDirs; d++) {
    mkdirSync(join(root, `flat${d}`), { recursive: true });
    for (let i = 0; i < flat; i++) writeFileSync(join(root, `flat${d}`, `entry-${String(i).padStart(5, '0')}.ts`), `export const e${i} = ${i};\n`);
  }
  writeFileSync(join(root, 'README.md'), '# big-project\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Bench', '-c', 'user.email=bench@example.com', ...args], { cwd: root, stdio: 'ignore', env });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Generated');
  return root;
}
