/**
 * Builds a throwaway demo environment for screenshots and benchmarks:
 *
 *   <dir>/home      a fake $HOME with a ~/.claude that holds one made-up Claude Code session,
 *                   skills, agents, hooks, MCP servers and a global CLAUDE.md
 *   <dir>/home/code/orbit-api
 *                   a small git repository with uncommitted changes
 *   <dir>/bin       a stand-in `claude` that registers itself the way Claude Code does
 *   <dir>/userData  ARcode's own state, kept apart from an installed ARcode
 *
 * Nothing here touches the real home folder, and no model is ever called.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const slugOf = (root) => root.replace(/[^a-zA-Z0-9]/g, '-');

const PROJECT_FILES = {
  'package.json': JSON.stringify(
    {
      name: 'orbit-api',
      version: '0.4.0',
      private: true,
      type: 'module',
      scripts: { dev: 'tsx watch src/server.ts', lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc -p .' },
    },
    null,
    2,
  ),
  'README.md': `# Orbit API

A tiny HTTP service that schedules satellite passes over ground stations.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| \`GET\` | \`/passes\` | Upcoming passes for a station |
| \`POST\` | \`/stations\` | Register a ground station |
| \`GET\` | \`/health\` | Liveness probe |

## Running locally

\`\`\`bash
pnpm install
pnpm dev        # http://localhost:8080
\`\`\`

> Passes are computed from TLE data refreshed every six hours.

- [x] Station registry
- [x] Pass prediction
- [ ] Rate limiting per API key
`,
  'CLAUDE.md': `# Orbit API

- TypeScript, Node 22, no framework: \`src/server.ts\` routes by hand.
- Run \`scripts/gates.sh all\` before you say a change is done.
- Times are UTC everywhere; never format dates in the server.
`,
  '.gitignore': 'node_modules/\ndist/\n.env\n',
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', strict: true, outDir: 'dist' } }, null, 2),
  'scripts/gates.sh': '#!/usr/bin/env bash\nset -e\ncase "${1:-all}" in\n  lint) pnpm lint ;;\n  test) pnpm test ;;\n  build) tsc -p . ;;\n  all) pnpm lint && pnpm test && tsc -p . ;;\nesac\n',
  'src/server.ts': `import { createServer } from 'node:http';
import { listPasses } from './passes.js';
import { registerStation, findStation } from './stations.js';
import { json, readBody } from './http.js';

const PORT = Number(process.env.PORT ?? 8080);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', \`http://\${req.headers.host}\`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/passes') {
    const station = findStation(url.searchParams.get('station') ?? '');
    if (!station) return json(res, 404, { error: 'unknown station' });
    const hours = Number(url.searchParams.get('hours') ?? 24);
    return json(res, 200, await listPasses(station, hours));
  }

  if (req.method === 'POST' && url.pathname === '/stations') {
    const body = await readBody(req);
    return json(res, 201, registerStation(body));
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(\`orbit-api listening on :\${PORT}\`);
});
`,
  'src/passes.ts': `import type { Station } from './stations.js';
import { loadTle, propagate } from './tle.js';

export interface Pass {
  satellite: string;
  rise: string;
  set: string;
  maxElevation: number;
}

/** Passes above 10 degrees for the next \`hours\` hours, soonest first. */
export async function listPasses(station: Station, hours: number): Promise<Pass[]> {
  const catalog = await loadTle();
  const until = Date.now() + hours * 3_600_000;
  const passes: Pass[] = [];
  for (const sat of catalog) {
    for (const window of propagate(sat, station, until)) {
      if (window.maxElevation < 10) continue;
      passes.push({
        satellite: sat.name,
        rise: new Date(window.rise).toISOString(),
        set: new Date(window.set).toISOString(),
        maxElevation: Math.round(window.maxElevation),
      });
    }
  }
  return passes.sort((a, b) => a.rise.localeCompare(b.rise));
}
`,
  'src/stations.ts': `export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

const stations = new Map<string, Station>();

export function registerStation(input: unknown): Station {
  const { name, lat, lon } = input as Partial<Station>;
  if (typeof name !== 'string' || typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error('name, lat and lon are required');
  }
  const station = { id: crypto.randomUUID(), name, lat, lon };
  stations.set(station.id, station);
  return station;
}

export function findStation(id: string): Station | undefined {
  return stations.get(id);
}
`,
  'src/http.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
`,
  'src/tle.ts': `export interface Satellite {
  name: string;
  line1: string;
  line2: string;
}

export interface Window {
  rise: number;
  set: number;
  maxElevation: number;
}

let cache: { at: number; sats: Satellite[] } | null = null;

export async function loadTle(): Promise<Satellite[]> {
  if (cache && Date.now() - cache.at < 6 * 3_600_000) return cache.sats;
  const text = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle').then((r) => r.text());
  const lines = text.trim().split('\\n');
  const sats: Satellite[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    sats.push({ name: lines[i].trim(), line1: lines[i + 1], line2: lines[i + 2] });
  }
  cache = { at: Date.now(), sats };
  return sats;
}

export function* propagate(_sat: Satellite, _station: { lat: number; lon: number }, _until: number): Generator<Window> {
  // Simplified for the demo: the real SGP4 propagation lives in a separate package.
}
`,
  'test/passes.test.ts': `import { describe, expect, it } from 'vitest';
import { listPasses } from '../src/passes.js';

describe('listPasses', () => {
  it('returns passes sorted by rise time', async () => {
    const passes = await listPasses({ id: 'x', name: 'Kyiv', lat: 50.45, lon: 30.52 }, 24);
    expect(passes).toEqual([...passes].sort((a, b) => a.rise.localeCompare(b.rise)));
  });
});
`,
  'docs/architecture.md': '# Architecture\n\nOne process, no database: stations live in memory and TLE data is cached for six hours.\n',
  '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews a diff for correctness bugs before it is committed.\nmodel: sonnet\n---\nYou review diffs.\n',
  '.claude/skills/release/SKILL.md': '---\nname: release\ndescription: Bump the version, update the changelog and tag the release.\n---\nSteps...\n',
  '.mcp.json': JSON.stringify({ mcpServers: { postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgres://localhost/orbit'] } } }, null, 2),
};

/** Edits applied after the initial commit, so the tree shows changes and the viewer has a diff. */
const PROJECT_CHANGES = {
  'src/passes.ts': PROJECT_FILES['src/passes.ts']
    .replace('/** Passes above 10 degrees', '/** Passes above `minElevation` degrees (10 by default)')
    .replace('hours: number): Promise<Pass[]>', 'hours: number, minElevation = 10): Promise<Pass[]>')
    .replace('if (window.maxElevation < 10) continue;', 'if (window.maxElevation < minElevation) continue;'),
  'src/server.ts': PROJECT_FILES['src/server.ts'].replace(
    "    return json(res, 200, await listPasses(station, hours));",
    "    const minElevation = Number(url.searchParams.get('min') ?? 10);\n    return json(res, 200, await listPasses(station, hours, minElevation));",
  ),
  'src/rateLimit.ts': `/** Fixed-window rate limit per API key. */
const windows = new Map<string, { start: number; count: number }>();

export function allow(key: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= limit;
}
`,
};

/** A made-up Claude Code conversation in the transcript format Claude Code writes. */
function transcript(root, sessionId) {
  const records = [];
  let clock = Date.parse('2026-10-15T09:12:00.000Z');
  let parent = null;
  const push = (record) => {
    const uuid = randomUUID();
    clock += 4000;
    records.push({ parentUuid: parent, isSidechain: false, cwd: root, sessionId, version: '2.1.0', gitBranch: 'main', uuid, timestamp: new Date(clock).toISOString(), ...record });
    parent = uuid;
  };
  const usage = (input, output, cacheRead) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 1200 });
  const say = (content, u) => push({ type: 'assistant', message: { id: `msg_${randomUUID().slice(0, 8)}`, role: 'assistant', model: 'claude-opus-5-5', content, usage: u ?? usage(800, 220, 18000) } });
  const prompt = (text) => push({ type: 'user', message: { role: 'user', content: text } });
  let toolN = 0;
  const tool = (name, input, result, isError = false) => {
    const id = `toolu_demo_${++toolN}`;
    say([{ type: 'tool_use', id, name, input }]);
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: isError }] } });
  };

  prompt('Let callers of /passes pick the minimum elevation. Keep 10 degrees as the default.');
  say([{ type: 'text', text: "I'll read how passes are filtered today, then thread a `min` query parameter through." }]);
  tool('Read', { file_path: `${root}/src/passes.ts` }, PROJECT_FILES['src/passes.ts']);
  tool('Grep', { pattern: 'listPasses', path: `${root}/src` }, 'src/server.ts\nsrc/passes.ts');
  tool(
    'TodoWrite',
    {
      todos: [
        { content: 'Add minElevation parameter to listPasses', status: 'completed', activeForm: 'Adding minElevation parameter' },
        { content: 'Read ?min= in the /passes route', status: 'completed', activeForm: 'Reading ?min= in the route' },
        { content: 'Run the gates', status: 'in_progress', activeForm: 'Running the gates' },
      ],
    },
    'Todos have been modified successfully.',
  );
  tool(
    'Edit',
    {
      file_path: `${root}/src/passes.ts`,
      old_string: 'export async function listPasses(station: Station, hours: number): Promise<Pass[]> {',
      new_string: 'export async function listPasses(station: Station, hours: number, minElevation = 10): Promise<Pass[]> {',
    },
    'The file has been updated successfully.',
  );
  tool(
    'Edit',
    {
      file_path: `${root}/src/passes.ts`,
      old_string: '      if (window.maxElevation < 10) continue;',
      new_string: '      if (window.maxElevation < minElevation) continue;',
    },
    'The file has been updated successfully.',
  );
  tool(
    'Edit',
    {
      file_path: `${root}/src/server.ts`,
      old_string: '    return json(res, 200, await listPasses(station, hours));',
      new_string: "    const minElevation = Number(url.searchParams.get('min') ?? 10);\n    return json(res, 200, await listPasses(station, hours, minElevation));",
    },
    'The file has been updated successfully.',
  );
  tool('Bash', { command: 'scripts/gates.sh test', description: 'Run the test gate' }, ' ✓ test/passes.test.ts (1 test) 4ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Duration  312ms');
  say(
    [
      {
        type: 'text',
        text:
          'Done. `/passes` now accepts `?min=<degrees>`:\n\n' +
          '```http\nGET /passes?station=kyiv&hours=12&min=25\n```\n\n' +
          '- `listPasses(station, hours, minElevation = 10)` in `src/passes.ts:13` keeps the old behaviour when the parameter is missing.\n' +
          '- The route parses `min` next to `hours` in `src/server.ts:19`.\n\n' +
          'Tests pass. One open question: should a `min` above 90 be rejected with a 400 instead of returning an empty list?',
      },
    ],
    usage(1200, 640, 22000),
  );
  prompt('Yes, reject it. And add a simple rate limit per API key while you are there.');
  say([{ type: 'text', text: 'Rate limiting is a new module, so I will sketch it first and wire it into the server after the validation change.' }]);
  tool('Write', { file_path: `${root}/src/rateLimit.ts`, content: PROJECT_CHANGES['src/rateLimit.ts'] }, 'File created successfully.');
  tool('Bash', { command: 'pnpm vitest run --reporter=dot', description: 'Run all tests' }, '·\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)');
  say([{ type: 'text', text: 'The fixed-window limiter is in `src/rateLimit.ts`. Next I am adding the 400 for `min > 90`.' }]);
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * Stand-in for the `claude` CLI: registers itself in ~/.claude/sessions/<pid>.json exactly like
 * Claude Code does, prints a welcome screen and stays alive until the terminal closes.
 */
const FAKE_CLAUDE = `#!/bin/bash
SID="__SESSION__"
if [ "$1" = "mcp" ]; then
  echo "Checking MCP server health..."
  echo
  echo "github: https://api.githubcopilot.com/mcp/ (HTTP) - ✔ Connected"
  echo "playwright: npx @playwright/mcp@latest - ✔ Connected"
  echo "postgres: npx -y @modelcontextprotocol/server-postgres postgres://localhost/orbit - ✘ Failed to connect"
  exit 0
fi
# ARcode starts Claude tabs with --session-id <new id> or --resume <id>: serve the demo conversation under that id.
while [ $# -gt 0 ]; do
  case "$1" in --session-id|--resume) NEW="$2"; shift ;; esac
  shift
done
if [ -n "$NEW" ] && [ "$NEW" != "$SID" ]; then
  DEMO="$(ls "$HOME"/.claude/projects/*/"$SID".jsonl | head -1)"
  mv "$DEMO" "$(dirname "$DEMO")/$NEW.jsonl"
  SID="$NEW"
fi
mkdir -p "$HOME/.claude/sessions"
REG="$HOME/.claude/sessions/$$.json"
printf '{"pid":%d,"sessionId":"%s","cwd":"%s","status":"%s","startedAt":%d}' $$ "$SID" "$PWD" "\${ARCODE_DEMO_STATUS:-idle}" "$(date +%s)000" > "$REG"
trap 'rm -f "$REG"; exit 0' INT TERM HUP EXIT
O=$'\\e[38;2;215;119;87m'; D=$'\\e[2m'; B=$'\\e[1m'; R=$'\\e[0m'; G=$'\\e[32m'; RED=$'\\e[31m'
HR="$(printf '─%.0s' $(seq 1 78))"
echo
echo " \${O}✻\${R} \${B}Claude Code\${R} \${D}v2.1.0\${R}"
echo "   \${D}Opus 5.5 · Claude Max\${R}"
echo "   \${D}\${PWD/#$HOME/~}\${R}"
echo
echo "\${D}>\${R} Yes, reject it. And add a simple rate limit per API key while you are there."
echo
echo "\${O}⏺\${R} \${B}Write\${R}(src/rateLimit.ts)"
echo "  \${D}⎿  Wrote 13 lines to src/rateLimit.ts\${R}"
echo
echo "\${O}⏺\${R} \${B}Bash\${R}(pnpm vitest run --reporter=dot)"
echo "  \${D}⎿  Test Files  1 passed (1)\${R}"
echo
echo "\${O}⏺\${R} The fixed-window limiter is in \${B}src/rateLimit.ts\${R}. Next I am adding the"
echo "  400 for \${B}min > 90\${R}."
echo
echo "\${D}$HR\${R}"
echo "> "
echo "\${D}$HR\${R}"
echo "  \${D}? for shortcuts\${R}"
while true; do sleep 3600; done
`;

export function buildSandbox(dir) {
  rmSync(dir, { recursive: true, force: true });
  const home = join(dir, 'home');
  const root = join(home, 'code', 'orbit-api');
  const bin = join(dir, 'bin');
  const userData = join(dir, 'userData');
  const sessionId = '6f1c2a9e-3b7d-4e21-9c5a-0d8e4f7a2b10';
  mkdirSync(userData, { recursive: true });
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });

  for (const [path, text] of Object.entries(PROJECT_FILES)) write(join(root, path), text);
  chmodSync(join(root, 'scripts/gates.sh'), 0o755);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'add', '-A');
  git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.com', 'commit', '-q', '-m', 'Initial commit');
  for (const [path, text] of Object.entries(PROJECT_CHANGES)) write(join(root, path), text);

  const claude = join(home, '.claude');
  write(join(claude, 'projects', slugOf(root), `${sessionId}.jsonl`), transcript(root, sessionId));
  // Older sessions for the Sessions list.
  const older = [
    ['Add a /health endpoint that also reports uptime', 1],
    ['Write tests for registerStation input validation', 2],
    ['Explain how the TLE cache decides when to refetch', 5],
  ];
  older.forEach(([text, days], i) => {
    const id = `0b7e4c1a-9d2f-4a6b-8c3e-5f1a2b3c4d5${i}`;
    const at = new Date(Date.now() - days * 86_400_000);
    const lines = [
      { type: 'user', uuid: randomUUID(), sessionId: id, cwd: root, timestamp: at.toISOString(), message: { role: 'user', content: text } },
      { type: 'assistant', uuid: randomUUID(), sessionId: id, cwd: root, timestamp: at.toISOString(), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 900, output_tokens: 300 } } },
    ];
    const file = join(claude, 'projects', slugOf(root), `${id}.jsonl`);
    write(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(file, at, at);
  });
  write(join(claude, 'CLAUDE.md'), '# Global notes\n\n- Prefer small commits with a clear message.\n- Ask before running anything that deploys.\n');
  write(join(claude, 'skills', 'changelog', 'SKILL.md'), '---\nname: changelog\ndescription: Write a changelog entry from the commits since the last tag.\n---\n');
  write(join(claude, 'skills', 'pr-summary', 'SKILL.md'), '---\nname: pr-summary\ndescription: Summarise the current branch as a pull request description.\n---\n');
  write(join(claude, 'agents', 'explainer.md'), '---\nname: explainer\ndescription: Explains unfamiliar code paths with file:line references.\n---\n');
  write(
    join(claude, 'settings.json'),
    JSON.stringify(
      {
        model: 'opus',
        hooks: {
          PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'pnpm exec prettier --write "$CLAUDE_FILE_PATHS"' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }],
        },
      },
      null,
      2,
    ),
  );
  write(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' }, playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }, null, 2),
  );

  write(join(bin, 'claude'), FAKE_CLAUDE.replace('__SESSION__', sessionId));
  chmodSync(join(bin, 'claude'), 0o755);
  write(
    join(home, '.zshrc'),
    `export PATH="${bin}:$PATH"\nPROMPT='%F{75}%1~%f %F{242}on%f %F{114}main%f %F{215}❯%f '\nunsetopt PROMPT_SP\n`,
  );
  write(join(home, '.zprofile'), '');
  write(join(home, '.bashrc'), `export PATH="${bin}:$PATH"\nPS1='\\W ❯ '\n`);
  // A live usage record as ARcode's status line script writes it, so plan limits show up.
  const now = Date.now();
  write(
    join(userData, 'usage', `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      cwd: root,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      contextWindow: { usedPercent: 31, totalInputTokens: 62_000, size: 200_000 },
      rateLimits: { fiveHour: { usedPercent: 24, resetsAt: now + 3 * 3_600_000 }, sevenDay: { usedPercent: 41, resetsAt: now + 4 * 86_400_000 } },
      updatedAt: now,
    }),
  );

  // More projects for the switcher's recent list.
  const others = ['orbit-web', 'ground-station-sim', 'telemetry-pipeline', 'design-tokens'];
  for (const name of others) {
    write(join(home, 'code', name, 'README.md'), `# ${name}\n`);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: join(home, 'code', name), stdio: 'ignore' });
  }
  write(
    join(userData, 'state.json'),
    JSON.stringify({
      version: 1,
      recent: [root, ...others.map((name) => join(home, 'code', name))].map((r, i) => ({ root: r, openedAt: now - i * 3_600_000 * 7 })),
      openWindows: [],
      projects: { [root]: { layout: { treeWidth: 0.2, terminalHeight: 0.36, treeVisible: true, terminalVisible: true } } },
      settings: {},
    }),
  );
  return { dir, home, root, bin, userData, sessionId };
}
