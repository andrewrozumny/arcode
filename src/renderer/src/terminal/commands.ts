/** Shell command lines typed into a terminal to start Claude Code and project gates. */

/** OSC number the gate command emits after it finishes: `ESC ] 21338 ; gate ; <exit code> BEL`. */
export const GATE_OSC = 21338;

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quotes one shell word; bare when it only has safe characters, single-quoted otherwise. */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (SAFE_WORD.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Backslash-escapes a path the way terminals do for dropped files (`my\ file.png`). */
export function shellEscapePath(path: string): string {
  // `u`: an emoji is one code point; without it each surrogate half got its own backslash.
  return path.replace(/([^A-Za-z0-9_@%+=:,./~-])/gu, '\\$1');
}

/** Strips control characters that must never reach a command line. */
function singleLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

export function claudeNewCommand(sessionId: string, name: string): string {
  const label = singleLine(name);
  const nameArg = label ? ` --name ${shellQuote(label)}` : '';
  return `claude --session-id ${shellQuote(sessionId)}${nameArg}`;
}

export function claudeResumeCommand(sessionId: string): string {
  return `claude --resume ${shellQuote(sessionId)}`;
}

/** Gate targets are plain words (`all`, `lint`, ...); anything else is quoted. */
export function gateCommand(target: string): string {
  const word = singleLine(target) || 'all';
  // After the gate finishes the shell prints its exit code as a private OSC the tab listens for.
  return `scripts/gates.sh ${shellQuote(word)}; printf '\\033]${GATE_OSC};gate;%s\\007' $?`;
}

export function gateTitle(target: string): string {
  return `Gate: ${target === 'all' ? 'ALL' : target}`;
}
