import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEAKER, Silero, sileroPython, speaker } from './silero';

describe('silero helpers', () => {
  it('finds the Python of the Silero environment', () => {
    expect(sileroPython({}, '/Users/me')).toBe('/Users/me/models/silero/.venv/bin/python');
    expect(sileroPython({ ARCODE_SILERO_PYTHON: '/opt/py' })).toBe('/opt/py');
  });

  it('accepts known speakers only', () => {
    expect(speaker('eugene')).toBe('eugene');
    expect(speaker('random')).toBe(DEFAULT_SPEAKER);
  });
});

describe('Silero helper process', () => {
  it('starts once and renders each request through the helper', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'arcode-silero-test-'));
    const bin = join(dir, 'venv', 'bin');
    const python = join(bin, 'python');
    // A stand-in helper: says it is ready, then writes the requested text into the out file.
    const script = join(dir, 'helper.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs'; import readline from 'node:readline';
       console.log(JSON.stringify({ ok: true, ready: true }));
       readline.createInterface({ input: process.stdin }).on('line', (l) => { const r = JSON.parse(l); writeFileSync(r.out, r.speaker + ':' + r.text); console.log(JSON.stringify({ ok: true })); });`,
    );
    (await import('node:fs')).mkdirSync(bin, { recursive: true });
    writeFileSync(python, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(python, 0o755);
    const silero = new Silero(script, python);
    expect(await silero.available()).toBe(true);
    const [a, b] = await Promise.all([silero.speak('one', 'eugene'), silero.speak('two', 'nobody')]);
    silero.stop();
    expect(a.ok && Buffer.from(a.audio).toString()).toBe('eugene:one');
    expect(b.ok && Buffer.from(b.audio).toString()).toBe(`${DEFAULT_SPEAKER}:two`);
  });

  it('reports a helper that cannot start', async () => {
    const silero = new Silero('/nonexistent.py', '/nonexistent/python');
    expect(await silero.available()).toBe(false);
    const result = await silero.speak('x', 'baya');
    expect(result.ok).toBe(false);
  });
});
