/** Parsers for the private OSC sequences Claude Code and the gate command emit. */

export interface TabStatusOsc {
  indicator?: string;
  status?: string;
  statusColor?: string;
}

/** Splits on unescaped `;`; `\;` and `\\` are unescaped inside fields. */
export function splitEscaped(data: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    if (ch === '\\' && i + 1 < data.length && (data[i + 1] === ';' || data[i + 1] === '\\')) {
      current += data[i + 1];
      i++;
    } else if (ch === ';') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** OSC 21337 payload: `indicator=<#rrggbb>;status=<text>;status-color=<#rrggbb>`. */
export function parseTabStatus(data: string): TabStatusOsc {
  const result: TabStatusOsc = {};
  for (const field of splitEscaped(data)) {
    const eq = field.indexOf('=');
    if (eq <= 0) continue;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1);
    if (key === 'indicator') result.indicator = value;
    else if (key === 'status') result.status = value;
    else if (key === 'status-color') result.statusColor = value;
  }
  return result;
}

const COLOR = /^#[0-9a-fA-F]{3,8}$/;

/** Only hex colors are accepted from the terminal stream before they reach inline styles. */
export function safeColor(value: string | undefined): string | undefined {
  return value && COLOR.test(value) ? value : undefined;
}

/** OSC 21338 payload `gate;<exit code>`; returns the exit code or null for anything else. */
export function parseGateResult(data: string): number | null {
  const match = /^gate;(\d{1,3})$/.exec(data.trim());
  return match ? Number.parseInt(match[1] ?? '', 10) : null;
}
