# 0005. Live plan usage only through an opt-in status line

## Context

Users want to see how much of the 5-hour and weekly plan limits they have used. That figure is
not stored on disk. Claude Code passes it, with the context fill and the model, only to the status
line command it runs after each update. Two other routes exist: the undocumented HTTP endpoint
the Claude apps call, and the OAuth tokens Claude Code keeps in the macOS Keychain.

## Decision

Acode ships `resources/acode-statusline.py`. Only when the user clicks the switch in the Claude
panel, Acode installs the script into its data folder and sets `statusLine` in
`~/.claude/settings.json` to run it. It refuses when another status line is configured, keeps a
timestamped backup and writes atomically, following a symlinked settings file. The script writes
a small JSON record per session into `<userData>/usage`, which main watches and broadcasts.
Acode does not call the undocumented endpoint and does not read Keychain tokens.

## Consequences

- No credentials are touched and no private API can break or get the account flagged.
- Usage appears only after the user opts in and after the first reply of a session; without the
  switch the panel shows token counts from transcripts instead.
- Users with their own status line keep it; they get no live percentages.
- The script must never break Claude Code: it guards every step and always exits 0.
