# 0004. Read Claude Code state from ~/.claude files, never write it

## Context

The Claude panel, the session list, the model badge, waiting notifications and token usage all
describe what Claude Code is doing. Claude Code has no public API for its sessions, transcripts or
configuration, but it keeps them in documented or stable files: `~/.claude/projects/<slug>/*.jsonl`
transcripts, the `~/.claude/sessions/<pid>.json` process registry, settings files, plugin
records, skills and agents folders.

## Decision

ARcode reads these files and treats them as untrusted, possibly half-written input: every reader
tolerates missing files and malformed lines and returns empty results. ARcode never writes to
`~/.claude`, with two exceptions: the IDE lock files it owns in `~/.claude/ide`, and the opt-in
status line entry (ADR 0005). Locating and reading transcripts goes through one module,
`main/claude/transcripts.ts`.

## Consequences

- No credentials are needed and nothing can corrupt the user's Claude Code setup.
- The formats are not a contract; a Claude Code update can change them. Readers are written to
  degrade (show nothing) rather than fail, and the parsing is isolated in a few modules.
- Reading is file I/O on the main process, so readers on IPC and timer paths are async with
  bounded concurrency and read only the head or tail of a transcript where possible.
