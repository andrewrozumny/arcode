import { describe, expect, it } from 'vitest';
import { claudeNewCommand, claudeResumeCommand, gateCommand, gateTitle, shellEscapePath, shellQuote } from './commands';

const ID = '123e4567-e89b-12d3-a456-426614174000';

describe('shellQuote', () => {
  it('leaves safe words bare and quotes the rest', () => {
    expect(shellQuote('lint')).toBe('lint');
    expect(shellQuote('My tab')).toBe("'My tab'");
    expect(shellQuote('')).toBe("''");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralises command substitution and separators', () => {
    expect(shellQuote('$(rm -rf ~)')).toBe("'$(rm -rf ~)'");
    expect(shellQuote('a; b')).toBe("'a; b'");
  });
});

describe('claude commands', () => {
  it('starts a new session with id and name', () => {
    expect(claudeNewCommand(ID, 'Claude Code')).toBe(`claude --session-id ${ID} --name 'Claude Code'`);
    expect(claudeNewCommand(ID, 'REVIEWER')).toBe(`claude --session-id ${ID} --name REVIEWER`);
  });

  it('escapes hostile names and drops control characters', () => {
    expect(claudeNewCommand(ID, 'a"b\nc')).toBe(`claude --session-id ${ID} --name 'a"b c'`);
    expect(claudeNewCommand(ID, "x'; rm -rf / #")).toBe(`claude --session-id ${ID} --name 'x'\\''; rm -rf / #'`);
  });

  it('omits an empty name', () => {
    expect(claudeNewCommand(ID, '  ')).toBe(`claude --session-id ${ID}`);
  });

  it('resumes by id', () => {
    expect(claudeResumeCommand(ID)).toBe(`claude --resume ${ID}`);
  });
});

describe('gate commands', () => {
  it('runs the gate script and reports the exit code through a private OSC', () => {
    expect(gateCommand('lint')).toBe("scripts/gates.sh lint; printf '\\033]21338;gate;%s\\007' $?");
  });

  it('quotes unusual targets', () => {
    expect(gateCommand('a b')).toContain("scripts/gates.sh 'a b';");
  });

  it('titles tabs', () => {
    expect(gateTitle('lint')).toBe('Gate: lint');
    expect(gateTitle('all')).toBe('Gate: ALL');
  });
});

describe('shellEscapePath', () => {
  it('backslash-escapes spaces and specials', () => {
    expect(shellEscapePath('/Users/me/My Files/a (1).png')).toBe('/Users/me/My\\ Files/a\\ \\(1\\).png');
  });

  it('keeps characters outside the BMP whole', () => {
    const escaped = shellEscapePath('/Users/me/\u{1F680}.png');
    expect(escaped).toBe('/Users/me/\\\u{1F680}.png');
  });
});
