import { Terminal } from '@xterm/xterm';
import type { IDisposable, ITheme } from '@xterm/xterm';
import { ARCODE_PATH_TYPE, decodeDraggedPaths } from '@shared/files';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import type { PtyDataEvent, PtyExitEvent, PtyId } from '@shared/ipc';
import { resolveKey } from './keys';
import { GATE_OSC, shellEscapePath } from './terminal/commands';
import { trackInputCaret } from './terminal/inputCaret';
import { registerFileLinks } from './terminal/links';
import { parseGateResult, parseTabStatus } from './terminal/osc';
import type { TabStatusOsc } from './terminal/osc';
import { terminalApi } from './terminal/api';

const theme: ITheme = {
  background: '#1e1f22',
  foreground: '#bcbec4',
  cursor: '#ced0d6',
  cursorAccent: '#1e1f22',
  selectionBackground: '#214283',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.16)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.28)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.36)',
  black: '#1e1f22',
  red: '#f75464',
  green: '#5fb865',
  yellow: '#e5c07b',
  blue: '#56a8f5',
  magenta: '#c77dbb',
  cyan: '#2aacb8',
  white: '#bcbec4',
  brightBlack: '#6f737a',
  brightRed: '#ff7b88',
  brightGreen: '#7ed087',
  brightYellow: '#f2d48f',
  brightBlue: '#7cbcff',
  brightMagenta: '#e09fd5',
  brightCyan: '#4fd1dc',
  brightWhite: '#ffffff',
};

/** OSC 21337 is Claude Code's tab status; OSC 7501 is its program-status query, which needs no answer. */
const OSC_TAB_STATUS = 21337;
const OSC_PROGRAM_STATUS = 7501;

/** True when the named font is installed, by comparing glyph widths against generic fallbacks. */
function hasFont(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return false;
  const sample = 'mmmmmmmmmmlli10OO@#';
  return ['monospace', 'serif'].some((fallback) => {
    ctx.font = `72px ${fallback}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `72px "${family}", ${fallback}`;
    return ctx.measureText(sample).width !== base;
  });
}

let cachedFontFamily: string | undefined;
function fontFamily(): string {
  cachedFontFamily ??= hasFont('JetBrains Mono') ? '"JetBrains Mono", Menlo, monospace' : 'Menlo, monospace';
  return cachedFontFamily;
}

export interface SessionCallbacks {
  onPtyId?(id: PtyId): void;
  onTitle?(title: string): void;
  onTabStatus?(status: TabStatusOsc): void;
  onGate?(exitCode: number): void;
  onExit?(exitCode: number): void;
  onOpenFile?(path: string, line?: number, endLine?: number): void;
}

export interface SessionOptions {
  projectRoot: string;
  extraEnv?: Record<string, string> | undefined;
  name: string;
  fontSize: number;
  callbacks: SessionCallbacks;
}

const READY_QUIET_MS = 250;
const READY_MAX_MS = 3000;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** One xterm instance bound to one pty in the main process. */
export class TerminalSession {
  readonly term: Terminal;
  readonly search = new SearchAddon();
  private readonly fit = new FitAddon();
  private readonly disposers: (() => void)[] = [];
  private ptyId: PtyId | undefined;
  private disposed = false;
  private exited = false;
  private readyResolvers: (() => void)[] = [];
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly options: SessionOptions,
  ) {
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: fontFamily(),
      // Chromium has no subpixel antialiasing on macOS, so Regular looks lighter than the same font
      // in a JetBrains IDE; Medium and the IDE's 1.2 line spacing bring it visually close.
      fontWeight: 500,
      fontWeightBold: 700,
      fontSize: options.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      macOptionIsMeta: true,
      theme,
      linkHandler: { activate: (_event, uri) => void window.open(uri) },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri)));
    this.term.loadAddon(this.search);
    this.term.loadAddon(new ClipboardAddon());
    this.term.open(host);
    this.loadRenderer();
    this.term.attachCustomKeyEventHandler((event) => this.handleKey(event));
    // Keeps the input textarea on the cursor, where macOS shows the keyboard layout indicator.
    const caret = trackInputCaret(this.term);
    this.disposers.push(() => caret.dispose());
    this.registerHandlers();
    this.installDrop();
  }

  /** WebGL first; on failure or context loss xterm falls back to its DOM renderer. */
  private loadRenderer(): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch (error) {
      console.warn('WebGL renderer unavailable, using DOM renderer', error);
    }
  }

  private registerHandlers(): void {
    const { callbacks } = this.options;
    const parser = this.term.parser;
    const track = (disposable: IDisposable): void => {
      this.disposers.push(() => disposable.dispose());
    };
    track(
      parser.registerOscHandler(OSC_TAB_STATUS, (data) => {
        callbacks.onTabStatus?.(parseTabStatus(data));
        return true;
      }),
    );
    track(parser.registerOscHandler(OSC_PROGRAM_STATUS, () => true));
    track(
      parser.registerOscHandler(GATE_OSC, (data) => {
        const code = parseGateResult(data);
        if (code === null) return false;
        callbacks.onGate?.(code);
        return true;
      }),
    );
    track(this.term.onTitleChange((title) => callbacks.onTitle?.(title)));
    track(
      registerFileLinks(this.term, {
        projectRoot: () => this.options.projectRoot,
        resolveFile: (path, root) => terminalApi().resolveFile(path, root),
        onOpen: (path, line, endLine) => callbacks.onOpenFile?.(path, line, endLine),
      }),
    );
  }

  /** Dropping files on the terminal types their shell-escaped paths, like other terminals do. */
  private installDrop(): void {
    const accepts = (types: readonly string[] | undefined): boolean =>
      !!types && (types.includes('Files') || types.includes(ARCODE_PATH_TYPE));
    const onOver = (event: DragEvent): void => {
      if (accepts(event.dataTransfer?.types)) event.preventDefault();
    };
    const onDrop = (event: DragEvent): void => {
      const transfer = event.dataTransfer;
      if (!transfer) return;
      // Rows dragged from the file tree carry their paths as a JSON array; Finder drops carry File objects.
      const own = transfer.getData(ARCODE_PATH_TYPE);
      const paths = own
        ? decodeDraggedPaths(own)
        : [...transfer.files].map((file) => terminalApi().pathForFile(file)).filter((p) => p.length > 0);
      if (paths.length === 0) return;
      event.preventDefault();
      this.typePaths(paths);
    };
    this.host.addEventListener('dragover', onOver);
    this.host.addEventListener('drop', onDrop);
    this.disposers.push(() => {
      this.host.removeEventListener('dragover', onOver);
      this.host.removeEventListener('drop', onDrop);
    });
  }

  private handleKey(event: KeyboardEvent): boolean {
    const action = resolveKey(event, this.term.hasSelection());
    if (event.key === 'Escape' && action.kind !== 'command') {
      // Esc belongs to the program in the terminal; keep it from reaching any app-level handler.
      // Ctrl+Esc is a pane command and must bubble up to the pane.
      event.stopPropagation();
    }
    switch (action.kind) {
      case 'default':
        return true;
      case 'swallow':
        return false;
      case 'command':
        // Executed by the pane's key listener once the event bubbles up.
        return false;
      case 'send':
        event.preventDefault();
        this.write(action.data);
        return false;
      case 'copy':
        event.preventDefault();
        window.acode.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      case 'clear':
        event.preventDefault();
        this.term.clear();
        return false;
      case 'paste':
        event.preventDefault();
        void this.pasteFromClipboard();
        return false;
    }
  }

  /** Types shell-escaped paths followed by a space, like other terminals do on drop. */
  private typePaths(paths: string[]): void {
    this.term.paste(paths.map(shellEscapePath).join(' ') + ' ');
  }

  /**
   * Files on the clipboard (copied in Finder or in the tree) are typed as escaped paths; an image
   * becomes Ctrl+V, which makes Claude Code grab it itself; otherwise the text is pasted.
   */
  private async pasteFromClipboard(): Promise<void> {
    const files = await window.acode.files.clipboardFiles().catch(() => [] as string[]);
    if (files.length > 0) {
      this.typePaths(files);
      return;
    }
    const info = await terminalApi().clipboardInfo();
    if (info.hasImage && !info.hasText) {
      this.write('\x16');
      return;
    }
    const text = await window.acode.clipboard.readText();
    // term.paste() normalises newlines and wraps in bracketed-paste markers when enabled.
    if (text) this.term.paste(text);
  }

  async start(): Promise<void> {
    this.fit.fit();
    const pending: PtyDataEvent[] = [];
    const pendingExit: PtyExitEvent[] = [];
    const onData = (event: PtyDataEvent): void => {
      if (this.ptyId === undefined) pending.push(event);
      else if (event.id === this.ptyId) this.handleData(event.data);
    };
    const onExit = (event: PtyExitEvent): void => {
      if (this.ptyId === undefined) pendingExit.push(event);
      else if (event.id === this.ptyId) this.handleExit(event.exitCode);
    };
    // Subscribe before the pty exists so early output (the first prompt) is not lost.
    this.disposers.push(window.acode.pty.onData(onData), window.acode.pty.onExit(onExit));

    const result = await window.acode.pty.create({
      cols: this.term.cols,
      rows: this.term.rows,
      cwd: this.options.projectRoot || undefined,
      extraEnv: this.options.extraEnv,
      name: this.options.name,
    });
    if (this.disposed) {
      window.acode.pty.kill(result.id);
      return;
    }
    this.ptyId = result.id;
    this.options.callbacks.onPtyId?.(result.id);
    for (const event of pending.splice(0)) if (event.id === result.id) this.handleData(event.data);
    for (const event of pendingExit.splice(0)) if (event.id === result.id) this.handleExit(event.exitCode);

    const input = this.term.onData((data) => this.write(data));
    const resize = this.term.onResize(({ cols, rows }) => window.acode.pty.resize(result.id, cols, rows));
    this.disposers.push(
      () => input.dispose(),
      () => resize.dispose(),
    );
    const observer = new ResizeObserver(() => this.refit());
    observer.observe(this.host);
    this.disposers.push(() => observer.disconnect());
    this.armReady(READY_MAX_MS);
  }

  private handleData(data: string): void {
    this.term.write(data);
    if (this.readyResolvers.length > 0) this.armReady(READY_QUIET_MS);
  }

  private handleExit(exitCode: number): void {
    this.exited = true;
    this.term.write('\r\n[process exited]\r\n');
    this.options.callbacks.onExit?.(exitCode);
    this.resolveReady();
  }

  private armReady(ms: number): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => this.resolveReady(), ms);
  }

  private resolveReady(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    for (const resolve of this.readyResolvers.splice(0)) resolve();
  }

  /** Resolves once the shell has printed its prompt (output went quiet), or after a hard timeout. */
  whenReady(): Promise<void> {
    return new Promise((resolve) => {
      this.readyResolvers.push(resolve);
      if (this.ptyId !== undefined) this.armReady(READY_QUIET_MS);
    });
  }

  /** Types a command line into the shell and presses Enter. */
  async runCommand(command: string): Promise<void> {
    await this.whenReady();
    if (this.disposed || this.exited) return;
    this.write(`${command}\r`);
  }

  /** Sends text as one bracketed paste and optionally presses Enter afterwards. */
  sendPasted(text: string, submit: boolean): void {
    this.write(`${PASTE_START}${text.replace(/\r?\n/g, '\r')}${PASTE_END}`);
    if (submit) setTimeout(() => this.write('\r'), 60);
  }

  write(data: string): void {
    if (this.ptyId !== undefined && !this.exited) window.acode.pty.write(this.ptyId, data);
  }

  get id(): PtyId | undefined {
    return this.ptyId;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  setFontSize(size: number): void {
    if (this.term.options.fontSize === size) return;
    this.term.options.fontSize = size;
    this.refit();
  }

  refit(): void {
    if (this.host.offsetWidth > 0 && this.host.offsetHeight > 0) this.fit.fit();
  }

  focus(): void {
    this.term.focus();
  }

  dispose(): void {
    this.disposed = true;
    this.resolveReady();
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.ptyId !== undefined) window.acode.pty.kill(this.ptyId);
    this.term.dispose();
  }
}
