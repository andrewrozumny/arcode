# 0001. Electron with xterm.js and node-pty

## Context

The app exists for one job: hosting terminal-based coding agents with a small IDE around them.
The terminal must behave exactly like a native one (TUI apps such as Claude Code, Unicode, colors,
mouse, bracketed paste), and the surrounding panels need a rich text editor and file views.
A native AppKit app or a Rust/Tauri shell would mean writing or wrapping a terminal emulator.

## Decision

Build on Electron (main process in Node.js, React renderer), use xterm.js with the WebGL,
Unicode 11, search, web-links and clipboard addons for rendering, and node-pty for real login
shells. CodeMirror 6 provides the viewer and diff editor.

## Consequences

- xterm.js and node-pty are the same stack VS Code's terminal uses, so TUI behavior is well tested.
- node-pty is a native module: it is rebuilt against Electron's headers on install
  (`pnpm rebuild:native` after an Electron upgrade) and kept outside the asar archive so its
  helper binary stays executable.
- Memory use is that of a Chromium app; heavy work stays in main and the renderer stays thin.
- The renderer is sandboxed with context isolation; everything it needs from Node goes through
  the typed preload bridge.
