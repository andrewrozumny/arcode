/** Keyboard decisions for the terminal, kept free of DOM/xterm types so they are unit-testable. */

/** Candidate byte sequences for "insert newline" in line editors such as Claude Code. */
export const NewlineSequence = {
  /** ESC + CR, what terminals send for Option+Enter (meta-return). */
  MetaReturn: '\x1b\r',
  /** Kitty keyboard protocol / CSI u encoding of Shift+Enter. */
  CsiU: '\x1b[13;2u',
  /** Backslash + CR, the line-continuation fallback. */
  BackslashReturn: '\\\r',
} as const;

export const SHIFT_ENTER_SEQUENCE: string = NewlineSequence.MetaReturn;

export interface KeyInfo {
  type: string;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** Commands the terminal pane handles itself (tabs, search, composer, font size). */
export type PaneCommand =
  | 'newShell'
  | 'newClaude'
  | 'nextTab'
  | 'prevTab'
  | 'closeTab'
  | 'find'
  | 'toggleComposer'
  | 'fontLarger'
  | 'fontSmaller'
  | 'fontReset';

export type KeyAction =
  | { kind: 'default' }
  | { kind: 'swallow' }
  | { kind: 'send'; data: string }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'clear' }
  | { kind: 'command'; command: PaneCommand };

const command = (type: string, name: PaneCommand): KeyAction =>
  type === 'keydown' ? { kind: 'command', command: name } : { kind: 'swallow' };

/**
 * Decides what the terminal does with a key event.
 * `default` lets xterm handle it, `swallow` blocks it (e.g. app shortcuts handled by the menu),
 * `command` is a pane-level action executed by the pane, not the terminal.
 * Escape is always `default`: it must reach the program running in the terminal and never move focus away.
 */
export function resolveKey(event: KeyInfo, hasSelection: boolean): KeyAction {
  const { type, key } = event;
  const keydown = type === 'keydown';

  if (key === 'Escape') {
    return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      ? command(type, 'newClaude')
      : { kind: 'default' };
  }

  if (key === 'Enter' && !event.metaKey && !event.ctrlKey && (event.shiftKey !== event.altKey)) {
    // Shift+Enter and Option+Enter both insert a newline. Swallow keypress/keyup too,
    // otherwise xterm would still emit a CR.
    return keydown ? { kind: 'send', data: SHIFT_ENTER_SEQUENCE } : { kind: 'swallow' };
  }

  if (event.metaKey && !event.ctrlKey && !event.altKey) {
    const lower = key.toLowerCase();
    if (!event.shiftKey) {
      switch (lower) {
        case 'c':
          if (!keydown) return { kind: 'swallow' };
          return hasSelection ? { kind: 'copy' } : { kind: 'send', data: '\x03' };
        case 'v':
          return keydown ? { kind: 'paste' } : { kind: 'swallow' };
        case 'k':
          return keydown ? { kind: 'clear' } : { kind: 'swallow' };
        case 'f':
          return command(type, 'find');
        case 't':
          return command(type, 'newShell');
        case 'w':
          return command(type, 'closeTab');
        case '=':
          return command(type, 'fontLarger');
        case '-':
          return command(type, 'fontSmaller');
        case '0':
          return command(type, 'fontReset');
      }
    } else {
      switch (key) {
        case ']':
        case '}':
          return command(type, 'nextTab');
        case '[':
        case '{':
          return command(type, 'prevTab');
        case '+':
          return command(type, 'fontLarger');
        case '_':
          return command(type, 'fontSmaller');
        case 'Enter':
          return command(type, 'toggleComposer');
      }
    }
  }

  // Any other Cmd shortcut belongs to the application menu, never to the shell.
  if (event.metaKey) return { kind: 'swallow' };

  return { kind: 'default' };
}
