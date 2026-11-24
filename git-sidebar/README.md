# git-sidebar

A **Git** section in [Fresh](https://github.com/sinelaw/fresh)'s file-explorer sidebar, below the explorer:

```
├ ▼ Git · main ↑1 ↓0 ──────────────────┤
│▼ Staged Changes 2              [ − ] │
│   M a.ts                       [ − ] │
│   R moved.ts  ← old.ts         [ − ] │
│▼ Changes 5                     [ + ] │
│   M a.ts                       [ + ] │
│   M b.md                       [ + ] │
│   D gone.ts                    [ + ] │
│   U c.txt  new                 [ + ] │
│   U d.txt  new                 [ + ] │
```

- The title shows the branch, with ahead/behind counts when it has an upstream. A detached HEAD shows the short commit id.
- **Staged Changes** lists what differs between HEAD and the index. **Changes** lists working-tree edits, every untracked file, and conflicts (`!`). A file changed in both places is in both groups.
- Markers: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T` type changed, `U` untracked, `!` conflicted. Colours come from the theme's git file-status colours, so they follow theme changes.
- **Diff.** A click or Enter on a file opens a read-only side-by-side diff in the active split, and the keyboard stays in the section.
  - A Changes row compares the staged version with the file on disk.
  - A Staged row compares HEAD with the staged version.
  - A conflicted row compares HEAD with the file and its conflict markers.
  - There is one diff tab: the next click replaces it. Closing it leaves nothing behind. Binary files (including text that is not UTF-8), files over 5 MiB, and a Changes or conflicted file that is a symbolic link on disk get a status message instead.
  - A click on the row that is already selected opens its diff again.
- **Stage and unstage.** `+` stages a Changes file and `−` unstages a Staged file; Space on the row does the same. The group rows' buttons, and Space on a group row, stage or unstage the whole group, including files past the 500-row cap. The selection stays at its place in the group, so repeated Space works down the list.
  - Staging a deleted file removes it from the index (`git update-index --remove`), and nothing else: if a directory now stands at its path, what is inside stays untracked, and if the file has come back since the row was drawn, its index entry takes the file as it is now. Staging a rename that git sees only on disk (onto a path marked with `git add -N`) removes the original path the same way.
  - Unstaging a rename restores both its paths. Unstaging a copy restores only the copy: its source keeps its own staged change.
  - Conflicted files, directories (submodules, nested repositories) and files whose names are not valid UTF-8 have no button and are never staged. Stage all skips them and says how many.
  - Neither stage all nor unstage all ends a merge, rebase, cherry-pick or revert in progress.
  - If git fails, for example while another git command holds `.git/index.lock`, the status bar gives git's reason. A stage or unstage is never stopped: after 60 s the status bar says git is still running. Later stages and unstages wait for it, and the status bar says how it ended.
- **Right-click** a file for a menu at the pointer: View Diff, View File, and Stage or Unstage. On a group row it offers Stage All or Unstage All. Esc closes it.
- **Command palette** (while the section shows files): **Git Sidebar: View Diff**, **View File**, **Stage or Unstage** (on the selected row), **Stage All** and **Unstage All**. View File, from the menu or the palette, is the way to open the file itself. A deleted file gets a status message instead.
- Enter on a group toggles it.
- Collapse the whole section from its header (▼/▶). Fresh remembers the collapsed state and the height you drag it to for each workspace.
- It keeps itself current: on save, revert, editor focus and file-explorer changes, and every 2 s for changes made outside the editor. Git is never kept busy more than 25% of the time.
- Outside a git repository, or where git cannot run, there is no section.

## Install

In Fresh, run **Package: Install from URL** and enter:

```
https://github.com/deugene/fresh-plugins#git-sidebar
```

or a local checkout:

```
/path/to/fresh-plugins#git-sidebar
```

Then restart Fresh. Requires Fresh 0.5.9 or later and `git` on `PATH`.

## Dev containers

- **Bind-mounted workspace** (the usual case): attaching or detaching keeps the section in place. Git runs on the host, on the same files the container sees, so it works whether or not the image has git, and changes made inside the container show up like any other.
- **Workspace in a container volume** (`workspaceMount … type=volume`): Fresh opens only host files, so the section cannot show the container's sources. It shows one row saying so, and never the host folder's status.

## Limits

- No discarding, committing, stashing, or staging part of a file. The diff is a snapshot: it does not follow later edits, and shows the file as saved on disk.
- Refreshing never takes `.git/index.lock` (it runs `git --no-optional-locks status`); staging and unstaging do, like any git write.
- Only the workspace's repository: no submodules or nested repositories. A repository created after Fresh started appears after a restart.
- At most 500 rows per group, then a `… N more` row.
- Unstaging a staged deletion of `foo` also unstages a staged `foo/bar`: an index cannot hold a file and a directory at the same path.
- Under `core.autocrlf` or `eol`/`text` attributes, a Changes diff compares the blob as stored (LF) with the file on disk (CRLF), so every line shows as changed. Showing it as git does would mean running the repository's filters on every click.
- An untracked symbolic link's diff shows its target's contents: git status gives an untracked path no mode, and Fresh's file API follows links.
- A file whose name is not valid UTF-8 is listed with `�` in its name, but cannot be diffed, staged or unstaged from the section. In a bind-mounted dev container one such name empties the whole list: Fresh returns no output for it.
- The selected row shows the selection band without the `▌` mark the file explorer draws. In Fresh 0.5.9 that mark swallows every click on the row beneath it, its buttons and right-click included, so the section uses a tree layout that draws no mark.
- No single-letter shortcuts: Fresh 0.5.9 gives a sidebar section no key bindings of its own.
- SSH remote workspaces: best effort, not verified.

## Development

```
npm install
npm run check   # tsc, unit tests (node --test), fresh --check-plugin
```

`tests/fixtures/record.sh` re-records the `git status` outputs the parser tests use. `tests/live/fixture.sh` builds the acceptance repository (optionally with a dev-container config) under `~/.cache/gs-live/` for checks in a running editor.

## License

MIT
