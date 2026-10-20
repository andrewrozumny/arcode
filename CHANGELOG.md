# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
