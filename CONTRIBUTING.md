# Contributing to ARcode

Thanks for helping. ARcode is a small project, so the process is light: open an issue for anything
larger than a fix, keep pull requests focused, and make the gates green before you ask for review.

## Development setup

Requirements:

- macOS (ARcode is macOS only)
- Node.js 22.12 or later
- pnpm 10
- Xcode Command Line Tools (`xcode-select --install`), needed to compile `node-pty` against
  Electron's headers

```bash
pnpm install   # also downloads the Electron binary and rebuilds node-pty for Electron
pnpm dev       # run the app with hot reload
```

`ARCODE_CWD=<folder> pnpm dev` opens that folder directly. ARcode is single instance: if an installed
ARcode is running, a dev build forwards its arguments to it and quits. Quit the installed app first,
or pass a different user data folder.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the app with hot reload. |
| `pnpm typecheck` | TypeScript for the main/preload and renderer projects. |
| `pnpm lint` | ESLint with zero warnings allowed. |
| `pnpm test` | Vitest. |
| `pnpm build` | Production bundle into `out/`. |
| `pnpm start` | Run the production bundle. |
| `pnpm dist` | Package `dist/mac-arm64/ARcode.app` (unsigned). |
| `pnpm rebuild:native` | Rebuild `node-pty` after an Electron upgrade. |
| `pnpm screenshots` | Regenerate `docs/screenshots/` (see below). |
| `scripts/gates.sh all` | Lint + typecheck, tests and build in one go. |
| `scripts/install-app.sh` | Build and install into `/Applications`. |

## Project layout

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: it describes the process model (main,
preload, renderer, shared), the module map, IPC conventions and the files ARcode reads and writes.
Design decisions are recorded in [docs/decisions/](docs/decisions/).

## Conventions

- **IPC contracts live in `src/shared`.** Each module has a `XxxChannel` constant object and its
  payload and API types there. Main registers handlers through `registerXxxIpc(...)`; the preload
  maps methods to `ipcRenderer.invoke`/`send`. Arguments arrive as `unknown` and are validated with
  `src/main/ipcArgs.ts`.
- **One path guard.** Every project-relative path from the renderer goes through
  `src/main/files/paths.ts` (`resolveInside` / `resolveEntryInside`). Do not add another check
  (ADR 0010).
- **Never write to `~/.claude`** except the IDE lock files and the opt-in status line entry
  (ADR 0004, 0005). Readers of Claude Code files tolerate missing and malformed input.
- **Background git** goes through `runGit` with `GIT_OPTIONAL_LOCKS=0` (ADR 0007).
- **Zero lint warnings.** `pnpm lint` runs with `--max-warnings 0`; a warning fails the gate.
- **Tests next to code** as `*.test.ts` (for example `src/main/files/paths.test.ts`). Keep logic
  that needs testing free of Electron and DOM types so it can run in Vitest.
- **Renderer stays thin.** No Node access in the renderer; panels talk through `bus.ts` rather than
  importing each other.
- **ADRs for decisions.** A change that alters an architectural rule or adds a new one gets a short
  record in `docs/decisions/NNNN-title.md` (Context, Decision, Consequences).
- Keep code comments and docs in plain English.

## Before opening a pull request

Run the full gate and make sure it ends with `GATES GREEN`:

```bash
scripts/gates.sh all
```

This runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build`, the same steps CI runs
(`.github/workflows/ci.yml`). The same script backs the Gate buttons in ARcode's header, so you can
also run it from there.

In the pull request, describe what changed and how you checked it. For UI changes, attach a
screenshot.

## Screenshots

The images in `docs/screenshots/` are generated, not taken by hand:

```bash
pnpm build
pnpm screenshots
```

`scripts/demo/screenshots.mjs` builds a throwaway sandbox (`scripts/demo/sandbox.mjs`: a fake home
folder with a made-up project and Claude Code session, a stand-in `claude` command and a separate
user data folder), launches the built app from `out/` through Playwright's Electron driver
(`scripts/demo/launch.mjs`) and captures each view. Nothing from your own home folder or
`~/.claude` is used, and no model is called. Run `pnpm build` first, since the script drives the
production bundle.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
