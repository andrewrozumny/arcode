import { describe, expect, it } from 'vitest';
import { parseGateResult, parseTabStatus, safeColor, splitEscaped } from './osc';

describe('splitEscaped', () => {
  it('splits on plain semicolons and unescapes \\; and \\\\', () => {
    expect(splitEscaped('a;b\\;c;d\\\\e')).toEqual(['a', 'b;c', 'd\\e']);
  });
});

describe('parseTabStatus', () => {
  it('reads indicator, status and status color', () => {
    expect(parseTabStatus('indicator=#ff8800;status=Working;status-color=#00ff00')).toEqual({
      indicator: '#ff8800',
      status: 'Working',
      statusColor: '#00ff00',
    });
  });

  it('keeps escaped separators inside the status text', () => {
    expect(parseTabStatus('status=a\\;b').status).toBe('a;b');
  });

  it('ignores unknown and malformed fields', () => {
    expect(parseTabStatus('foo=bar;broken;=x')).toEqual({});
  });
});

describe('safeColor', () => {
  it('accepts hex colors only', () => {
    expect(safeColor('#aabbcc')).toBe('#aabbcc');
    expect(safeColor('red; background:url(x)')).toBeUndefined();
    expect(safeColor(undefined)).toBeUndefined();
  });
});

describe('parseGateResult', () => {
  it('extracts the exit code', () => {
    expect(parseGateResult('gate;0')).toBe(0);
    expect(parseGateResult('gate;1')).toBe(1);
    expect(parseGateResult('gate;127')).toBe(127);
  });

  it('rejects other payloads', () => {
    expect(parseGateResult('gate;')).toBeNull();
    expect(parseGateResult('other;1')).toBeNull();
    expect(parseGateResult('gate;1;2')).toBeNull();
  });
});
