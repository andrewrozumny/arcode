import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { askPlanUsage, PLAN_RECORD, PLAN_USAGE_ARGS, planRecord, writePlanRecord } from './planUsage';
import { parseUsageRecord, readUsageDir } from './usageLive';

/** The shape Claude Code 2.1.325 answers `get_usage` with (trimmed). */
const answer = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: null,
    seven_day: { utilization: 35, resets_at: '2026-11-18T17:00:00.905407+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      { kind: 'weekly_all', percent: 35, resets_at: '2026-11-18T17:00:00+00:00', scope: null },
      { kind: 'weekly_scoped', percent: 23, resets_at: '2026-11-18T16:59:59+00:00', scope: { model: { id: null, display_name: 'Fable' } } },
    ],
    model_scoped: [{ display_name: 'Fable', utilization: 23, resets_at: '2026-11-18T16:59:59.631804+00:00' }],
  },
};

describe('plan record', () => {
  it('turns the get_usage answer into a usage record with the per-model windows', () => {
    const record = planRecord(answer, 1000);
    const parsed = parseUsageRecord(JSON.stringify(record));
    expect(parsed).toMatchObject({
      sessionId: 'plan',
      cwd: null,
      fiveHour: null,
      sevenDay: { usedPercent: 35, resetsAt: Date.parse('2026-11-18T17:00:00.905Z') },
      models: [{ name: 'Fable', usedPercent: 23, resetsAt: Date.parse('2026-11-18T16:59:59.631Z') }],
      updatedAt: 1000,
    });
  });

  it('reads the raw server rows when model_scoped is missing, and lets a bucket replace the old field', () => {
    const rest: Record<string, unknown> = { ...answer.rate_limits, seven_day_opus: { utilization: 10, resets_at: null } };
    delete rest.model_scoped;
    const record = planRecord({ ...answer, rate_limits: rest }, 1);
    expect((record?.rateLimits as { models: unknown[] }).models).toEqual([
      { name: 'Opus', usedPercent: 10, resetsAt: null },
      { name: 'Fable', usedPercent: 23, resetsAt: Date.parse('2026-11-18T16:59:59Z') },
    ]);
  });

  it('gives nothing without plan limits', () => {
    expect(planRecord({ rate_limits_available: false, rate_limits: null }, 1)).toBeNull();
    expect(planRecord({ rate_limits_available: true, rate_limits: { five_hour: null, seven_day: null } }, 1)).toBeNull();
    expect(planRecord(null, 1)).toBeNull();
  });

  it('writes the record where the usage watcher reads it, without a stray temp file', async () => {
    const dir = mkdtempSync(join(os.tmpdir(), 'arcode-plan-'));
    const record = planRecord(answer, 5);
    if (!record) throw new Error('no record');
    writePlanRecord(dir, record);
    expect(readdirSync(dir)).toEqual([PLAN_RECORD]);
    expect((await readUsageDir(dir))[0]?.models[0]?.name).toBe('Fable');
  });
});

describe('asking Claude Code', () => {
  /** A fake `claude` that answers the control request like the real one and logs its arguments. */
  const fake = (body: string): { claude: string; dir: string } => {
    const dir = mkdtempSync(join(os.tmpdir(), 'arcode-plan-cli-'));
    const claude = join(dir, 'claude');
    writeFileSync(
      claude,
      `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(join(dir, 'args'))}, JSON.stringify(process.argv.slice(2)));
let buf = '';
process.stdin.on('data', (d) => { buf += d; const line = buf.split('\\n')[0]; if (buf.includes('\\n')) { ${body} } });
process.stdin.on('end', () => process.exit(0));
`,
    );
    chmodSync(claude, 0o755);
    return { claude, dir };
  };
  const env = { PATH: process.env.PATH ?? '' };

  it('sends get_usage, returns the answer and closes the process', async () => {
    const { claude, dir } = fake(
      `const req = JSON.parse(line); console.log(JSON.stringify({ type: 'system', subtype: 'noise' })); console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { asked: req.request.subtype, skip: req.request.skip_behaviors } } }));`,
    );
    expect(await askPlanUsage(claude, env, dir)).toEqual({ asked: 'get_usage', skip: true });
    expect(JSON.parse(readFileSync(join(dir, 'args'), 'utf8'))).toEqual(PLAN_USAGE_ARGS);
  });

  it('gives null on an error answer, on a hang and when claude is missing', async () => {
    const failing = fake(`console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'usage', error: 'no' } }));`);
    expect(await askPlanUsage(failing.claude, env, failing.dir)).toBeNull();
    const silent = fake('');
    expect(await askPlanUsage(silent.claude, env, silent.dir, 300)).toBeNull();
    expect(await askPlanUsage('/nonexistent/claude', env, silent.dir)).toBeNull();
  });
});
