# 0006. Act as an IDE through Claude Code's own IDE protocol

## Context

Claude Code integrates with IDEs (diff review before edits, opening files, sharing the current
selection, @-mentions) through a WebSocket MCP server announced by a lock file in
`~/.claude/ide`. Acode already has a viewer and a diff editor, so it can play that role.

## Decision

Each project window starts its own bridge: a WebSocket server on 127.0.0.1 with the `mcp`
subprotocol, a random 64-byte token checked on connect, and a lock file (mode 0600) naming the
window's root. Terminals of the window get `CLAUDE_CODE_SSE_PORT` so Claude Code connects at once.
`openDiff` waits for the user's decision without a timeout; closing the window resolves pending
diffs as closed. Malformed messages are answered with JSON-RPC errors.

## Consequences

- Diff review, open file and selection sharing work with the stock Claude Code CLI.
- Tools Acode cannot serve meaningfully (diagnostics, reformat) answer with empty results.
- The lock file is removed on stop and on process exit; a crash can leave a stale one, which
  Claude Code ignores once the port is closed.
