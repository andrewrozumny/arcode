# 0003. Bundled JetBrains Mono with explicit subset loading

## Context

The terminal and editor need one monospace font with consistent cell metrics on every Mac,
whether or not the user installed it. xterm.js measures cells once and draws on a canvas.
Web fonts declared with `unicode-range` are downloaded lazily, only when the DOM renders a
character from that range; canvas drawing never triggers that, so Cyrillic or Greek output fell
back to Menlo with a different width.

## Decision

Bundle JetBrains Mono (variable, OFL, from `@fontsource-variable`) and register it from
`theme/fonts.ts` with `FontFace` for each subset (Latin, Latin Extended, Cyrillic, Cyrillic
Extended, Greek). Every subset is loaded explicitly, and the project window waits for the fonts
(together with the saved layout and tabs) before the terminal mounts.

## Consequences

- Cell metrics are measured once with the final font; no relayout after a late font swap.
- All subsets ship with the app (a few hundred KB) even if a user never needs them.
- Scripts outside the bundled subsets still fall back to a system font.
