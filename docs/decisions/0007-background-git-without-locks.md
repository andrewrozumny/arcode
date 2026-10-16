# 0007. Background git runs with GIT_OPTIONAL_LOCKS=0

## Context

The tree and viewer tabs show git status, recomputed whenever the file watcher sees a change.
`git status` normally refreshes the index and takes `.git/index.lock` to do so. While the user (or
Claude Code) commits in the terminal, a background status could hold that lock and make the
commit fail, and the rewritten index wakes the watcher for yet another status run.

## Decision

Every git command Acode runs in the background goes through `runGit`, which sets
`GIT_OPTIONAL_LOCKS=0`. Changes in `.git` itself are filtered: only `index`, `HEAD` and `refs`
trigger a status recompute.

## Consequences

- Acode never blocks the user's own git commands and does not feed its own watcher.
- Status may cost a little more on large repositories because the index stat cache is not
  refreshed by Acode; the user's own git commands refresh it.
