# Benchmarks

How fast and how heavy ARcode is, measured on one machine with scripts that are in this repository.
Every number below was measured; nothing is estimated or copied from elsewhere.

## Machine

| | |
|---|---|
| CPU | Apple M4 Pro, 12 cores |
| Memory | 24 GB |
| OS | macOS 26.6.2 (25G83) |
| Electron | 44.7.0 |
| Node.js (benchmark runner, Vitest) | 22.23.1 |

Measured on 2026-10-16 on a laptop in normal use (other apps open), on power.

## How to reproduce

```bash
pnpm build                       # the app-level suite runs the production bundle in out/
node scripts/bench/run.mjs       # app-level suite, prints Markdown tables (about 2 minutes)
node scripts/bench/run.mjs --runs 5 --only startup        # more cold-start runs
node scripts/bench/run.mjs --json bench.json              # raw numbers too
pnpm vitest bench --run          # micro-benchmarks of the hot pure functions (about 15 s)
```

The app-level suite (`scripts/bench/`) starts the built app through Playwright's Electron driver
(`scripts/demo/launch.mjs`) inside a throwaway sandbox under `$TMPDIR/acode-bench`: a fake `$HOME`
with a made-up project, a made-up Claude Code session, a stand-in `claude` script and a separate
Electron user data folder. It never reads your own `~/.claude` and never calls a model.

To open as few windows as possible, the suite launches the app `--runs` times (default 3) for cold
start only, then once more for everything else, in this order: idle memory and CPU with one
project window, the Claude feed on a small and a 50 MB transcript, then a second window on a large
generated project for the file tree and "go to file". The app is closed when that is done.

## Results

### Startup

Wall clock from spawning the Electron process to each milestone, 5 launches after one uncounted
warm-up launch, median (min-max).

| Milestone | Time |
|---|---|
| Project window visible | 243 ms (236-273) |
| Terminal mounted (xterm in the DOM) | 414 ms (407-448) |
| Shell prompt drawn (zsh `precmd` hook stamps the time) | 395 ms (387-440) |
| File tree: first row | 515 ms (506-550) |
| First terminal frame, as the app logs it (from main process start) | 347 ms (330-369) |

The very first launch on a fresh sandbox (empty Chromium caches) was slower in every run of the
suite: window visible at 735-762 ms, first tree row at 1046-1263 ms.

### Memory and idle CPU

One launch, memory read 5 s after each step, CPU averaged over the following 10 s. "Working set"
is the sum of `workingSetSize` over every Electron process from `app.getAppMetrics()` (resident
memory, shared pages counted once per process). "Physical footprint" is what Activity Monitor's
Memory column shows, read with macOS `footprint` for the same processes. Shells and the `claude`
processes the terminal runs are not part of either number.

| State | Working set | Physical footprint | Working set by process type | Idle CPU (% of one core) |
|---|---|---|---|---|
| One project window, shell tab | 432 MB | 381 MB | main 153, GPU 90, renderer 149, utility 41 MB | 1.4 % |
| Plus 6 resumed Claude tabs, feed showing a 50 MB session | 508 MB | 488 MB | main 183, GPU 87, renderer 197, utility 41 MB | 1.3 % |
| Plus a second window on a 35,001-file project | 625 MB | 606 MB | main 178, GPU 91, renderers 317, utility 39 MB | 0.6 % |

An earlier run with one launch per sample (5 launches per state) gave the same picture: one project
window at 427 MB working set (413-489) and 387 MB footprint (386-389), idle CPU 1.9 % (1.2-3.3).
Idle CPU is mostly the GPU and renderer processes; the blinking terminal cursor and the feed's
1 s poll (while the window has focus) are the likely sources.

### Claude feed

The feed never reads a whole transcript: the first load reads backwards from the end until it has
40 prompts and replies (at most 4 MB), live updates read only appended bytes. Same launch as above.
The 50 MB transcript is synthetic: repeated turns of a prompt, a reply, a Read with an 8 KB file,
an Edit, a Bash run and a closing reply.

| Measurement | Demo transcript (17 KB) | Large transcript (50 MB) |
|---|---|---|
| Show a resumed session: click the feed tab to last message on screen (3 times each) | 41 ms (37-43) | 41 ms (37-48) |
| First load over IPC from the renderer: tail read, parse, transfer (10 reads) | 0.4 ms (0.2-0.7) | 0.9 ms (0.7-1.2) |
| Live poll over IPC, nothing new (10 reads) | 0.10 ms | 0.05 ms |
| "Load earlier" over IPC, from the middle of the file (10 reads) | 0.3 ms | 0.8 ms |
| "Load earlier" button: click to new rows in the DOM | n/a (whole file loaded) | 9 ms |
| Bytes read by the first load / feed items | 17 KB / 15 | 255 KB / 105 |

Opening the large session costs the same as the small one because only its last 255 KB are read.

### Large project

A generated git repository with 35,001 committed files: 20,000 in nested folders and three flat
folders of 5,000 files each. Opened as a second window in the same launch, median (min-max).

| Measurement | Time |
|---|---|
| Open project to first file tree row | 389 ms |
| Expand a folder with 5,000 files: click to first child row (3 folders) | 1305 ms (1302-1317) |
| List such a folder over IPC (`readdir` and one `git check-ignore` call) | 879 ms (867-889) |
| `git ls-files -co --exclude-standard -z`, what the file index runs (outside the app) | 35 ms (34-38) |
| Go to file over IPC, first query (the index is built when the window opens) | 11 ms |
| Go to file over IPC, later queries: rank all paths, return the top 50 | 4.0 ms (3.7-7.3) |
| Go to file in the UI: input change to results in the DOM | 4.8 ms (4.3-5.6) |

Expanding a folder with thousands of files is the slowest thing measured here, and nearly all of
it is `git check-ignore` in the main process: the same call on the 5,000 paths takes about 0.65 s
from a shell in a 25,001-file repository. Folders of normal size are not affected.

### Micro-benchmarks (Vitest)

`pnpm vitest bench --run`, synthetic inputs generated in the bench files, mean time per call.

| Function | Input | Mean |
|---|---|---|
| `readFeed`, first load (tail) | 50 MB transcript | 0.48 ms |
| `readFeed`, "load earlier" from the middle | 50 MB transcript | 0.48 ms |
| `readFeed`, live poll with nothing new | 50 MB transcript | 0.011 ms |
| `readFeed`, live poll with 64 KB new | 50 MB transcript | 0.18 ms |
| `splitLines` | 4 MB of transcript | 0.86 ms |
| `parseFeedLines` | 4 MB of transcript | 5.7 ms |
| `summarizeUsage` (reads whole transcripts) | one 50 MB transcript | 162 ms |
| `rankPaths` ("go to file"), typical query | 50,000 paths | 20 ms |
| `rankPaths`, typical query | 200,000 paths | 82 ms |
| `parsePorcelainV2` (git status) | 1,000 changed files | 0.33 ms |
| `parsePorcelainV2` | 20,000 changed files | 7.9 ms |
| `aggregateDirs` (changed folders) | 20,000 changed files | 11 ms |

The 50,000 bench paths are longer and match the queries more often than the generated project's
file names, which is why ranking there is slower than "go to file" in the app table.

### On-disk size

`du -sk`, allocated size on disk. Sizes of other apps are for context only: they are what is
installed on this machine, not a feature comparison.

| Bundle | Size |
|---|---|
| ARcode `out/` (bundled JS, CSS, assets) | 5 MB |
| ARcode.app (`pnpm dist`, unsigned) | 256 MB |
| of which Electron Framework | 238 MB |
| of which `app.asar` | 15 MB |
| Cursor.app | 970 MB |
| PhpStorm.app | 2595 MB |

Visual Studio Code is not installed on this machine, so it is not listed.

## Caveats

- One machine, one day. Numbers on other hardware will differ; the scripts are here to rerun.
- The app-level suite runs the bundle in `out/` on the development Electron binary, not the
  packaged `ARcode.app`. The packaged app reads its code from `app.asar`; startup may differ a little.
- Times are wall clock from the benchmark process and include Playwright's own overhead (a few
  milliseconds per step). Renderer-side times (IPC, "go to file", "load earlier") are taken with
  `performance.now()` inside the page.
- Startup runs after the first one see a warm OS file cache and warm Chromium caches. That is an
  ordinary launch on a machine that has run the app before, not a first launch after a reboot.
- Memory and idle CPU values are from single samples per state in the final run. Working set
  counts shared pages in each process, so it is higher than the physical footprint.
- Feed and project inputs are synthetic. Real transcripts with larger tool results per turn make
  the first feed load read more bytes, up to its 4 MB cap.
- The machine was in normal use during the runs; background activity adds noise, mostly to the
  max values.
