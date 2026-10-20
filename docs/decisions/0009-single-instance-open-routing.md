# 0009. Single instance with open-request routing

## Context

ARcode can be started from the Dock, from Finder, and from the command line (`open -a ARcode <path>`).
Two running instances would fight over `state.json`, spawn duplicate IDE bridges and open the same
project twice.

## Decision

The app takes Electron's single-instance lock. A second launch quits immediately (before opening
windows, spawning shells or writing state) and forwards its arguments to the primary instance.
`OpenRequestRouter` handles every incoming path, including macOS `open-file` events that may
arrive before `ready` (they are queued): a folder opens or focuses its project window; a file opens
in the window whose root contains it, else in a new window for its enclosing git repository, else
for its folder.

## Consequences

- `open -a ARcode file.ts` from any terminal lands in the right project window.
- A development build with the same app name forwards to an installed, running ARcode instead of
  starting; use a different user data folder to run both.
- `scripts/install-app.sh` cannot replace a running instance cleanly from inside it; quit ARcode
  manually before installing from an ARcode terminal.
