# ARcode architecture

## Purpose

ARcode is a macOS workspace for people who spend the day in a terminal-based coding agent,
mainly Claude Code. One window holds one project: a file tree, a file viewer and a terminal
dock with shell, Claude and gate tabs. Around the terminal it adds what an IDE gives Claude
Code (diff review, open file, selection sharing) and a read-only view of Claude Code's own
state (sessions, usage, skills, plugins, MCP servers, hooks, CLAUDE.md files).

## Process model

| Process | Code | Role |
|---|---|---|
| Main | `src/main` | Node.js + Electron. Windows, ptys, file system, git, the IDE bridge, every read of `~/.claude`. |
| Preload | `src/preload` | Runs in each renderer before the page. Exposes one object, `window.acode`, through `contextBridge`. |
| Renderer | `src/renderer/src` | React UI. No Node access; talks to main only through `window.acode`. |
| Shared | `src/shared` | Channel names, payload types and pure helpers used by all three. No Electron imports. |

Every window is created with `contextIsolation: true`, `nodeIntegration: false` and
`sandbox: true`. Windows never navigate away from their page (`navigation.ts`); web links open
in the default browser. The app holds a single-instance lock (see ADR 0009).

## Module map

**Windows and projects** (`index.ts`, `windows.ts`, `projects.ts`, `state.ts`, `registry.ts`,
`menu.ts`, `renderer.ts`). `index.ts` takes the single-instance lock, registers all IPC once the
app is ready and opens the windows that were open at quit. `WindowManager` keeps one
`BrowserWindow` per resolved project root; each entry owns the window's `PtyManager` and IDE
session. `ProjectSwitcher` is the frameless palette window (recent projects plus an optional
read-only SQLite registry read through the `sqlite3` CLI). `StateStore` keeps `state.json`
(recent projects, open windows, bounds, panel layout, terminal tabs, viewer file tabs, recent
files, settings) with debounced atomic writes. `shared/editorState.ts` validates the viewer tabs
and recent files and holds the most-recently-used update.
The renderer learns which view to show from the page URL query (`WindowContext`).

**Files, tree, watcher, git** (`main/files`, `renderer/src/tree`). `paths.ts` is the one path
guard: project-relative paths are normalised, must stay inside the root and may not leave it
through a symlink. `service.ts` lists folders (ignored entries from `git check-ignore`, or a
`.gitignore` matcher outside git) and applies create and rename; delete goes to the Trash.
`watcher.ts` wraps a recursive `fs.watch` with debounce and heavy-folder filtering and tells
the renderer which folders changed and when git status must be recomputed. `git.ts` runs git
with `GIT_OPTIONAL_LOCKS=0` (ADR 0007); `gitStatus.ts` parses porcelain v2. `index.ts` keeps a
cached fuzzy file index per project. `grep.ts` serves Find in files: `rg --json` when ripgrep is
on PATH (or in the Homebrew folders), else `git grep -n -I --untracked`, else a scan of the cached
index; always spawned with an argv array, capped (lines, files, scanned files, preview length,
10 s timeout), cancelled per window when a newer query arrives, and every returned path passes
`paths.ts`. In the renderer `FindInFiles` replaces the tree in the left column (`findModel.ts` holds
its pure row and keyboard logic) and opens matches through the bus with line and column. `changes.ts` serves the
Changes mode of the left column: `git status` entries joined with `git diff --numstat -z -M HEAD`
counts (untracked files are counted by reading them, size and number capped), all through
`runGit`; `ChangesView` (with `changesModel.ts`) refetches on the watcher's git status events and
opens files through the bus with a `diff` flag, which the viewer turns into the HEAD diff of the
file tab or, for a deleted file, a read-only tab with the HEAD version. `external.ts` and `clipboard*.ts` serve the Import from Mac
dialog, Finder copy and paste and drag and drop (ADR 0008). In the renderer `useDirectoryTree`
loads and watches folders and `FileTree` handles selection, keyboard, menu and drops.

**Viewer** (`main/viewer`, `renderer/src/viewer`). Reads text, images (as data URLs) and
detects binary and oversized files; writes with an mtime check that reports conflicts; shows
the HEAD version for diffs (`git show`); watches open files, re-attaching after rename-based
saves. All paths go through `files/paths.ts`. The renderer side is CodeMirror plus a Markdown
preview (marked and DOMPurify) and the diff tabs used by the IDE bridge. `viewer/autosave.ts` holds
the autosave decisions (debounced save, never while a banner waits for the user) and the type to
edit key test; saves of one file are queued so each sends the mtime the previous one produced.
`viewer/markdownSplit.ts` backs the Markdown split view: `data-line` markers on top-level rendered
blocks (`markedWithLines` in `markdown.ts`), the line to offset anchors used for scroll sync and
the remembered mode in localStorage.

Local history (`viewer/history.ts`, `renderer/src/viewer/HistoryMenu.tsx`) keeps copies of text
files independent of git. `writeFile` takes hooks: before a guarded write the content on disk is
stored as a `save` snapshot (throttled to one per file per 5 minutes unless the newest snapshot came
from an outside change or the change is large; a restore always keeps one). The watcher of an open
file also reports to history: when the disk content no longer matches what ARcode last knew (read
when the file was opened, or written by a save), the known content becomes an `external` snapshot;
ARcode's own writes are recognised by content and by a writes-in-flight count, so they never show
up as outside changes. Files that are not open are covered through the project watcher:
`files/ipc.ts` hands every batch of changed paths to `viewer/projectHistory.ts`, which drops
gitignored paths (one `git check-ignore` per batch, the .gitignore fallback outside git) and
passes each text file to `LocalHistory.projectChange`. The previous content comes from a shared
content cache (`viewer/contentCache.ts`: least recently used, about 64 MB and 10,000 paths at
most, filled by opens, saves and earlier changes) or, for a file seen changing for the first time,
from its HEAD version (one `git cat-file --batch` per batch), so the first edit of a committed file
is recoverable. These snapshots are limited to one per file per 10 seconds. A batch of more than
100 files (checkout, rebase, formatter) is a bulk change: nothing is snapshotted, the cached
content of those files is dropped as stale and one line is logged. Batches of one project run one
after another and read 4 files at a time. Identical consecutive snapshots are skipped; text only, 1 MB cap, 50 per
file, older than 14 days pruned at startup. Paths go through `files/paths.ts` and history checks
again that a file is inside its root. List, read and restore are IPC calls; restore writes through
the same guarded write. In the renderer the History button lists snapshots, and picking one shows
it against the current text in `DiffView` with a Restore action.

PDFs (`viewer/pdf.ts`, `viewer/pdfProtocol.ts`, `renderer/src/viewer/PdfView.tsx`) are shown by
Chromium's built-in PDF viewer (project windows set `webPreferences.plugins: true`) in an iframe
whose URL uses the privileged `arcode-pdf:` scheme (`arcode-pdf://doc/<relative path>?root=<root>&v=<mtime>`).
`readFile` returns that URL for a `.pdf` instead of reading the bytes, plus the sibling `.md` when
one exists. The protocol handler serves a request only when the root is an open project window's
root, the path passes `resolveInside`, the name ends in `.pdf` and the file starts with a PDF
header; the response is always `application/pdf`. The page's CSP allows only this scheme in
`frame-src`. The mtime in the URL makes the iframe reload when the file watcher reports a change.
`navigation.ts` also stops frames inside the page from navigating to web, mail or file URLs (links
in a PDF), which open in the default browser instead (ADR 0011).

**Terminal, pty and Claude session tracking** (`pty.ts`, `env.ts`, `main/terminal`,
`renderer/src/TerminalPane.tsx`, `renderer/src/terminal`, `terminalSession.ts`). `PtyManager`
spawns login shells with node-pty; `env.ts` strips credentials and parent-session markers so a
nested `claude` uses the subscription and starts as a top-level session. The renderer drives
xterm.js (WebGL, Unicode 11, search, file links, OSC title and status). `terminal/sessions.ts`
watches Claude Code's process registry (`~/.claude/sessions/<pid>.json`), maps each process to the
pty whose shell started it, and reads the session model from the transcript tail. Images pasted
into the composer are saved under `<userData>/paste` and pruned after seven days. The dock can
split into two columns: `terminal/split.ts` is the pure model (column per tab, active tab per
column, focused column) and every tab cell stays a child of one CSS grid, so moving a tab between
columns only changes its grid column and the xterm session survives. The split is saved as
`TerminalPaneState.split` (validated by `sanitizeTerminalState`; state without it loads as one column).

**IDE bridge** (`main/ide`, `ideHost.ts`, `renderer/src/ide`). Each project window runs a
WebSocket MCP server on 127.0.0.1 with a random auth token and a lock file in `~/.claude/ide`, the
same contract IDE extensions use. Terminals get `CLAUDE_CODE_SSE_PORT`, so Claude Code connects
without `/ide`. `IdeSession` forwards `openDiff`, `openFile` and `close_tab` to the renderer and
waits for the user's decision; selection changes and @-mentions go the other way.

**Claude panel readers** (`main/claude`, `renderer/src/claude`). Read-only views of Claude
Code's files: skills, plugins, MCP servers (plus `claude mcp list` on demand), agents, hooks,
CLAUDE.md files, past sessions, token usage from transcripts, subagents of the active session, the
Claude feed and the gates overview. The renderer loads the panel's lists once per open panel
(`panelData.tsx`) and keeps its pure logic (sections, session buckets, attention list, search) in
`panelModel.ts`. `claude/configFile.ts` serves the panel's inline preview of files the viewer cannot
open: Markdown, JSON or text files under `~/.claude` or the project only, read-only and capped at
256 KB. The gates overview (`claude/gates.ts`, `shared/gates.ts`)
derives what each gate runs from `package.json` scripts and, only when the project has `src/main`,
`src/preload`, `src/shared` or `src/renderer/src`, counts tests per area. `transcripts.ts` is the single place that locates and reads
`~/.claude/projects` (slugs, session lookup, tail reads, JSON Lines). Readers on IPC and timer
paths use async fs with bounded concurrency (`concurrency.ts`).

**Claude feed** (`claude/feed.ts`, `claude/feedParse.ts`, `renderer/src/claude/Feed*.tsx`,
`feedModel.ts`, `feedTools.ts` (tool phrases), `feedDiff.ts` (line diff), `useFeed.ts`). The pinned first viewer tab shows the active Claude tab's session (or
the last one this window showed) as a readable conversation. `feedParse.ts` is the pure filter:
typed and queued prompts, slash and `!` commands, assistant text and tool calls with capped
structured details (edits, commands, todos, questions, plans, agents) are kept; thinking, attachments, meta entries, system reminders, hook and classifier records and
sidechain records are dropped; tool results are paired with calls by tool_use id. `feed.ts` reads
byte ranges only: the first load reads backwards from the end until it has enough turns (capped),
live polls read the bytes appended since the last offset (whole lines only, a partial last line
waits), and "load earlier" reads backwards from the oldest offset. The renderer merges chunks
(`feedModel.ts`), polls once a second while the tab is visible and renders Markdown through the
viewer's sanitizer, with code highlighting and file links that open in the viewer.
`feedMarkdownText.ts` adapts Claude's terminal-style Markdown first (soft line breaks kept,
`•` bullets and lists starting at 7 under a label turned into lists). Prompt cards answer in the
terminal: `useTerminalPrompt.ts` takes the session's pty from the Claude status event, reads that
terminal's visible screen (`terminal/ptyScreens.ts`, registered by `terminalSession.ts`) while the
process waits, and `feedKeys.ts` maps answers to the key presses Claude Code's TUI expects, written
one per `pty:write` with a short pause. Buttons are live only for the latest call without a result
while the status is `waiting`; permissions, which reach the transcript only after the answer, are
read from the screen alone.
Assistant records
also yield one `FeedUsage` entry each (message id, time, offset, input, output, cache read and
write tokens) in the same byte-range read; the renderer dedupes them by message id and sums them per
turn (prompt to next prompt, duration up to the last assistant record) and for the loaded range.
A `FeedRequest` may name an `agentId`: main then reads
`<session>/subagents/agent-<id>.jsonl` (found through `transcripts.ts`, ids checked against
`AGENT_ID_PATTERN`) with sidechain records kept, and reports whether the latest turn record ends a
turn so the renderer knows when the agent finished. Closable `session` viewer tabs (opened through
the `openFeed` bus event from the Sessions list, Agent cards and the header subagent chip) render
the same `FeedView` read-only: only the pinned feed (`interactive`) shows prompt answer buttons. Session titles come from
`custom-title`, `ai-title` and `summary` records, in that order, before the first prompt.

**Live usage via status line** (`claude/statusline.ts`, `claude/usageLive.ts`,
`resources/arcode-statusline.py`). Plan percentages exist only in Claude Code's status line input.
On an explicit click ARcode installs its script into `<userData>` and points `statusLine` in
`~/.claude/settings.json` at it (backup kept, atomic write, refuses when another status line is set).
The script writes one JSON record per session to `<userData>/usage`; `LiveUsageWatcher` broadcasts
them to all windows (ADR 0005).

**Notifications** (`notifications.ts`, `terminal/ipc.ts`). When a Claude process owned by a
window's pty starts waiting for the user and the window is not focused, a system notification is
shown once per waiting period; the dock badge counts waiting tabs that are not being looked at.
The renderer reports its tab titles per pty (`TerminalChannel.TabTitles`, validated by
`sanitizeTabTitles`), so the notification is titled with the project and names the tab. A click
sends the pty back (`TerminalChannel.FocusPty`); the window turns it into the `focusPanel` and
`focusPty` bus events. Shown notifications are held in a small set so their click handlers survive
garbage collection. The `notificationSound` setting (state.json, off by default) maps to the
notification's `silent` flag. Cmd+Shift+J (`shortcuts.ts`, plus a menu item) jumps to the next
waiting tab (`terminal/waiting.ts`).

**Open requests** (`openRequests.ts`). Paths from `open -a ARcode <path>`, Finder and second launches
open folders as projects and files in the window whose root contains them, else in a window for
the enclosing git repository (ADR 0009).

## IPC conventions

- Contracts live only in `src/shared`: a `XxxChannel` constant object per module and the payload
  and API types. `window.acode` is typed as `AcodeApi & AcodeAppApi`.
- Main: each module exposes `registerXxxIpc(ipcMain, ...deps)`; `index.ts` calls them once after
  `app.whenReady()` in the primary instance. Per-window channels (terminal, IDE) are registered once
  and routed by `event.sender`.
- Arguments arrive as `unknown` and are checked with `main/ipcArgs.ts`. `invoke` handlers throw
  on bad input (the renderer's promise rejects); `send` handlers ignore it, because a throw there
  would be an uncaught exception in main. A handler that takes a project root checks it is an
  absolute existing folder.
- Readers that fail on missing or malformed files return empty results instead of throwing; the
  viewer returns `{ kind: 'error' }` and `{ ok: false }` results.
- Preload bridges are thin maps from methods to `ipcRenderer.invoke`/`send`; events use the shared
  `subscribe` helper, which returns an unsubscribe function and hides the IPC event object.
- Inside a renderer, panels talk through `bus.ts` rather than importing each other.

## Data on disk

| Location | Written by ARcode | Contents |
|---|---|---|
| `~/Library/Application Support/ARcode/state.json` | yes | Recent projects, open windows, bounds, layout, terminal tabs, viewer tabs, recent files, settings (`autosave`). Atomic, debounced. |
| `.../ARcode/paste/` | yes | Images pasted into the terminal composer; files older than 7 days removed at startup. |
| `.../ARcode/history/<project hash>/<encoded path>/<timestamp>-<save or external>.txt` | yes | Local history snapshots of project text files (1 MB cap, 50 per file); older than 14 days removed at startup. |
| `.../ARcode/usage/<sessionId>.json` | by the status line script | Live usage records; the script prunes them after 7 days. |
| `.../ARcode/arcode-statusline.py` | yes | Installed copy of the status line script. |
| `~/.claude/ide/<port>.lock` | yes | IDE bridge lock file (mode 0600), removed when the window closes. |
| `~/.claude/settings.json` | only on the status line switch | `statusLine` entry added or removed; timestamped backup next to it. |
| `~/.claude/projects`, `sessions`, `plugins`, `agents`, `skills`, `CLAUDE.md`, `~/.claude.json`, project `.claude/` and `.mcp.json` | never | Read-only sources of the Claude panel, the Claude feed, sessions, usage and model badge. |

Renderer-only preferences (terminal font size, expanded tree folders, import dialog sort) are in
`localStorage`.

## Dependencies

```
                 src/shared  (contracts, pure helpers)
                 ^    ^    ^
                 |    |    |
   src/renderer -+    |    +- src/main
        |             |          |
   window.acode <- src/preload   +- windows / projects / state
                    (contextBridge)  +- files (paths guard) <- viewer
                                     +- terminal -> claude/transcripts
                                     +- claude (readers, status line)
                                     +- ide (bridge) <- ideHost
```

Arrows point at what a module imports. The renderer never imports main code; main never imports
renderer code; both depend on `src/shared`.

## Tooling

- `scripts/gates.sh`: the one definition of the quality gates (lint and typecheck, test, build,
  and a `deploy` preflight that never ships). The header Gate buttons run it in the open project.
- `scripts/install-app.sh` and `scripts/make-icon.sh`: packaging into `/Applications` and building
  the app icon from `design/icon.svg`.
- `scripts/demo/`: `sandbox.mjs` builds a throwaway environment (fake home with a made-up project
  and Claude Code session, a stand-in `claude`, a separate user data folder); `launch.mjs` starts
  the built app in it through Playwright's Electron driver; `screenshots.mjs` uses both to
  regenerate `docs/screenshots/`. They need `pnpm build` first and never touch the real home folder.
- Development-only hooks in main, inactive unless their environment variable is set:
  `screens.ts` (`ARCODE_SCREENS=<dir>` captures the project window and the switcher, then quits),
  `selftest.ts` (`ARCODE_SELFTEST=1` drives a window with synthetic key events and prints process
  metrics), `background.ts` (`ARCODE_BACKGROUND=1` keeps the app out of the Dock and shows windows
  without taking focus; the demo and bench scripts set it) and `ARCODE_IDE_LOG` (logs IDE bridge
  traffic).
- `scripts/bench/` (app-level timings, memory and CPU through the same launcher) and
  `src/**/*.bench.ts` (Vitest micro-benchmarks); results and method in `docs/BENCHMARKS.md`.
