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
│▼ Graph                               │
│ ▶ ●  main  c4  fixture               │
│ ▼ ○─╮  origin/main  M  fixture       │
│    A feat.txt                        │
│ ▶ │ ●  feat  f2  fixture             │
│ ▶ │ ● f1  fixture                    │
│ ▶ ● │ c3  fixture                    │
│ ▶ ●─╯  v1  c2  fixture               │
│ ▶ ● c1  fixture                      │
```

- The title shows the branch, with ahead/behind counts when it has an upstream. A detached HEAD shows the short commit id.
- **Staged Changes** lists what differs between HEAD and the index. **Changes** lists working-tree edits, every untracked file, and conflicts (`!`). A file changed in both places is in both groups.
- Markers: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T` type changed, `U` untracked, `!` conflicted. Colours come from the theme's git file-status colours, so they follow theme changes. A deleted file's name is also struck through.
- **Diff.** A click or Enter on a file opens a read-only side-by-side diff, and the keyboard stays in the section. It opens in the editor area, where a File Explorer click opens a file, never in Fresh's utility dock (the panel at the bottom that holds the terminal and the diagnostics and search panels), even when you last worked in the dock. That split becomes the active one, as after a File Explorer click from the dock; the dock keeps its tabs, and a preview tab stays a preview.
  - A Changes row compares the staged version with the file on disk.
  - A Staged row compares HEAD with the staged version.
  - A conflicted row compares HEAD with the file and its conflict markers.
  - There is one diff tab: the next click replaces it. Closing it leaves nothing behind. Binary files (including text that is not UTF-8), files over 5 MiB, and a Changes or conflicted file that is a symbolic link on disk get a status message instead.
  - A click on the row that is already selected opens its diff again.
  - **Two panes**, the left side on the left, each under a header naming it (for example `Staged` and `Working tree`), with line numbers and the file's syntax colours, picked from its name or extension (a root `Makefile` included). Unchanged lines face each other, blank rows face lines the other side lacks, and the panes scroll together. Long lines are not wrapped.
  - **Changes are marked** like VS Code's diff: a removed or changed line is tinted red with `-` in the gutter on the left, an added or changed line green with `+` on the right, and the part of a changed line that differs is highlighted more strongly. The tints are the theme's diff colours.
  - **Scrollbar marks.** Each pane's scrollbar marks where its changes are, its whole height standing for the whole pane: red on the left, green on the right, a longer change as a longer streak. A change with lines on one side only also gets a one-cell mark on the other pane's scrollbar, where its blank rows are, so each scrollbar shows every change. With `editor.show_vertical_scrollbar` off there are no marks; the gutter marks stay.
  - **One side empty.** An added, untracked or deleted file, or a file emptied, shows one pane, the side that has text, under its header, plain, as VS Code shows it: no tints, gutter marks or scrollbar marks.
  - **Keys in the diff** (click into it first; a status message lists them once the keyboard is in the diff): `n` or `]` moves both panes' cursors to the next change and brings it into view, `p` or `[` to the previous one; at the last (or first) change they stay, and the status bar says there is no next (or previous) change. Tab and Shift+Tab move the keyboard to the other pane (a click there does too; in a one-pane diff they do nothing), `j` and `k` scroll both panes by one line, and `q` or Esc closes the tab. These are the keys of Fresh's own side-by-side view.
  - **Next Change and Previous Change.** While a diff the section opened is the active tab, the palette lists **Git Sidebar: Next Change** and **Git Sidebar: Previous Change**. They move the cursor to the next or previous change and bring it into view, as `n` and `p` do; at the last (or first) change the cursor stays and the status bar says there is no next (or previous) change. The palette's plain **Next Change** and **Previous Change** are Fresh's own (the bundled diff_nav plugin): they read the change markers of a file's gutter, which the diff's panes do not have, so in this diff they always say "No changes". The plugin can't change or hide them. To put the section's on a key, add this to `~/.config/fresh/config.json` (F7 and Shift+F7 are free in Fresh's keymaps, and are VS Code's keys for the same in its diff editor):

    ```json
    {
      "keybindings": [
        { "key": "F7", "modifiers": [], "action": "gitSidebar_nextChange", "when": "global" },
        { "key": "F7", "modifiers": ["shift"], "action": "gitSidebar_prevChange", "when": "global" }
      ]
    }
    ```

    Outside a section diff these keys only say so.
  - **Enter in the diff** opens the file as a tab, with the cursor on the line under the diff's cursor, and moves the keyboard there. The diff tab stays open. It works from either pane: in the left one, the line that counts is the right side's line facing the cursor's. In a Changes or conflicted diff that is the working-tree line; in a Staged diff it is the same line number as the staged line, which can differ from the file on disk. On a removed line it goes to the next line the right side shows, or to the file's last line. For a deleted file it says so and opens nothing.
- **Stage and unstage.** `+` stages a Changes file and `−` unstages a Staged file; Space on the row does the same. The group rows' buttons, and Space on a group row, stage or unstage the whole group, including files past the 1,000-row cap. The selection stays at its place in the group, so repeated Space works down the list.
  - Staging a deleted file removes it from the index (`git update-index --remove`), and nothing else: if a directory now stands at its path, what is inside stays untracked, and if the file has come back since the row was drawn, its index entry takes the file as it is now. Staging a rename that git sees only on disk (onto a path marked with `git add -N`) removes the original path the same way.
  - Unstaging a rename restores both its paths. Unstaging a copy restores only the copy: its source keeps its own staged change.
  - Conflicted files, directories (submodules, nested repositories) and files whose names are not valid UTF-8 have no button and are never staged. Stage all skips them and says how many.
  - Neither stage all nor unstage all ends a merge, rebase, cherry-pick or revert in progress.
  - If git fails, for example while another git command holds `.git/index.lock`, the status bar gives git's reason. A stage or unstage is never stopped: after 60 s the status bar says git is still running. Later stages and unstages wait for it, and the status bar says how it ended.
- **Right-click** a file for a menu at the pointer: View Diff, View File, and Stage or Unstage. A conflicted file offers Resolve Conflict instead of Stage. On a group row it offers Stage All or Unstage All, and Staged Changes also offers Commit… while it lists a file. The Graph group offers Pull and Push, a commit View Commit, Copy Commit ID and Copy Commit Message, and a commit's file View Diff and View File. Esc closes it.
- **Command palette** (while the section shows files): **Git Sidebar: View Diff**, **View File**, **Stage or Unstage** and **Resolve Conflict** (on the selected row), **Stage All**, **Unstage All** and **Commit…**; **View Commit**, **Copy Commit ID** and **Copy Commit Message** (on the selected commit, or a selected file's commit); **Pull** and **Push**. View File, from the menu or the palette, is the way to open the file itself. A deleted file gets a status message instead. **Git Sidebar: Focus** is listed whenever the section is shown, and **Next Change** and **Previous Change** while a section diff is the active tab.
- **Resolve Conflict** opens the conflicted file and starts Fresh's own merge resolution on it ("Merge: Start Resolution", from the bundled merge_conflict plugin). With that plugin disabled, it only opens the file. The section still never stages a conflicted file, so once it is resolved, mark it resolved with `git add <file>` in a terminal.
- **Commit…** asks for a one-line message and commits exactly what is staged, with the repository's hooks, as `git commit -m` in a terminal would. Esc cancels. Either way the keyboard is in the editor afterwards, as after any prompt. A message that starts with `-` or `#` is kept as typed. During a merge, cherry-pick or revert with no conflict left, the commit concludes it. The status bar names the new commit's short id, or gives git's reason if it fails (a failing hook, no user identity, a held `.git/index.lock`). A commit is never stopped part-way: after 60 s the status bar says git is still running (a slow hook), and stages and unstages wait for it.
- **Graph.** The third group shows the history of the current branch and of its upstream, newest first, after VS Code's Source Control Graph. It covers only those two: other branches show only where they meet them.
  - Each row is one commit: its lanes (`●` a commit, `○` a merge; following the lines down from a commit leads to each of its parents), its branches and tags as badges, its subject, then its author. The current branch's badge and its upstream's have colours of their own, and a detached HEAD's commit has a `HEAD` badge. Lanes and badges use the theme's colours. A row too wide for the sidebar is cut with `…`.
  - It lists 50 commits, then **Load more**: a click or Enter on it adds 50 more and selects the first of them.
  - Expanding a commit (a click on it, Enter, or the arrow keys) lists the files it changed, against its first parent as VS Code does: a merge lists what the merged branch brought, and a root commit lists everything as added. A click or Enter on a file opens its side-by-side diff in the same diff tab as the other rows, with the parent's version on the left and the commit's on the right; Enter in that diff opens the working-tree file at the same line number. Graph rows have no buttons, and Space on them does nothing.
  - **View Commit** opens a read-only tab with the commit as `git show` prints it: its id, parents, author, dates, message, files and patch against its first parent, coloured as a diff. Like the diff, it opens in the editor area, never in the dock. A later View Commit replaces the tab, in the split the first one was in. **Copy Commit ID** and **Copy Commit Message** put the full id or message on the clipboard.
  - It follows HEAD and the upstream: a commit, checkout, reset, pull or push, and a fetch in a terminal, show within a few seconds. A tag or branch made elsewhere shows the next time HEAD or the upstream moves, or when you come back to the window. While the group is collapsed it reads nothing.
- **Pull and Push** do what VS Code's do.
  - **Pull** fetches the branch's upstream branch and the remote's tags, and merges, rebases or fast-forwards as your `pull.rebase` and `pull.ff` say. It never stashes, even with `rebase.autoStash` or `merge.autoStash` set: local changes in the way, or diverged branches with neither setting, give git's reason and change nothing. Conflicts are listed under Changes for Resolve Conflict. It pulls only while the branch it was asked for is still checked out. A pull that merges needs git 2.27 or later (older git refuses `--no-autostash` without `--rebase`).
  - **Push** sends the branch to its upstream branch, also when that has another name, and never forces: if the remote has commits you lack, the status bar says to pull first. A branch with no upstream is **published**: a prompt asks which remote (Enter takes the only or first one), and the branch is pushed to a branch of the same name there, which becomes its upstream. Esc cancels.
  - Neither ever asks for a username, password, passphrase or host key: credentials must come from a credential helper (such as the macOS keychain) or an ssh agent, or an ssh key without a passphrase. Otherwise the status bar says git needs credentials it can't ask for, with git's reason. Your `~/.ssh/config`, `GIT_SSH_COMMAND`, `core.sshCommand` and `GIT_SSH` are used as git would use them, with ssh's batch mode and a 10 s connection timeout added, so an unreachable host fails within seconds.
  - Both are queued with stages, unstages and commits, one at a time in the order asked, and never stopped part-way: after 60 s the status bar says git is still running. The title's `↑A ↓B` and the Graph follow.
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
  - Switching windows keeps each section's rows, selection, open groups, expanded commits, loaded Graph pages, diff tab, View Commit tab and collapsed state, and the window you switch to refreshes at once.
  - Only the window you are in refreshes, and the commands act on its section.
  - Two windows on one folder, such as a tab extracted into a window of its own, each have their own section. Stages, unstages, commits, pulls and pushes from windows on one repository still run one at a time.
  - The divider between the explorer and the section belongs to the explorer, which every window shares, so it is at the same height in every window.
- It keeps itself current: on save, revert, editor focus and file-explorer changes, and every 2 s for changes made outside the editor. Git is never kept busy more than 25% of the time, the Graph's reads included.
- Outside a git repository, or where git cannot run, there is no section.

## Install

With `https://github.com/deugene/fresh-plugins` added to **Settings → Packages → Sources** (see the [root README](../README.md#install)), run **Package: Packages**, select git-sidebar and choose **Install**.

Or run **Package: Install from URL** and enter:

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

- No discarding, stashing, or staging part of a file. The diff is a snapshot: it does not follow later edits, and shows the file as saved on disk.
- Fresh 0.5.9 does not tell a plugin which split is the dock, so the section tells it apart by what it shows: a diff or View Commit tab opens where the tab it replaces is, else in the split that was last active while it showed a file or one of the section's tabs, else in the first split showing a file, else in the top-left split. A split you made under a single editor split and never had a file active in is passed over like the dock. If the only editor split shows something other than a file (another plugin's buffer, say) and the split last used is gone, the tab can open in the dock. Moving between two splits that show the same file is not noticed. A diff you drag elsewhere stays there, but the next one opens by the same rule.
- The diff's two panes scroll sideways each on its own, and long lines are never wrapped in it. The scrollbar marks of the two panes sit at slightly different heights when one side is longer: each scrollbar stands for its own pane. In the diff, `j` and `k` run Fresh's built-in `scroll_down` and `scroll_up` actions; a later Fresh that renamed them would leave `j` and `k` doing nothing.
- The Graph is read-only: no checkout, branch, tag, cherry-pick, revert or reset from it, no comparing two commits, no search, and no dates or hover details on a row. It shows only the current branch and its upstream, with no Incoming or Outgoing rows (the title's `↑A ↓B` gives the counts). The section has no width to lay the graph out against, so a long row is cut at its end.
- In a partial clone (`--filter=blob:none` or `tree:0`), a commit's files, their diffs and View Commit make git fetch what is missing from the remote. Those reads do not get Pull and Push's guards: with no credential helper or ssh agent, git or ssh may prompt over Fresh, and a read that takes more than 10 s is stopped and shows git's reason.
- Pull and Push: no Fetch, Sync, force push, tag push, autostash, or choice of merge or rebase in the UI; only the upstream, or the remote Publish asks for. They run git as `env LC_ALL=C GIT_TERMINAL_PROMPT=0 … git`, so they need a POSIX `env` on `PATH` (in a bind-mounted dev container, on the host). git's messages are then in English, and hooks git runs for them (such as pre-push or post-merge) get the C locale too. An ssh program that is not OpenSSH, such as PuTTY's plink, set as `core.sshCommand` or `GIT_SSH`, gets neither batch mode nor the timeout, and may still prompt: the plugin cannot stop it. A pull fetches every tag of the remote, as VS Code's does.
- Commit takes a one-line message only, and commits only what is staged: it never stages for you, and has no amend, sign-off or message body. Hooks and signing run as git's configuration says; a signing key that asks for its passphrase in a terminal is expected to fail with git's reason, since Fresh runs git with no terminal (not tested). In a bind-mounted dev container the commit runs on the host, with the host's identity, hooks and signing settings.
- Refreshing never takes `.git/index.lock` (it runs `git --no-optional-locks status`, and the Graph's reads are lock-free too); staging, unstaging, committing, pulling and pushing do, like any git write.
- Only the workspace's repository: no submodules or nested repositories. A repository created in a window's folder appears the next time you switch to that window, or after a restart.
- A window's section appears when you first switch to it after Fresh starts. The Orchestrator's preview of a window you have not visited yet shows none.
- No git starts for a window you are not in. When you switch away, git already running finishes, but a stage, unstage or commit still waiting its turn does not run, and Stage All stops after the part already running. When you come back, the status bar shows every message about that window, in order; a message repeated back to back shows once.
- Updating from a version without per-window sections resets the section's saved collapsed state once.
- At most 1,000 rows per group, and per commit's files, then a `… N more` row.
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

`tests/fixtures/record.sh` re-records the git outputs the tests use: `git status` for the parser, `git log`, `diff-tree` and `show` for the Graph, and pull and push outcomes against local bare remotes. `tests/live/fixture.sh` builds the acceptance repository (optionally with a dev-container config), or the Graph's (`graph`, `graph-long`), under `~/.cache/gs-live/` for checks in a running editor.

## License

MIT
