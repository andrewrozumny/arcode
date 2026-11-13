# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Voice input in the composer.** A microphone button (or Cmd+Shift+M) records a prompt and
  inserts the recognised text at the caret. Recognition runs locally with whisper.cpp
  (`whisper-cli` plus a ggml model in `~/models/whisper`), Russian by default
  (`ARCODE_WHISPER_LANG` changes it). Esc discards a recording; missing tools, models or
  microphone access are explained inline.
- **Voice chat with Claude.** A floating microphone (drag it anywhere; it starts above the arCode
  mark) or Cmd+Shift+Space turns on hands-free talk: each phrase is sent to the Claude tab after a
  pause, recognised locally like dictation, and listening resumes once Claude has answered.
- **Dictation button in the terminal.** Dictation (Cmd+Shift+D) sits next to Claude's prompt and
  either types into it or sends each phrase.
- **Discussion.** The floating button (Cmd+Shift+Space) is a voice discussion about the work in your
  Claude Code session with a separate, fast Claude conversation that sees what happened there but never
  changes anything. Answers stream into a window and are read aloud sentence by sentence. Saying
  "pass it to Claude Code" (or **→ Claude Code**) sends the resulting task to the Claude tab. **■ Stop**
  ends a reading, the speaker switch turns reading off, and a ring shows the ElevenLabs allowance.
  A Sonnet / Opus switch picks the partner's model. The discussion lives in a resizable, collapsible
  column on the right of the viewer (width and state saved per project), and the Claude feed and the
  Markdown preview now fill the viewer's width instead of a centred column. Only one voice button listens at a
  time.
- **Voice modes.** The voice button has three modes: Dictation types into Claude's prompt without
  Enter so you can keep talking or edit, Commands sends each phrase, Conversation also reads
  Claude's answer aloud without code. It listens only while ARcode is the active window, and
  phrases go out while Claude works (they are queued like typed messages).
- **Answers read aloud by ElevenLabs, Silero or the macOS voice.** ElevenLabs is opt-in (an API key
  in the Keychain) and marked as cloud on the button; Silero is a neural Russian voice that runs on
  the Mac.
- **Queued messages in the feed.** Messages sent while Claude is busy show at once, muted and
  marked Queued, and join the conversation when Claude takes them. A queue Claude Code dropped (a
  restart, `popAll`) no longer leaves a message stuck as queued.
- **Disconnect Remote Control** from the RC button.
- **Switch the model from the header.** Click the model badge of the active Claude tab and pick
  Fable, Opus, Sonnet, Haiku or the account default; ARcode types `/model <id>` into the tab.
  Offered only while Claude waits at an empty prompt.
- **Remote Control button.** **RC** types `/remote-control` into the active Claude tab and shows
  whether it came up (`RC…`, **RC on** with Open in browser and Copy link, or **RC failed** after
  30 seconds), read from the bridge session id Claude Code writes to its process registry.
- **Activity lamp.** A light next to the project name blinks orange while anything runs in the
  window's terminals (Claude working, a command, a gate, a shell command Claude left running in the
  background), stays orange while Claude waits for you and turns green when everything is done. A
  click lists what runs and jumps to its tab.

### Fixed

- **The feed follows a `claude` started by hand.** Quitting Claude Code and running `claude`
  again in the same tab used to leave the Claude feed on the old session; the tab now takes the
  new session id. Running `claude` in a shell tab turns it into a Claude tab, so the feed, the
  header and resume after a restart follow it as well.

## [0.3.0] - 2026-10-21

### Added

- **Split terminal.** Cmd+\ (Terminal > Split Right, or the split button in the tab strip) opens a
  shell in a second dock column, for example Claude on the left and a shell or gates on the right.
  Each column has its own tab strip and active tab, with the existing divider between them. Right
  click a tab for Move to Other Side; closing the last tab of a column returns to one column.
  Keyboard commands, the composer, search, new tabs and gates act on the focused column, and jumping
  to a waiting tab finds it in either column. The split and its ratio are saved per project with the
  tabs; older saved state loads as one column.
- **Open past sessions in the feed.** **Open** next to Resume in the Claude panel's Sessions list
  and Overview opens a session read-only in a closable viewer tab; the pinned Claude feed keeps
  following the active Claude tab. Sessions are titled by the name Claude Code saved for them
  (`/rename` or its generated title) when there is one.
- **Subagent transcripts.** Agent cards in the feed and the header subagent chip have
  **Open transcript**, which opens the agent's own conversation in a tab that updates live while
  it runs.
- **Tokens and time per turn.** Each finished turn in the feed gets a muted chip such as
  `12.4k in · 1.1k out · 38 s` (cache reads and writes in the tooltip), and a thin strip at the top
  of the feed shows the session total.
- **Markdown split view.** A third Split segment in the Markdown switch shows the editor and a live
  preview side by side (re-rendered about 150 ms after typing stops, autosave unchanged), with a
  resizable divider and approximate scroll sync in both directions through source line markers on
  the rendered blocks. A narrow viewer stacks the preview under the editor. The chosen mode is
  remembered per file type.
- **Local history.** ARcode keeps its own copies of text files in the project, independent of git:
  before it saves a file (throttled to one per 5 minutes during autosave unless the change is large)
  and when an open file changes on disk from outside, for example when Claude Code edits it. The
  History button in the file header lists versions with their age; picking one shows a diff against
  the current file with a Restore action. Text files up to 1 MB, 50 versions per file, kept 14 days
  under `<userData>/history`.
- **Find the Claude tab that waits for you.** Clicking a "Claude is waiting" notification brings the
  window forward, shows the terminal and selects that exact tab. Cmd+Shift+J (Terminal > Jump to
  Waiting Claude Tab) cycles through the waiting tabs of the window, with a short hint when none
  waits. Waiting tabs get a pulsing coral dot. Notifications name the project and the tab and say
  what Claude waits for. Terminal > Notification Sound (on by default, as before) plays the macOS
  sound with them.
- **Local history for files that are not open.** Outside changes to any project text file are kept
  too, not only to files open in a tab. The previous content comes from a bounded in-memory cache
  (about 64 MB) or, the first time a file is seen changing, from its HEAD version, so the first
  Claude Code edit of a committed file can be undone. Gitignored files are skipped, one version per
  file per 10 seconds, and bulk changes of more than 100 files (checkout, rebase) are skipped and
  logged once.
- **Autosave.** Edited files are saved about a second after the last change, when the window loses
  focus, when another tab is selected and when the tab closes, so Claude Code reads what you see.
  Never while a changed-on-disk, conflict, deleted or error banner is shown. On by default;
  File > Autosave turns it off. Cmd+S still saves at once.
- **Type to edit.** Typing a character in a read-only file switches to edit mode and inserts it.
- **Viewer tabs are restored** per project after a restart (file tabs and the active one; files
  deleted since are skipped, diff and panel tabs are not kept).
- **Recent files.** ARcode remembers the last 30 files opened per project. Cmd+P with an empty
  query lists them first; Cmd+Shift+E opens the palette with recent files only.
- **Cmd+D duplicates** the line or the selection in edit mode, Ctrl+G adds the next occurrence, as in
  JetBrains IDEs. Several cursors (Cmd+click), column selection (Alt+drag), Cmd+Shift+Up/Down to
  move a line, auto-closed brackets and quotes.
- **Composer history per project** (200 prompts) with Ctrl+R search.
- **PDF viewer.** `.pdf` files open in a read-only viewer tab (from the tree, Go to file, paths in
  the terminal and the Claude feed, and `open -a ARcode file.pdf`) with paging, zoom, thumbnails and
  scrolling from Chromium's built-in PDF viewer. The tab reloads when the file changes on disk.
  When `foo.md` sits next to `foo.pdf`, a button opens the Markdown source. PDFs are served
  through a guarded `arcode-pdf:` protocol that reads only PDFs inside open projects.
- **Find in files** (Cmd+Shift+F). A search mode in the left column with live results grouped by
  file, match counts and highlighting, case, whole word and regex toggles, a file mask with
  exclusions, keyboard navigation and Enter to open at the matched line and column. The editor
  selection becomes the query. Runs ripgrep when installed, else `git grep`, else a built-in scan
  that honors `.gitignore`; results are capped and a newer query cancels the running one.
- **Answer Claude from the feed.** Question cards (AskUserQuestion), plan approvals and permission
  prompts have buttons while Claude waits on them; ARcode types the matching keys into the Claude
  tab's terminal. Typed answers work for single-choice questions; anything else falls back to the
  terminal with one click.
- Plan cards show the plan Claude Code wrote to its plan file when ExitPlanMode has no input.
- **Changes** (Ctrl+Shift+G). A third mode of the left column that lists every file changed against
  HEAD (modified, added, deleted, renamed, untracked) grouped by folder, with status letters in the
  tree colours, +/- line counts from `git diff --numstat` and totals. It updates live as files change.
  Click or Enter opens the file with its diff against HEAD already shown; a deleted file opens its
  HEAD version as a read-only diff. Up and Down move, Esc returns to the tree, "Open all diffs"
  opens every changed file. Read-only: no stage, commit or revert.

### Changed

- The pinned Claude feed tab and the Claude button in the activity bar are coral, so they are easy
  to find. The ARcode mark sits in the corner of every viewer tab.
- **Friendlier Claude panel.** Sections now sit in a side navigation with icons, item counts and a
  red dot on sections with a problem, under a title and a one-line explanation of each section.
  The panel remembers the last section.
- **Overview section** (new, first): the current session with model and bars for context, the
  5-hour and the weekly limit; quick actions (resume last session, new Claude tab, open CLAUDE.md,
  check MCP servers); setup tiles with counts per kind; a list of things worth a look (failing MCP
  servers, missing CLAUDE.md, hooks that run, plan usage hidden); recent sessions; and one search
  across skills, agents, plugins, MCP servers and hooks.
- **Item rows** show a readable name, a one-line description, a scope badge and the file path with a
  copy button. Clicking opens the file in the viewer when it is inside the project, otherwise it
  expands a read-only preview.
- **Empty sections** explain what the feature is and where its files go instead of showing a blank
  list.
- **Sessions** are grouped by day, show relative age, message count and start time, mark the
  latest one, and have a New Claude tab button.
- **MCP servers** are listed from the settings files right away; the status check adds live state
  and a summary line.
- **CLAUDE.md** files show as cards with line counts, and missing files say how to create them.
- **Usage** shows plan windows and context as bars.
- **Faster Usage refresh:** parsed sessions are cached by size and modification time, so the
  30-second refresh re-reads only sessions that grew.

### Fixed

- **Feed formatting.** Line breaks in Claude's replies are kept as in the terminal; numbered lists
  that start after 1 right under a label, and `•` bullets, render as lists instead of one run-on
  paragraph; long inline code, paths and links wrap instead of overflowing the column; wide tables
  scroll in their own box.

## [0.2.0] - 2026-10-21

### Changed

- **Renamed from Acode to ARcode**, with a new icon. The name Acode was already taken by an
  Android code editor. The bundle id is now `io.github.andrewrozumny.arcode` and development
  environment variables use the `ARCODE_` prefix.

### Added

- **Upgrade from Acode.** On the first start ARcode copies recent projects, layout, terminal tabs
  and live usage records from `~/Library/Application Support/Acode` (the old folder is kept), and
  re-points an enabled Acode status line at the new script.

## [0.1.0] - 2026-10-16

First public release.

### Added

- **Project windows.** One window per project, reopened at start. Project switcher (Cmd+Shift+O)
  with recent projects and an optional read-only SQLite project registry. Single instance:
  `open -a ARcode <file or folder>` routes to the window that owns the path.
- **File tree.** Lazy and virtualised, respects `.gitignore`, marks git changes, follows changes on
  disk. Fuzzy file search (Cmd+P), create, rename, move to Trash, copy and paste files with Finder,
  drag and drop from Finder, and an Import from Mac dialog (Screenshots, Downloads, Recent).
- **File viewer.** Syntax highlighting, edit mode with conflict detection on save, go to line,
  diff against HEAD (side by side or unified), Markdown preview, SVG and image viewing with zoom
  and pan, current git branch in the header.
- **Terminal.** Shell, Claude and gate tabs on login shells; clickable file links (`path:line`);
  multi-line composer; search; images pasted into the composer saved as files; tabs restored after
  restart with a choice to continue the previous Claude session; live Claude status per tab.
- **Claude Code integration.** Built-in IDE bridge (diff review with accept and reject, open file,
  selection sharing, @-mentions) that Claude Code joins without `/ide`. Header model badge, running
  subagents and context, 5-hour and weekly usage bars.
- **Opt-in status line** that feeds live plan usage to ARcode, written to `~/.claude/settings.json`
  only on an explicit click, with a backup, and refused when another status line is configured.
- **Claude feed.** A pinned viewer tab that shows the active Claude session as a live conversation:
  Markdown answers with highlighted code and file links, tool calls that expand into diffs and
  output, task, agent, question and plan cards, and a working indicator.
- **Claude panel.** Sessions (with resume), skills, plugins, MCP servers, agents, hooks, CLAUDE.md
  files, token usage and a gates overview.
- **Quality gates.** Header buttons run `scripts/gates.sh <target>` in the open project, a
  convention any project can adopt.
- **Notifications** when a Claude session waits for you in a background window, and a Dock badge
  counting waiting tabs.

[0.1.0]: https://github.com/andrewrozumny/arcode/releases/tag/v0.1.0
