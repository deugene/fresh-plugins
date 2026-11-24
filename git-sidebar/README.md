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
- Markers: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T` type changed, `U` untracked, `!` conflicted. Colours come from the theme's git file-status colours, so they follow theme changes. A deleted file's name is also struck through.
- **Diff.** A click or Enter on a file opens a read-only side-by-side diff in the active split, and the keyboard stays in the section.
  - A Changes row compares the staged version with the file on disk.
  - A Staged row compares HEAD with the staged version.
  - A conflicted row compares HEAD with the file and its conflict markers.
  - There is one diff tab: the next click replaces it. Closing it leaves nothing behind. Binary files (including text that is not UTF-8), files over 5 MiB, and a Changes or conflicted file that is a symbolic link on disk get a status message instead.
  - A click on the row that is already selected opens its diff again.
  - Both sides are coloured with the file's syntax, picked from its name or extension (a root `Makefile` included).
  - **Keys in the diff** (click into it first; a status message lists them once the keyboard is in the diff): `n` or `]` goes to the next change, `p` or `[` to the previous one, `q` or Esc closes the tab. These are Fresh's own keys for any side-by-side view.
  - **Enter in the diff** opens the file as a tab, with the cursor on the line under the diff's cursor, and moves the keyboard there. The diff tab stays open. In a Changes or conflicted diff that is the working-tree line; in a Staged diff it is the same line number as the staged line, which can differ from the file on disk. On a removed line it goes to the next line the right side shows, or to the file's last line. For a deleted file it says so and opens nothing.
- **Stage and unstage.** `+` stages a Changes file and `−` unstages a Staged file; Space on the row does the same. The group rows' buttons, and Space on a group row, stage or unstage the whole group, including files past the 500-row cap. The selection stays at its place in the group, so repeated Space works down the list.
  - Staging a deleted file removes it from the index (`git update-index --remove`), and nothing else: if a directory now stands at its path, what is inside stays untracked, and if the file has come back since the row was drawn, its index entry takes the file as it is now. Staging a rename that git sees only on disk (onto a path marked with `git add -N`) removes the original path the same way.
  - Unstaging a rename restores both its paths. Unstaging a copy restores only the copy: its source keeps its own staged change.
  - Conflicted files, directories (submodules, nested repositories) and files whose names are not valid UTF-8 have no button and are never staged. Stage all skips them and says how many.
  - Neither stage all nor unstage all ends a merge, rebase, cherry-pick or revert in progress.
  - If git fails, for example while another git command holds `.git/index.lock`, the status bar gives git's reason. A stage or unstage is never stopped: after 60 s the status bar says git is still running. Later stages and unstages wait for it, and the status bar says how it ended.
- **Right-click** a file for a menu at the pointer: View Diff, View File, and Stage or Unstage. A conflicted file offers Resolve Conflict instead of Stage. On a group row it offers Stage All or Unstage All, and Staged Changes also offers Commit… while it lists a file. Esc closes it.
- **Command palette** (while the section shows files): **Git Sidebar: View Diff**, **View File**, **Stage or Unstage** and **Resolve Conflict** (on the selected row), **Stage All**, **Unstage All** and **Commit…**. View File, from the menu or the palette, is the way to open the file itself. A deleted file gets a status message instead. **Git Sidebar: Focus** is listed whenever the section is shown.
- **Resolve Conflict** opens the conflicted file and starts Fresh's own merge resolution on it ("Merge: Start Resolution", from the bundled merge_conflict plugin). With that plugin disabled, it only opens the file. The section still never stages a conflicted file, so once it is resolved, mark it resolved with `git add <file>` in a terminal.
- **Commit…** asks for a one-line message and commits exactly what is staged, with the repository's hooks, as `git commit -m` in a terminal would. Esc cancels. Either way the keyboard is in the editor afterwards, as after any prompt. A message that starts with `-` or `#` is kept as typed. During a merge, cherry-pick or revert with no conflict left, the commit concludes it. The status bar names the new commit's short id, or gives git's reason if it fails (a failing hook, no user identity, a held `.git/index.lock`). A commit is never stopped part-way: after 60 s the status bar says git is still running (a slow hook), and stages and unstages wait for it.
- Enter on a group toggles it.
- **Reaching the section from the keyboard.** Alt+Shift+N and Alt+Shift+P (Fresh's own keys) move the keyboard through the explorer, each section and the editor. **Git Sidebar: Focus** moves it straight into the section: it shows the explorer column if it is hidden, expands the section if it is collapsed, and selects the first row if none is selected. Esc in the section gives the keyboard back to the editor. The plugin binds no key to Focus; to bind one, add this to `~/.config/fresh/config.json` (Ctrl+Alt+G is free in Fresh's default keymap):

  ```json
  {
    "keybindings": [
      { "key": "g", "modifiers": ["ctrl", "alt"], "action": "gitSidebar_focus", "when": "global" }
    ]
  }
  ```
- **Follows the editor.** When you switch to a file the section lists, while the keyboard is not in the section, its row is selected and scrolled into view. A file in both groups selects its Changes row, unless one of its two rows is already selected. Nothing else happens: no diff opens, the keyboard stays where it was, and a collapsed group or section stays collapsed (a file in a collapsed group is not selected). A refresh never moves the selection, even when it newly lists the file you are editing.
- Collapse the whole section from its header (▼/▶). Fresh remembers the collapsed state for each workspace, and the height you drag the divider to.
- **Every window.** In Fresh's Orchestrator each project is a window of its own, and each window whose folder is in a git repository has its own section for that repository.
  - Switching windows keeps each section's rows, selection, open groups, diff tab and collapsed state, and the window you switch to refreshes at once.
  - Only the window you are in refreshes, and the commands act on its section.
  - Two windows on one folder, such as a tab extracted into a window of its own, each have their own section. Stages, unstages and commits from windows on one repository still run one at a time.
  - The divider between the explorer and the section belongs to the explorer, which every window shares, so it is at the same height in every window.
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

- No discarding, stashing, pushing, or staging part of a file. The diff is a snapshot: it does not follow later edits, and shows the file as saved on disk.
- Commit takes a one-line message only, and commits only what is staged: it never stages for you, and has no amend, sign-off or message body. Hooks and signing run as git's configuration says; a signing key that asks for its passphrase in a terminal is expected to fail with git's reason, since Fresh runs git with no terminal (not tested). In a bind-mounted dev container the commit runs on the host, with the host's identity, hooks and signing settings.
- Refreshing never takes `.git/index.lock` (it runs `git --no-optional-locks status`); staging, unstaging and committing do, like any git write.
- Only the workspace's repository: no submodules or nested repositories. A repository created in a window's folder appears the next time you switch to that window, or after a restart.
- A window's section appears when you first switch to it after Fresh starts. The Orchestrator's preview of a window you have not visited yet shows none.
- No git starts for a window you are not in. When you switch away, git already running finishes, but a stage, unstage or commit still waiting its turn does not run, and Stage All stops after the part already running. When you come back, the status bar shows every message about that window, in order; a message repeated back to back shows once.
- Updating from a version without per-window sections resets the section's saved collapsed state once.
- At most 500 rows per group, then a `… N more` row.
- Unstaging a staged deletion of `foo` also unstages a staged `foo/bar`: an index cannot hold a file and a directory at the same path.
- Under `core.autocrlf` or `eol`/`text` attributes, a Changes diff compares the blob as stored (LF) with the file on disk (CRLF), so every line shows as changed. Showing it as git does would mean running the repository's filters on every click.
- The diff colours a file by the syntax Fresh picks from its name or extension. A file Fresh recognises only by its first line, such as an extensionless script starting with `#!/bin/bash`, is plain in the diff, though it is coloured when opened.
- An untracked symbolic link's diff shows its target's contents: git status gives an untracked path no mode, and Fresh's file API follows links.
- A file whose name is not valid UTF-8 is listed with `�` in its name, but cannot be diffed, staged or unstaged from the section. In a bind-mounted dev container one such name empties the whole list: Fresh returns no output for it.
- The selected row shows the selection band without the `▌` mark the file explorer draws. In Fresh 0.5.9 that mark swallows every click on the row beneath it, its buttons and right-click included, so the section uses a tree layout that draws no mark.
- No single-letter shortcuts: Fresh 0.5.9 gives a sidebar section no key bindings of its own. For the same reason Focus has no default key (see above).
- Resolve Conflict starts Fresh's merge_conflict plugin through its action name, `start_merge_conflict`. If a later Fresh renames that action, the file still opens, resolution does not start, and Fresh logs an error and shows a warning count.
- SSH remote workspaces: best effort, not verified.

## Development

```
npm install
npm run check   # tsc, unit tests (node --test), fresh --check-plugin
```

`tests/fixtures/record.sh` re-records the `git status` outputs the parser tests use. `tests/live/fixture.sh` builds the acceptance repository (optionally with a dev-container config) under `~/.cache/gs-live/` for checks in a running editor.

## License

MIT
