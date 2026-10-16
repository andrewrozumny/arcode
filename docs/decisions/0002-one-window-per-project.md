# 0002. One window per project

## Context

Users run several agent sessions on several projects at once. A single window with project tabs
would share one terminal dock, one tree and one IDE bridge between unrelated projects, and Claude
Code identifies an IDE by its workspace folders.

## Decision

Each project root gets its own `BrowserWindow`. The root is resolved (`path.resolve`) before
lookup, so `a/b/` and `a/b/../b` focus the same window. A window owns its ptys, its IDE bridge
and its Claude session watcher; IPC from a renderer is routed to its window by `event.sender`.
Bounds, panel layout and terminal tabs are saved per root in `state.json`, and windows open at
quit are reopened at start.

## Consequences

- Terminals, the IDE bridge (one lock file per window listing its root) and notifications are
  naturally scoped to a project; macOS window management (Mission Control, Cmd+`) works per project.
- The window title stays the project name.
- Global state (live usage records, the dock badge) is aggregated across windows in main.
- Closing a window kills its ptys; reloading a window does too, since the new page cannot reattach.
