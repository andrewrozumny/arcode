/**
 * Autosave and "type to edit" decisions of the file viewer. Free of DOM and React types so
 * they can be unit tested; FilePane and CodeEditor feed them.
 */

/** Delay after the last change before an automatic save. */
export const AUTOSAVE_DELAY_MS = 1000;

export interface AutosaveInput {
  /** The Autosave setting. */
  enabled: boolean;
  /** The editor holds changes that are not on disk. */
  dirty: boolean;
  /**
   * A banner is shown above the file (changed on disk, conflict, deleted, save failed). The user
   * has to decide first, so nothing is written behind their back.
   */
  banner: boolean;
}

export function canAutosave({ enabled, dirty, banner }: AutosaveInput): boolean {
  return enabled && dirty && !banner;
}

/** A debounced action with an explicit flush; timers are injectable for tests. */
export interface Debounced {
  /** (Re)starts the delay. */
  schedule(): void;
  /** Runs the action now when a run is pending; returns whether it ran. */
  flush(): boolean;
  cancel(): void;
  pending(): boolean;
}

export function debounced(
  run: () => void,
  delayMs: number,
  timers: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (handle: unknown) => void;
  } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Debounced {
  let handle: unknown;
  let armed = false;
  const fire = (): void => {
    armed = false;
    handle = undefined;
    run();
  };
  return {
    schedule() {
      if (armed) timers.clear(handle);
      armed = true;
      handle = timers.set(fire, delayMs);
    },
    flush() {
      if (!armed) return false;
      timers.clear(handle);
      fire();
      return true;
    },
    cancel() {
      if (armed) timers.clear(handle);
      armed = false;
      handle = undefined;
    },
    pending: () => armed,
  };
}

export interface TypedKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
}

/**
 * A key press that types one printable character (letters, digits, punctuation, space, also
 * Option combinations that produce a character). Shortcuts with Cmd or Ctrl, named keys such as
 * Enter or ArrowUp, dead keys and IME composition do not count.
 */
export function isTypeToEditKey({ key, metaKey, ctrlKey, isComposing }: TypedKey): boolean {
  if (metaKey || ctrlKey || isComposing) return false;
  // One code point: "a", "Ж", " ", "€", or an astral character such as an emoji.
  return [...key].length === 1 && key !== '\u007f' && key >= ' ';
}
