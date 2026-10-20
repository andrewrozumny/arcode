/**
 * Opt-in Claude Code status line that feeds live plan usage to ARcode.
 *
 * Nothing here touches ~/.claude/settings.json on its own: `enable`/`disable` run only from an
 * explicit click in the Claude panel, and `enable` refuses when a different status line is set.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StatusLineResult, StatusLineState } from '@shared/claude';
import { isRecord, readJson } from './common';

export const SCRIPT_NAME = 'arcode-statusline.py';

export interface StatusLinePaths {
  /** Script shipped with the app (repo `resources/` in dev, Contents/Resources in production). */
  source: string;
  /** Installed copy the settings entry points at (`~/Library/Application Support/ARcode/<script>`). */
  installed: string;
  /** `~/.claude/settings.json`. */
  settings: string;
}

/** The exact `statusLine` entry ARcode writes. */
export function acodeStatusLineEntry(installedScript: string): { type: 'command'; command: string } {
  return { type: 'command', command: `python3 "${installedScript}"` };
}

function statusLineOf(settings: unknown): Record<string, unknown> | null {
  if (!isRecord(settings)) return null;
  const entry = settings.statusLine;
  return isRecord(entry) ? entry : null;
}

/** Classifies the current settings: no status line, ARcode's script, or someone else's command. */
export function statusLineStateOf(settings: unknown, installedScript: string): StatusLineState {
  const entry = statusLineOf(settings);
  if (!entry) return { state: 'off', command: null };
  const command = typeof entry.command === 'string' ? entry.command : null;
  // Only ARcode's exact entry is ours. A user command that merely calls the script (wrapped in a
  // shell line with other tools) is theirs, and disabling must never delete it.
  if (command && command.trim() === acodeStatusLineEntry(installedScript).command) return { state: 'acode', command };
  return { state: 'other', command: command ?? JSON.stringify(entry) };
}

/** Settings with ARcode's entry added; null when another status line is configured (left untouched). */
export function withAcodeStatusLine(settings: unknown, installedScript: string): Record<string, unknown> | null {
  const base = isRecord(settings) ? settings : {};
  const state = statusLineStateOf(base, installedScript).state;
  if (state === 'other') return null;
  return { ...base, statusLine: acodeStatusLineEntry(installedScript) };
}

/** Settings with ARcode's entry removed; other status lines are kept as they are. */
export function withoutAcodeStatusLine(settings: unknown, installedScript: string): Record<string, unknown> {
  const base = isRecord(settings) ? settings : {};
  if (statusLineStateOf(base, installedScript).state !== 'acode') return base;
  const rest: Record<string, unknown> = { ...base };
  delete rest.statusLine;
  return rest;
}

/** Copies the script into the app's data folder when missing or changed. Our own folder, safe at any time. */
export function installScript(paths: StatusLinePaths): void {
  const source = readFileSync(paths.source);
  const current = existsSync(paths.installed) ? readFileSync(paths.installed) : null;
  if (!current || !current.equals(source)) {
    mkdirSync(join(paths.installed, '..'), { recursive: true });
    copyFileSync(paths.source, paths.installed);
  }
  chmodSync(paths.installed, 0o755);
}

function readSettings(file: string): { parsed: unknown; raw: string | null } {
  if (!existsSync(file)) return { parsed: null, raw: null };
  const raw = readFileSync(file, 'utf8');
  return { parsed: readJson(file), raw };
}

/**
 * Replaces the settings file atomically (temp file + rename) after keeping a timestamped backup of
 * the old text, so a crash mid-write can never leave Claude Code with a truncated settings.json.
 * A symlinked settings.json (dotfiles) stays a link: its target is replaced, with its mode kept.
 */
function writeSettings(file: string, raw: string | null, next: Record<string, unknown>): void {
  if (raw !== null) writeFileSync(`${file}.bak-arcode-${Date.now()}`, raw);
  const target = existsSync(file) ? realpathSync(file) : file;
  mkdirSync(dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : null;
  const temp = `${target}.acode-${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
    if (mode !== null) chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Before the rename the entry pointed at the old data folder's script. Re-point it at the current
 * install (backup kept, as for any settings write) so live usage keeps flowing. Only an entry that is
 * exactly the old one is touched.
 */
export function migrateLegacyStatusLine(paths: StatusLinePaths, legacyScript: string): boolean {
  const { parsed, raw } = readSettings(paths.settings);
  if (raw === null || !isRecord(parsed)) return false;
  if (statusLineStateOf(parsed, legacyScript).state !== 'acode') return false;
  installScript(paths);
  writeSettings(paths.settings, raw, { ...parsed, statusLine: acodeStatusLineEntry(paths.installed) });
  return true;
}

export function readStatusLineState(paths: StatusLinePaths): StatusLineState {
  return statusLineStateOf(readJson(paths.settings), paths.installed);
}

/** User action: install the script and point the status line at it, unless another one exists. */
export function enableStatusLine(paths: StatusLinePaths): StatusLineResult {
  try {
    installScript(paths);
    const { parsed, raw } = readSettings(paths.settings);
    if (raw !== null && parsed === null) return { ok: false, reason: `${paths.settings} is not valid JSON; not touching it.` };
    const state = statusLineStateOf(parsed, paths.installed);
    if (state.state === 'acode') return { ok: true };
    const next = withAcodeStatusLine(parsed, paths.installed);
    if (!next) return { ok: false, reason: `Another status line is configured: ${state.command ?? ''}` };
    writeSettings(paths.settings, raw, next);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** User action: remove ARcode's entry only. */
export function disableStatusLine(paths: StatusLinePaths): StatusLineResult {
  try {
    const { parsed, raw } = readSettings(paths.settings);
    if (raw === null) return { ok: true };
    if (parsed === null) return { ok: false, reason: `${paths.settings} is not valid JSON; not touching it.` };
    if (statusLineStateOf(parsed, paths.installed).state !== 'acode') return { ok: true };
    writeSettings(paths.settings, raw, withoutAcodeStatusLine(parsed, paths.installed));
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
