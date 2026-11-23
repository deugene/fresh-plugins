# Git sidebar section

After this ships, a Fresh user working in a git repository sees a collapsible **Git** section under the file explorer. The section shows the current branch, plus two expandable groups, **Staged Changes** and **Changes**, that list the changed files. The section keeps itself current, so no diff tab is needed to see what is staged and what is not.

The plugin is the first package in a new multi-plugin repository, `deugene/fresh-plugins`.

Investigation: [`docs/investigations/git-sidebar.md`](../investigations/git-sidebar.md) (cited as INV §n).

## Why

Fresh offers no quick way to see what is changed and what is staged (INV §1):

| Existing option | Gap |
|---|---|
| `git_explorer` | One badge per file across the whole tree. Staged and unstaged aren't separated |
| `git_statusbar` | Branch only |
| Review Diff | A whole diff tab |
| `git-review` (third-party) | Refreshed and opened by hand, forgets expanded groups, always shows commits, never shows the branch |

So users run `git status` in a terminal, or open Review Diff and close it again.

## Current behaviour

- **Sidebar.** It holds the file explorer plus any plugin sections, which are appended below it in mount order.
- **Section header.** The host draws each section header with a ▼/▶ toggle and persists each section's collapsed state and dragged height per workspace (INV §2).
- **Other sections.** The only built-in section is the Markdown table of contents.
- **No git section.** There is none, built in or in the community registry (INV §1).
- **The repository.** `deugene/fresh-plugins` does not exist on GitHub, and the local directory is not a git repository.

## Requirements

**R1.** WHEN Fresh starts or the plugin loads in a workspace that is inside a git repository, a section shall appear in the sidebar below the file explorer.
- It shall not take keyboard focus.
- It shall not open a hidden file explorer.
- IF the workspace is not inside a git repository, or git cannot be run, THEN no section shall be shown and no error shall be raised to the user.

**R2.** The section title shall name the current branch, in the form `Git · <branch>`.
- WHERE the branch has an upstream, the title shall add ahead/behind counts (`↑A ↓B`).
- On a detached HEAD, the title shall show the short commit id.
- On a branch with no commits yet, the title shall show the branch name.

**R3.** The section shall contain two groups, **Staged Changes** first and **Changes** second.
- Each group label shall show its file count.
- Both groups shall always be present, including when empty (count 0).
- Each group shall expand and collapse independently, by mouse click on its row and by keyboard.
- Both groups shall start expanded.

**R4.** Group membership:
- **Staged Changes** shall list every path whose index entry differs from HEAD.
- **Changes** shall list:
  - every path whose working-tree content differs from the index;
  - every untracked file, individually, never as a collapsed directory;
  - every path with an unresolved merge conflict.
- A path changed in both places shall appear in both groups.
- Ignored files shall never appear.

**R5.** Each file row shall show the file name, its repository-relative directory in a de-emphasised style, and a status marker.

| Marker | Meaning |
|---|---|
| `M` | modified |
| `A` | added |
| `D` | deleted |
| `R` | renamed |
| `C` | copied |
| `T` | type changed |
| `U` | untracked |
| `!` | conflicted |

- Renamed and copied rows shall also show the original path.
- Rows shall be coloured with the active theme's git file-status colours, and shall follow theme changes without a reload.

**R6.** The user shall be able to collapse and expand the whole section from its header.
- That collapsed state, and any height the user set by dragging a divider, shall survive refreshes, branch changes, and restarts of the same workspace.
- The section shall have no close button.

**R7.** WHEN the user activates a file row, with Enter or a double-click, the file shall open in the editor.
- IF the file does not exist in the working tree, THEN no buffer shall be created, and a status message shall say that the file is deleted.
- Activating a group row shall toggle that group.

**R8.** WHEN a file is saved or reverted in the editor, or the editor regains focus, the section shall show the resulting status within 2 s, on a repository where `git status` completes in under 200 ms.

**R9.** WHEN the repository changes outside the editor, the section shall show the result within 5 s, on a repository where `git status` completes in under 200 ms. This covers:
- `git add`, `reset`, `commit`, `checkout`/`switch` and `stash` run in a terminal;
- edits to files that are not open in the editor.

**R10.** Refreshes shall not disturb the user:
- WHEN a refresh finds no change, the section shall not change visibly: selection, group expansion and scroll stay as they were.
- WHEN a refresh or branch change finds a change, group expansion shall be kept. The selection shall stay on the same file while that file is still listed.
- IF a refresh fails, THEN the section shall keep showing the last good result.

**R11.** The plugin's git activity shall not get in the user's way:
- The plugin shall never create `.git/index.lock`, so the user's own git commands never fail because of it.
- On a repository where `git status` is slow, background refreshing shall keep git running no more than 25% of wall-clock time.
- IF a group would hold more than 500 files, THEN it shall list the first 500 and one final row giving the number not shown.

**R12.** The repository shall follow the conventions of `sinelaw/fresh-plugins`:
- one directory per plugin;
- an MIT license at the root;
- a root README listing its plugins and how to install each one.

The plugin shall:
- have its own README;
- install through **Package: Install from URL**, both from `<repo-url>#<plugin-dir>` and from a local path;
- ship with a single command that runs type checking, unit tests, manifest validation and a plugin bundle check, all of which pass.

The repository shall be initialised as a local git repository with no remote.

**R13.** WHILE the window is attached to a dev container whose workspace is bind-mounted from the host, the section shall show the same title, groups and rows as for the same workspace opened locally. It shall meet R8 and R9 for changes made inside the container, both git commands and edits. It shall do so whether or not the image has git. WHEN the window attaches or detaches, the section shall keep its position, collapsed state and height, and shall show current status within 5 s. WHERE the container's workspace is a container volume rather than a host bind mount, the section shall never show the host folder's git status. IF Fresh cannot open files that exist only in the volume, THEN the section shall show a single notice row saying the sources are in a container volume.

## Out of scope

- Staging, unstaging, discarding, committing, or any other action that changes the repository.
- Opening a diff from a row. Activation opens the file only.
- Additional git repositories:
  - repositories nested inside the workspace (sub-repos, submodules);
  - a repository created after the plugin loaded (reload the plugin or restart Fresh instead).
- Multiple editor windows: the section belongs to the window that was active when the plugin loaded.
- Keeping group expansion across editor restarts. Groups start expanded on each start.
- SSH remote workspaces (best effort, unverified).
- A host without git while attached to a dev container.
- User settings, and palette commands.
- Creating the GitHub repository, publishing to the plugin registry, and CI.

## Constraints

- **Fresh version.** The plugin must run on the installed Fresh 0.5.9, using only APIs declared in that version's plugin type file. APIs that are only on upstream master are excluded (INV §2).
- **Built-in plugin names.** The plugin's name must not collide with a built-in plugin name. A collision makes both load and share i18n strings and config keys (INV §4):
  - `git_blame`, `git_explorer`, `git_find_file`, `git_grep`, `git_gutter`, `git_log`, `git_statusbar`;
  - `live_diff`, `diff_nav`, `merge_conflict`, `audit_mode`, `compare_files`.
- **Self-contained plugin directory.**
  - The plugin directory must work on its own, because installing from `#<dir>` copies only that directory (INV §4).
  - The built-in plugin `lib/` helpers are not importable (INV §3).
- **Coexistence.** The plugin must coexist with the built-in git plugins without changing their behaviour.
- **No unhandled promise rejections.** One kills the plugin runtime (INV §2).
- **Dev containers.** Fresh's container authority keeps the filesystem on the host; only processes enter the container (INV §7).
- **Section lifetime.** The section's position, collapsed state and height belong to the host.
  - The host keeps them across a remount of the same section, but not across an unmount and mount (INV §2).
  - So R6 rules out any refresh path that removes the section.

## Acceptance criteria

The fixture is a scratch repository on branch `main` with an upstream that is one commit behind. It has:
- `a.ts` staged and also modified again in the working tree;
- `b.md` modified, unstaged;
- `new/c.txt` and `new/d.txt` untracked;
- `old.ts` renamed to `moved.ts` and staged;
- `gone.ts` deleted, unstaged;
- an ignored `build/` directory.

Open Fresh on it with the plugin installed.

**A1.** (R1)
- With the explorer visible, the Git section appears below the explorer, and focus stays in the editor.
- With the explorer hidden at start, it stays hidden. Opening it shows the section.
- In a non-git directory, no section appears and nothing is logged above warning level.
- With `git` absent from PATH, there is no section and no error popup.

**A2.** (R2)
- The title reads `Git · main ↑1 ↓0`.
- After `git checkout --detach`, the title shows the short commit id.
- In a fresh `git init` with no commits, the title reads `Git · main` (or the configured default branch).
- On a branch with no upstream, the title has no arrows.

**A3.** (R3) The section shows `Staged Changes 2` above `Changes 5`, both expanded.
- Clicking each group row toggles it, and so do keyboard Left/Right.
- In a clean repository, both groups show count 0.

**A4.** (R4, R5)
- Staged Changes lists:
  - `a.ts M`;
  - `moved.ts R`, showing `old.ts`.
- Changes lists:
  - `a.ts M`;
  - `b.md M`;
  - `c.txt U` and `d.txt U`, each with directory `new`;
  - `gone.ts D`.
- Nothing from `build/` appears.
- A unit test over recorded outputs of the probed repository states gives exactly the group, marker and original path in each case. The states are:
  - staged and modified;
  - rename;
  - copy;
  - conflict (`UU`, `AA`, `DU`);
  - `rm --cached`;
  - intent-to-add;
  - unborn branch;
  - detached HEAD.

**A5.** (R5) Marker colours match the theme's file-status colours. After switching theme, they change without a reload.

**A6.** (R6)
- Collapse the section from its header, restart Fresh on the same workspace, and the section is still collapsed.
- Drag its divider, trigger 3 refreshes and a branch switch, and the height and position are unchanged.
- The header has no ×.

**A7.** (R7)
- Enter on `b.md` opens `b.md`.
- Enter on `gone.ts` shows a "deleted" status message, and the buffer list is unchanged.
- Enter on a group row toggles it.

**A8.** (R8) Edit and save `b.md` back to its HEAD content in Fresh. Within 2 s, `b.md` leaves Changes.

**A9.** (R9) From an external terminal:
- `git add b.md` moves it to Staged within 5 s.
- `git commit` empties Staged within 5 s.
- `echo x >> unopened.txt` adds `unopened.txt U` within 5 s.
- `git switch -c other` changes the title within 5 s.

**A10.** (R10)
- Select `b.md` and collapse Changes. Wait 30 s with no changes, and the selection, expansion and scroll are unchanged.
- Select `b.md` again, then externally stage a file that sorts above it. The selection is still on `b.md`.
- Hold `.git/index.lock` externally for 10 s. The section keeps its previous content.

**A11.** (R11)
- While the plugin refreshes, a loop of 200 `git add`/`git reset` pairs in a terminal never fails with an `index.lock` error.
- A unit test of the refresh scheduling, with simulated git durations of 1 s and 5 s, shows git busy no more than 25% of elapsed time.
- In a repository with 1,200 untracked files, Changes shows 500 rows plus `… 700 more`, and still does after 3 refreshes.

**A12.** (R12)
- The one check command exits 0.
- Install from the local path with `#<plugin-dir>`: after a restart, the section appears.
- `git status` in the repository shows it initialised, and `git remote` prints nothing.
- The root README lists the plugin with its install URL.

**A13.** (R13) The fixture is created under `$HOME` (colima shares only `$HOME`). Its `.devcontainer/devcontainer.json` uses image `mcr.microsoft.com/devcontainers/base:debian` with `postCreateCommand: git config --global --add safe.directory '*'`. Run `devcontainer up`, then "Dev Container: Attach" in Fresh.
- The section stays put, with the same collapsed state.
- The title and rows match A2/A4.
- From a container terminal:
  - `git add b.md` moves it to Staged within 5 s;
  - `git commit -m x` empties Staged within 5 s;
  - `echo x >> z.txt` adds `z.txt U` within 5 s.
- Enter on `b.md` opens it.
- Detach: the section stays and is still current.
- Repeat with `debian:bookworm-slim`, which has no git. The git commands run in a host terminal, and only `echo x >> z.txt` runs in the container. Same results.
- **Volume variant:** the host folder is a git repo with its own changes, and `devcontainer.json` sets `workspaceMount: source=gs-vol,target=/workspaces/gs,type=volume`. After attach, the section shows none of the host's rows; per P8 it shows the notice row.

## Decisions

Decisions marked "user" were chosen by the user on 2026-11-23. Those marked "default" were proposed and accepted.

| Decision | Why | Source |
|---|---|---|
| Build a new plugin; do not fork or adopt `git-review` | Its gaps (see Why) are the core of the request | user |
| Local git now; GitHub repo later | Publishing is outward-facing | user |
| Branch in the title, not in a row | Saves a row. The remount a branch change triggers must keep group state (R2, R10) | user |
| Activation opens the file, never a diff | The 0.5.9 diff command works only on the active buffer and only HEAD vs working tree (INV §3) | user |
| Workspace repository only | Matches the explorer root | default |
| Conflicted files go under Changes, marked `!` | Keeps the ticket's two groups | default |
| Untracked files listed one by one, with a 500-row cap per group | Avoids an opaque `dir/` row, and the cap bounds an un-ignored `node_modules` | default |
| No close button | A closed section can't come back without a restart. Collapse hides it, and disabling the plugin removes it | — |
| Empty groups stay visible, with count 0 | The layout doesn't shift as files are staged | — |
| Nothing shown outside a git repository | Matches `git_statusbar` | — |
| Git runs on the host for bind mounts | Fresh's container authority keeps the filesystem on the host and assumes bind mounts; `runOnTarget` passes the host cwd to `docker exec -w`; images may lack git; in-container git meets ownership problems; `kill()` is a no-op there (INV §7) | default |
| Volume workspaces are detected with host-side `docker inspect`, and their behaviour follows P8 | Fresh cannot be assumed to read files that exist only in a volume (INV §7, §8) | user |
