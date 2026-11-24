---
name: run-git-sidebar
description: Run, launch, drive and screenshot the git-sidebar plugin in a real Fresh editor, and run its checks. Use when asked to start or try git-sidebar live, click, stage, unstage or open a diff in its Git section, run a palette command, confirm a change works in the running editor and not just in unit tests, read the plugin's log, or capture the screen.
---

git-sidebar is a Fresh plugin, so "running it" means running Fresh with the package loaded. `.claude/skills/run-git-sidebar/driver.mjs` starts Fresh 0.5.9 in a detached tmux session, with an isolated `HOME` and socket dir, on the acceptance fixture repository. Each subcommand then sends one input (keys, an SGR mouse click, a palette command) or reads one thing back (the screen, editor state through `fresh --cmd script run`, `git status`, the log).

All paths are relative to `git-sidebar/`. Works on macOS and on Debian in Docker.

## Prerequisites

`fresh`, `tmux`, `node` (24, for the tests' type stripping) and `git` on `PATH`. The driver needs no npm packages. On Debian with Node 24 (the `node:24-bookworm-slim` image):

```bash
apt-get update
apt-get install -y --no-install-recommends tmux git ca-certificates xz-utils   # the npm installer unpacks a .tar.xz
npm install -g @fresh-editor/fresh-editor@0.5.9
```

To check on Linux from a Mac (colima shares only `$HOME`; the read-only mount is all the driver needs, since it writes only to `/tmp/gs-drive`):

```bash
docker run -d --name gs-linux -v "$PWD":/work:ro -w /work node:24-bookworm-slim sleep infinity
docker exec gs-linux sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends tmux git ca-certificates xz-utils && npm install -g @fresh-editor/fresh-editor@0.5.9'
docker exec gs-linux node .claude/skills/run-git-sidebar/driver.mjs start
docker exec gs-linux sh -c 'D=.claude/skills/run-git-sidebar/driver.mjs; node $D click "M b.md" --on "[ + ]" && node $D git status -s && node $D stop'
docker exec gs-linux npm run check
docker rm -f gs-linux
```

## Run (agent path)

```bash
D=.claude/skills/run-git-sidebar/driver.mjs
node $D start                      # ~3 s: fixture, Fresh in tmux "gs-drive", explorer shown; prints the screen
node $D click "M b.md"             # a row-body click opens the side-by-side diff
node $D wait 'b\.md \('            # tab "b.md (staged ↔ working tree)"
node $D screen --name diff-b       # prints the screen and saves /tmp/gs-drive/shots/NNN-diff-b.txt
node $D click "M b.md" --on "[ + ]"          # the row's stage button
node $D git status -s                        # M  b.md
node $D click "D gone.ts" --right            # the menu at the pointer
node $D wait 'View Diff'
node $D click "Stage" --below "D gone.ts"    # a menu item
node $D cmd "Git Sidebar: Unstage All"       # a palette command, no keystrokes
node $D click "M b.md" && node $D keys C-p && node $D type "Git Sidebar: View File" && node $D keys Enter   # palette by keys, on the selected row
node $D log                        # "git-sidebar:" debug lines plus any WARN/ERROR
node $D stop
```

`start` builds a new fixture each time with `tests/live/fixture.sh acceptance`: `main` ↑1, `a.ts` staged and modified again, `b.md` modified, `gone.ts` deleted, `old.ts → moved.ts` staged, `new/c.txt` and `new/d.txt` untracked, `build/` ignored. `--repo PATH` uses an existing repository instead. Outside a repository there is no section (R1): `start` prints the screen and exits 2.

```bash
mkdir -p /tmp/gs-drive/plain && node $D start --repo /tmp/gs-drive/plain   # exit 2: "no Git section on screen"
```

| command | what it does |
|---|---|
| `start [--repo P \| --fixture NAME] [--size 140x40] [--no-explorer]` | Stops any previous run, wipes `home/`, starts Fresh, shows the explorer |
| `screen [--color] [--name N]` | Prints the screen and saves it to `shots/` (`.txt`, or `.ansi` with `--color`) |
| `keys KEY…` / `type TEXT` | `tmux send-keys` key names (`Down`, `Space`, `Enter`, `Escape`, `C-p`) / literal text |
| `click TEXT [--on T2] [--nth N] [--below RE] [--right]` | Clicks the middle of the Nth on-screen match of TEXT, or of T2 on the same line |
| `wait RE [--gone] [--timeout MS]` | Polls the screen until RE matches (or stops matching); prints it and exits 1 on timeout |
| `eval 'JS'` / `eval -` | Runs a script in the editor; its return value prints as JSON |
| `cmd "NAME"` | `fresh --cmd command run NAME` |
| `git ARGS…` | `git -C <repo> ARGS` |
| `log [RE]` | Greps the editor log, ANSI stripped |
| `stop` | Kills the tmux session (which ends Fresh) and removes the sockets |

Actions settle (the screen is unchanged for 150 ms, at most 3 s) and print nothing unless given `--show`. Everything lives under `/tmp/gs-drive/` (`GS_DRIVE_DIR`), and the log is `home/.local/state/fresh/logs/fresh-<pid>.log`.

Read state that the screen doesn't show through `eval`. For example, the diff's sides:

```bash
node $D eval 'const o = []; for (const b of editor.listBuffers()) if (b.name !== "gs-driver-token") o.push({ id: b.id, name: b.name, text: await editor.getBufferText(b.id) }); return o;'
# [{"id":3,"name":"*Staged:b.md*","text":"# b"},{"id":5,"name":"b.md (staged ↔ working tree)","text":""},…,{"id":4,"name":"*Working tree:b.md*","text":"# b\nchanged"}]
```

A script runs in its own realm. It sees `editor.*` but none of the plugin's module state, because git-sidebar exports no plugin API. To reach the plugin, use `cmd` or the screen.

### Several windows (R28)

Each window gets its own section. To check that, make a second repository and a window on it, then switch to it. Make the window in one `eval` and switch in the next: `listWindows()` does not list a new window within the same script.

```bash
GS_LIVE_BASE=/tmp/gs-drive/fix bash tests/live/fixture.sh b >/dev/null && git -C /tmp/gs-drive/fix/b checkout -q -b feature-b
node $D eval 'return editor.createWindow("/private/tmp/gs-drive/fix/b", "b");'
node $D eval 'const w = editor.listWindows().find((x) => x.root.endsWith("/fix/b")); return editor.setActiveWindow(w.id);'
node $D click "1 │" && node $D keys C-b    # a new window starts with its explorer hidden
node $D wait 'Git · feature-b'
node $D eval 'return editor.setActiveWindow(1);'   # back to the fixture's window
```

## Run (human path)

Install from the checkout (**Package: Install from URL**, `/path/to/fresh-plugins#git-sidebar`), restart Fresh, and press Ctrl+B. See the root `CLAUDE.md`, "Trying a plugin in Fresh".

## Test

```bash
npm run check     # tsc, node --test, fresh --check-plugin; read the exit code, not the bundle it prints
```

## Gotchas

- **Plain `fresh` leaves a daemon behind that your own editor can attach to.** With no arguments, Fresh starts `fresh --server --session-name orchestrator`, which survives `tmux kill-session`. Its socket goes in `$XDG_RUNTIME_DIR/fresh`, or else the shared `/tmp/fresh-$UID`, and `HOME` doesn't move it. The driver runs `fresh --simple` (one process, no daemon, no saved session) with `XDG_RUNTIME_DIR=/tmp/gs-drive/run`. So nothing the driver starts can survive `stop`, and the driver can't reach the user's editors either.
- **Inside a Fresh terminal, `$FRESH_SESSION` points every nested `fresh --cmd` at the user's editor.** The driver unsets it, and `FRESH_CMD_TOKEN`, for the launch.
- **`script run` and `command run`/`list` need a capability token.** Without one they print `no capability token: script evaluation is not authorized`. Fresh mints tokens only into terminals created with `allowScript: true`. So the driver writes `home/.config/fresh/init.ts`, which spawns such a terminal. That terminal saves `FRESH_SESSION` and `FRESH_CMD_TOKEN` to `/tmp/gs-drive/token.env`, then its split is closed. The terminal stays in `listBuffers()` as `gs-driver-token`, so filter it out when counting buffers, for example after closing a diff (P19).
- **That terminal takes the keyboard until a mouse click.** Even with `focus: false` and its split closed, every key goes to the hidden terminal. `focusSplit` before or after the close does not help. So `start` clicks row 3 of the empty buffer before pressing Ctrl+B. Without `direction`, `createTerminal` opens a focused tab instead of a split, and keys show up in it as `^B`.
- **`init.ts` rejects top-level `await`** (`SyntaxError: expecting ';'` in the log), although `fresh --cmd help plugin` says it is allowed. Wrap the code in an async IIFE.
- **`git status` changes before the section redraws.** Right after `keys Space`, `screen` can still show the old rows. Wait for the new state, for example `wait 'Staged Changes 6'`, instead of capturing straight away.
- **`click` matches substrings, top to bottom.** `click "Changes"` hits `Staged Changes`, and a click on a group row toggles that group, which hides its rows. The explorer lists the same files as `b.md   M`, so use the section's form, `M b.md`. `a.ts` is in both groups: `click "M a.ts"` opens `a.ts (HEAD ↔ staged)`, and `--nth 2` opens `a.ts (staged ↔ working tree)`. Columns are counted in code points, which is right for this UI's box drawing and arrows.
- **Palette commands act on the selected row,** and the selection moves after a stage or unstage (by key, then by place). Click the row first, as the flow above does.
- **Plain text doesn't show the selected row.** The section draws no `▌` (P21), only a band. Check the effect (`git status`, the tab name) instead, or use `screen --color`.
- **The workspace path is `/private/tmp/…` on macOS** and `/tmp/…` on Linux. `getCwd()` and `state.json` hold the realpath.
- **Linux draws a few labels differently:** `File Explorer (Ctrl+E)` and `Palette: Ctrl+P`, where macOS draws `File Explorer` and `⌃P`. The section's rows are the same, so match on those.
- **A container without `--init` keeps every exited Fresh as a zombie,** because `sleep infinity` as PID 1 reaps nothing. `stop` reads `/proc/<pid>/status` and counts a zombie as gone.
- **`cmd` and `eval` can switch windows.** Each runs from the fixture's folder, and Fresh may make that folder's window active for the call, so a palette opened afterwards can be the fixture window's (seen with `fresh --cmd command list`). Switch back explicitly, then check through keys and the screen.
- **Not covered:** `--simple` restores and saves no session, so the divider and collapsed state across restarts (P2, P32) can't be tested here. Dev-container runs (P7, P8) need the fixture under `$HOME` for colima (`fixture.sh <name> --devcontainer …`).

## Troubleshooting

- **`driver: no Git section on screen` with a repository:** run `node $D log` and look for a load error. `fresh --check-plugin git_sidebar.ts` shows bundling errors.
- **Keys do nothing, or `^B` appears in a `gs-driver-token` tab:** the token terminal has the keyboard. Click a pane: `node $D click "1 │"`.
- **`driver: no /tmp/gs-drive/token.env`:** `init.ts` failed. `node $D log gs-driver` shows why.
- **`npm install -g @fresh-editor/fresh-editor` fails with `tar (child): xz: Cannot exec: No such file or directory`:** its postinstall downloads a `.tar.xz`. Install `xz-utils` and re-run. npm 11 then warns that it is skipping install scripts, but the binary does land in `bin/`, and `fresh --version` prints `fresh 0.5.9`.
- **`fresh --cmd daemon list` prints `Cleaned up N stale daemon(s)`:** listing deletes the sockets of dead daemons in the shared dir. It is harmless, but it is a write.
