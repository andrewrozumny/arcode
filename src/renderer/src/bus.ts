/**
 * Renderer-wide event bus for one window. Panels talk through it instead of importing
 * each other: the terminal asks the viewer to open a file, the menu asks the focused
 * panel to close its tab, and so on.
 *
 *   import { bus } from './bus';
 *   bus.openFile({ path: 'src/app.ts', line: 42 });   // anyone
 *   const off = bus.on('openFile', ({ path, line }) => { ... });   // the viewer
 */
import type { GateTarget } from '@shared/app';

export interface OpenFileRequest {
  /** Absolute, or relative to the project root. */
  path: string;
  /** 1-based line to reveal. */
  line?: number;
  /** 1-based last line of a range to highlight. */
  endLine?: number;
  /** 1-based column to place the cursor at on `line`. */
  column?: number;
  /**
   * Show a diff against HEAD right away: 'head' opens the file with its HEAD diff, 'deleted' opens
   * the HEAD version of a file that is gone from the working tree as a read-only diff.
   */
  diff?: OpenDiff;
}

export type OpenDiff = 'head' | 'deleted';

export interface BusEvents {
  /** Open a file in the viewer (and focus it). */
  openFile: OpenFileRequest;
  /** Reveal and select a path in the project tree. */
  revealInTree: { path: string };
  /** Close the active viewer tab (Cmd+W outside the terminal). */
  closeViewerTab: undefined;
  /** Close the active terminal tab (Cmd+W inside the terminal). */
  closeTerminalTab: undefined;
  /** Run `scripts/gates.sh <target>` in a terminal tab. */
  runGate: { target: GateTarget };
  /** Focus a panel. */
  focusPanel: { panel: 'tree' | 'viewer' | 'terminal' };
  /** Open a terminal tab that resumes a past Claude session (or focus the tab already running it). */
  resumeClaude: { sessionId: string; name: string };
  /** Open a new Claude tab in the terminal dock. */
  newClaude: undefined;
}

type Listener<K extends keyof BusEvents> = (payload: BusEvents[K]) => void;

export class EventBus {
  private readonly listeners = new Map<keyof BusEvents, Set<(payload: never) => void>>();

  on<K extends keyof BusEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => set.delete(listener as (payload: never) => void);
  }

  emit<K extends keyof BusEvents>(event: K, ...[payload]: BusEvents[K] extends undefined ? [] : [BusEvents[K]]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<K>)(payload as BusEvents[K]);
      } catch (error) {
        console.error(`bus listener for "${event}" failed`, error);
      }
    }
  }

  /** Number of listeners, mostly for tests and "is anyone handling this" checks. */
  count(event: keyof BusEvents): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  openFile(request: OpenFileRequest): void {
    this.emit('openFile', request);
  }
}

export const bus = new EventBus();
