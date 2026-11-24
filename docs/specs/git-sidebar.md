# Git sidebar section

After this ships, a Fresh user working in a git repository sees a collapsible **Git** section under the file explorer. The section shows the current branch, plus two expandable groups, **Staged Changes** and **Changes**, that list the changed files. The section keeps itself current, so no diff tab is needed to see what is staged and what is not.

After the 2026-11-24 follow-up (R14–R18), the user can also open a side-by-side diff of any listed file with one click. They can stage and unstage single files or a whole group without leaving the section.

The UX follow-up (R19–R27) takes VS Code's Source Control view as its standard. After it, the user can:
- go from a diff to the file at the line they are reading;
- reach the section with one command;
- see the file they are editing selected in it;
- tell deleted files and conflicts apart at a glance;
- commit what is staged, without leaving the editor.

The every-window follow-up (R28) gives each window its own section. Fresh's Orchestrator opens each project in its own window, so after it the user sees each project's Git section in that project, also after reopening Fresh.

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

**Follow-up (2026-11-24).** In use, the section was read-only:

- **A click on a file row did nothing.** Users expect it to act: the explorer opens a file on a single click (INV §9.1).
- **Staging meant leaving the section.** It took a terminal or Review Diff.
- **Seeing one file's diff was awkward.** It meant opening the file and running Side-by-Side Diff. That compares HEAD with the working tree only, so it shows neither what is staged nor what is left to stage (INV §3, §9.4).

**UX follow-up (2026-11-24).** Next to VS Code's Source Control view, the section already covers grouping, staging and diffs (INV §10.1). What it lacks:
- **The diff is a dead end.** Its keys are documented nowhere, and it cannot take the user to the file.
- **The section and the user's work don't meet.** No command moves the keyboard to the section, and the section doesn't show which listed file is being edited.
- **Rows look alike.** A deleted file or a conflict differs from other rows only by a letter and a colour. A conflict has no way into Fresh's conflict resolver.
- **Committing means a terminal.** The stage-then-commit loop ends outside the editor.

## Current behaviour

- **Sidebar.** It holds the file explorer plus any plugin sections, which are appended below it in mount order.
- **Section header.** The host draws each section header with a ▼/▶ toggle and persists each section's collapsed state and dragged height per workspace (INV §2).
- **Other sections.** The only built-in section is the Markdown table of contents.
- **No git section.** There is none, built in or in the community registry (INV §1).
- **The repository.** `deugene/fresh-plugins` does not exist on GitHub, and the local directory is not a git repository.

**Before the 2026-11-24 follow-up** (R1–R13 as first shipped; INV §9.1–§9.3):

- **File rows.**
  - A single click selects the row and does nothing else.
  - Enter, Space and (per the host's code) a double-click open the file. A real double-click was never confirmed live.
- **Group rows.** Space toggles a group, as Enter does.
- **No row controls.** Rows have no buttons, and a right-click does nothing.
- **The title's `↑A ↓B`.** It counts commits ahead of and behind the upstream. With an upstream in sync it reads `↑0 ↓0`, whatever the working tree holds. This is R2 working as specified, and it stays.

**Before the UX follow-up** (R1–R18 as shipped; INV §10.1, §10.2):

- **Diff keys.** The diff tab answers Fresh's own keys for any side-by-side view, though nothing says so:
  - `n` or `]` goes to the next change;
  - `p` or `[` to the previous one;
  - `q` or Esc closes the tab.

  The plugin binds no key of its own there. The diff opens on its first change.
- **Diff colours.** The diff's two sides are hidden buffers named `*<label>: <path>*`. The editor picks their syntax from that name, with a space before the path, so a file at the repository root that is known by its name alone (`Makefile`) is not coloured (confirmed live, INV §8 P26).
- **Reaching the section.** Fresh's Alt+Shift+N and Alt+Shift+P cycle the keyboard through the explorer, each section and the editor. No command focuses the section.
- **Selection.** It never follows the file being edited.
- **Deleted and conflicted rows.** A deleted file's row differs from other rows only by its `D` and its colour. A conflicted row offers View Diff and View File. Fresh's resolver ("Merge: Start Resolution") is run by hand on the open file.
- **Committing.** There is no commit: users run `git commit` in a terminal.

**Before the every-window follow-up** (R1–R27 as shipped; INV §11):

- **One window.** The plugin loads once per Fresh process, and mounted its one section in the window that was active at load, showing that window's folder. Other Orchestrator windows had no section.
- **Reopening Fresh.** The Orchestrator restores the last window used, which is often not the launch folder's window, so the section seemed to be gone.

## Requirements

**R1.** WHEN Fresh starts or the plugin loads in a workspace that is inside a git repository, or a window whose folder is inside one becomes active (R28), a section shall appear in the sidebar below the file explorer.
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
- A row that can be staged or unstaged shall show a `+` or `−` button at its right edge (R15, R16).

**R6.** The user shall be able to collapse and expand the whole section from its header.
- That collapsed state, and any height the user set by dragging a divider, shall survive refreshes, branch changes, and restarts of the same workspace.
- The section shall have no close button.

**R7.** WHEN the user chooses View File for a file row, from the row's menu (R17) or the command palette (R18), the file shall open in the editor as a tab.
- IF the file does not exist in the working tree, THEN no buffer shall be created, and a status message shall say that the file is deleted.
- IF the row is a directory (a submodule or nested repository), THEN no buffer shall be created, and a status message shall say so.
- No other gesture on a file row shall open the file itself: not a click, a double-click, Enter or Space. A click and Enter open the diff (R14); Space stages or unstages (R15).
- Enter on a group row shall toggle that group.

**R8.** WHEN a file is saved or reverted in the editor, or the editor regains focus, the section shall show the resulting status within 2 s, on a repository where `git status` completes in under 200 ms.

**R9.** WHEN the repository changes outside the editor, the section shall show the result within 5 s, on a repository where `git status` completes in under 200 ms. This covers:
- `git add`, `reset`, `commit`, `checkout`/`switch` and `stash` run in a terminal;
- edits to files that are not open in the editor.

**R10.** Refreshes shall not disturb the user:
- WHEN a refresh finds no change, the section shall not change visibly: selection, group expansion and scroll stay as they were.
- WHEN a refresh or branch change finds a change, group expansion shall be kept. The selection shall stay on the same row (a file in a group) while that row is still listed. When the row has gone, for example because R15 moved the file to the other group, the selection shall stay at its position in its group.
- IF a refresh fails, THEN the section shall keep showing the last good result.

**R11.** The plugin's git activity shall not get in the user's way:
- The plugin's refreshing shall never create `.git/index.lock`, so the user's own git commands never fail because of it. Only a stage, unstage or commit the user asks for (R15, R16, R26) writes to the repository.
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

**R13.** WHILE the window is attached to a dev container whose workspace is bind-mounted from the host, the section shall show the same title, groups and rows as for the same workspace opened locally, and R14–R18 shall behave as they do locally. It shall meet R8 and R9 for changes made inside the container, both git commands and edits. It shall do so whether or not the image has git. WHEN the window attaches or detaches, the section shall keep its position, collapsed state and height, and shall show current status within 5 s. WHERE the container's workspace is a container volume rather than a host bind mount, the section shall never show the host folder's git status. IF Fresh cannot open files that exist only in the volume, THEN the section shall show a single notice row saying the sources are in a container volume.

**R14.** WHEN the user clicks a file row, or presses Enter on it, a side-by-side diff of that file shall open in the editor's active split, and keyboard focus shall stay in the section.
- **A Changes row** shall compare the staged version (left) with the working-tree file on disk (right).
  - The left side is empty when nothing is staged for the path (untracked, intent-to-add).
  - The right side is empty for a deleted file.
- **A conflicted row** shall compare the HEAD version (left, empty when HEAD lacks the path) with the working-tree file and its conflict markers (right).
- **A Staged row** shall compare the HEAD version (left) with the staged version (right).
  - For a rename or copy, the left side is the original path's HEAD version.
  - The left side is empty for an added file, and on a branch with no commits.
  - The right side is empty for a staged deletion.
- **Display.**
  - Changed lines shall be marked on both sides, and the two sides shall scroll together.
  - The diff shall be read-only.
  - Its tab title shall name the file and the comparison: staged ↔ working tree, or HEAD ↔ staged.
- **One tab.** At most one diff tab shall be open: each later click or Enter replaces it, whichever row it is on.
- **The selected row.** A click on the row that is already selected opens its diff again, as on any other row.
- **No leftovers.** Closing the diff tab shall leave no buffer behind.
- **A snapshot.** The diff shows the contents at the moment it opened, and does not follow later changes.
- IF either side is binary (contains a NUL byte, or is not valid UTF-8) or larger than 5 MiB, THEN no diff shall open, and a status message shall say why.
- IF a Changes or conflicted row's working-tree file is a symbolic link (git's working-tree mode 120000), THEN no diff shall open, and a status message shall say so. A Staged row on a link still compares the link texts. An untracked link carries no mode in git's status, so its diff shows the target's contents.
- IF the row is a directory (a submodule or nested repository), THEN no diff shall open, and a status message shall say so.

**R15.** Each file row under Changes shall have a `+` button, and each file row under Staged Changes a `−` button. Activating the button, or pressing Space on the row, shall:
- **`+`:** stage the path. The index takes the working tree's state of it: changed content, a deletion, or a new file. Staging a deletion changes nothing under a directory that now stands at the path.
- **`−`:** unstage the path.
  - Its index entry returns to HEAD's, or is removed when HEAD lacks the path (including on a branch with no commits).
  - For a staged rename, both the new and the original path return to HEAD's. For a staged copy, only the new path does: the original keeps its own change.
  - The working tree is never changed.
- **Only that path.** Nothing else shall change, even when the name contains glob characters (`*`, `?`, `[`).
- **Rows without a button.** Conflicted rows, directory rows, and rows whose name is not valid UTF-8 shall have none. Space on one shall leave the repository unchanged, and a status message shall say why.
- **Timing.** The section shall show the result within 2 s, on a repository where `git status` completes in under 200 ms. The selection stays at its position (R10), so repeated Space works down a group.
- IF the stage or unstage fails (for example, while the user's own git holds `.git/index.lock`), THEN a status message shall give git's reason, and the section shall show the repository's actual status.
- A stage or unstage shall never be stopped part-way, because a stopped git leaves `.git/index.lock` behind. IF it takes longer than 60 s, THEN a status message shall say git is still running.

**R16.** WHILE a group lists at least one file, its group row shall have a button: `+` on Changes (stage all) and `−` on Staged Changes (unstage all). Activating the button, or pressing Space on the group row, shall:
- **Stage all.** Stage every path in Changes as R15 does, including paths beyond the 500-row cap, except conflicted paths, directory paths and names that are not valid UTF-8.
  - IF any path was skipped, THEN a status message shall say how many, and why.
- **Unstage all.** Unstage every path in Staged Changes as R15 does, leaving the working tree unchanged.
- **Conflicts and operations in progress.** Neither action shall mark a conflict resolved, discard a conflict, or end a merge, rebase, cherry-pick or revert in progress.
- **Group toggling.** Activating the button shall not toggle the group. A click elsewhere on the row and Enter still toggle it (R3, R7).
- **Empty groups.** An empty group shall have no button, and Space on it shall do nothing.
- R15's timing and failure bullets apply.

**R17.** WHEN the user right-clicks a file row or a group row, a menu shall open at the pointer listing that row's actions:
- **On a file row:** View Diff (R14), View File (R7), and Stage (Changes) or Unstage (Staged) where R15 gives the row a button. A conflicted row also offers Resolve Conflict (R25).
- **On a group row:** Stage All or Unstage All, where R16 gives the row a button. While Staged Changes lists a file, its row also offers Commit… (R26). A group row with no action opens no menu.
- **Choosing an item** shall do what that action does elsewhere.
- **Closing without a choice.** Esc, or a click outside the menu, shall close it and change nothing.
- **Focus.** After the menu closes, keyboard focus shall be back in the section. The one exception is Commit… (R26): its prompt takes the keyboard, and once the prompt is answered or cancelled the keyboard is in the editor, as after the palette (see Decisions).
- **Other rows.** A right-click on any other row (the `… N more` row, a notice) shall do nothing.

**R18.** The command palette shall offer eight Git section commands.
- **Listed while the section shows rows:** View Diff, View File, Stage or Unstage, Stage All, Unstage All, Resolve Conflict and Commit…. Focus is listed whenever the section is shown (R22).
- **View Diff, View File, Stage or Unstage, Resolve Conflict** act on the row selected in the section, as R14, R7, R15 and R25 describe.
- **Stage All, Unstage All, Commit…** act on their group, as R16 and R26 describe, whichever row is selected.
- IF no row is selected, or the action does not apply to the selected row, THEN a status message shall say so, and nothing shall change.
- **Which section.** They act on the active window's section (R28).

**R19. Open the file from its diff.** WHEN the keyboard is in a diff tab the section opened (R14) and the user presses Enter, the row's file shall open in the editor as a tab. The keyboard moves to it, and the cursor goes to the line that matches the diff's cursor:
- **A Changes or conflicted row's diff:** the working-tree line on the cursor's row of the diff.
- **A Staged row's diff:** the line with the same number as the staged line on the cursor's row. The file on disk can differ from the staged version, so this is the same line number, not always the same text.
- **A row with no line on that side:** where that side shows no line on the cursor's row (a removed line), the cursor goes to the next line it does show, or to the file's last line when there is none.
- **The diff stays.** The diff tab shall stay open, and R20's keys shall keep working in it.
- **A deleted file.** IF the file does not exist in the working tree, THEN no buffer shall be created, and a status message shall say that the file is deleted (as R7).

**R20. The diff's keys.** The diff tab shall keep Fresh's own keys for side-by-side views:
- `n` or `]` moves to the next change;
- `p` or `[` moves to the previous one;
- `q` or Esc closes the tab, leaving no buffer behind (R14).

WHEN the keyboard is first in a diff tab the section opened, a status message shall name these keys and R19's Enter, once for that diff:
- **Opened with the keyboard outside the section** (from the palette): as the diff opens.
- **Opened from a row** (a click, Enter or the menu), where the keyboard stays in the section (R14) and these keys do nothing: once the keyboard moves into the diff, such as by a click into it, Esc in the section, or a switch to its tab.

**R21. Diff colours.** Both sides of a diff shall be coloured with the syntax Fresh picks for that file from its name or extension, as when it is opened. That includes a file at the repository root, and a file known by its name rather than its extension (such as `Makefile`). A file Fresh has no syntax for stays plain, and so does a file Fresh recognises only by its first line, such as a script with a shebang and no extension (see Decisions).

**R22. Focus.** The command palette shall offer **Git Sidebar: Focus** whenever the active window's section is shown (R28). WHEN it runs, the keyboard shall move into that section:
- IF the explorer column is hidden, THEN it shall be shown, with the section.
- IF the section is collapsed, THEN it shall be expanded (see Decisions).
- IF no row is selected, THEN the first row shall be selected.
- **A key binding.** A key the user binds to this command in their Fresh keymap shall do the same.
- **No automatic focus.** The section still never takes the keyboard by itself (R1).

**R23. Auto-reveal.** WHEN a window's active tab changes to a file that its section lists, WHILE the keyboard is not in the section, the section shall select that file's row and scroll it into view. A switch to another window is not a tab change (R28).
- **Both groups.** Where the file is listed in both groups, the Changes row shall be selected, unless one of the file's two rows is already selected: then the selection shall not change.
- **When nothing changes.** IF the file is not listed, or its row's group is collapsed, THEN the selection shall not change, and no group shall be expanded.
- **Nothing else.** It shall not open a diff, take the keyboard, show a hidden explorer column, or expand a collapsed section.
- **Refreshes.** A refresh shall never move the selection by itself (R10), even when it newly lists the active file.

**R24. Deleted files.** In both groups, a file row marked `D` shall draw the file name struck through. No other row shall be struck through.

**R25. Resolve Conflict.** On a conflicted row (`!`), the right-click menu (R17) and the palette (R18) shall offer **Resolve Conflict**. Choosing it shall:
- open the file as a tab;
- start Fresh's merge-conflict resolution ("Merge: Start Resolution") on it.

Failure cases:
- IF the file does not exist in the working tree, THEN no buffer shall be created, and a status message shall say that the file is deleted.
- IF Fresh's merge-conflict resolution is unavailable (its bundled plugin is disabled), THEN the file shall still open, and no error shall be shown.
- The section shall still never stage a conflicted file (R15).

**R26. Commit.** WHILE Staged Changes lists at least one file, the user shall be able to commit what is staged, from **Commit…** in the Staged Changes group row's right-click menu (R17) or in the palette (R18).
- **The message.** A prompt shall ask for a one-line commit message. Esc shall cancel it, with nothing changed, and a status message shall say it was cancelled.
  - The message shall reach git exactly as typed, as `git commit -m` takes it from a terminal, including a message that starts with `-` or `#`.
  - IF the message is empty or only whitespace, THEN no commit shall be made, and a status message shall say so.
- **What is committed.** Exactly what is staged. The working tree and Changes shall be left as they were.
  - The repository's hooks shall run, as for a commit from a terminal.
  - During a merge, cherry-pick or revert with no conflicted file left, the commit concludes it, as `git commit` does.
- **Nothing staged.** IF Staged Changes is empty, THEN no prompt shall open, and a status message shall say there is nothing staged to commit.
- **Success.** WHEN the commit is made:
  - a status message shall name its short commit id and its message;
  - the section shall show the result within 2 s, on a repository where `git status` completes in under 200 ms.
- **Failure.** IF git refuses or fails, THEN no commit shall be made, and a status message shall give git's reason. Examples: an unresolved conflict, a failing hook, no user identity, the user's own git holding `.git/index.lock`. The section shall then show the repository's actual status.
- **Never stopped.** A commit shall never be stopped part-way.
  - IF it takes longer than 60 s, THEN a status message shall say git is still running. A slow hook is the usual cause.
  - Stages, unstages and commits run one at a time, in the order asked (R15).

**R27. Documentation.** The README shall describe:
- the diff's keys (R19, R20);
- Alt+Shift+N / Alt+Shift+P (INV §10.2) and the Focus command, with an example key binding for it (R22);
- auto-reveal (R23);
- Resolve Conflict (R25);
- Commit and its limits: a one-line message, and only what is staged (R26).

**R28. Every window.** Fresh's Orchestrator gives each project its own window (INV §11). WHEN a window whose folder is inside a git repository becomes active, that window shall have its own Git section, showing that window's repository, and R1–R27 shall hold for it.
- **Its own state.** Each window's section keeps its own collapsed state, group expansion, selection and diff tab across switches, and its collapsed state across restarts. The divider between the explorer and the section is the explorer's, and the explorer is one for all windows, so the height is the same in every window (INV §8 P32).
- **Switching.** Switching windows shall not change another window's section. WHEN a window becomes active, its section shall show current status within 2 s, on a repository where `git status` completes in under 200 ms.
- **Inactive windows.** WHILE a window is not active, no git command shall start for it, and its section shall not refresh in the background. A git command already running finishes.
  - IF a stage, unstage, stage all, unstage all or commit cannot run in full because its window stopped being active, THEN what is left shall not run, and a status message shall say how far it got.
- **Commands.** The palette commands (R18) and Focus (R22) shall act on the active window's section.
- **Messages.** A status message about a window that is not active shall be shown when that window next becomes active.
- **Windows on one folder.** Two windows on the same folder, such as a tab extracted into a window of its own, shall each have their own section.
- **No repository.** A window whose folder is not inside a git repository has no section (R1). It shall be checked again each time that window becomes active.
- **When it appears.** A window's section appears when that window is first shown after Fresh starts or the plugin loads.

## Out of scope

- **Other changes to the repository.** Discarding changes, stashing, pushing, pulling, or anything else beyond R15/R16's staging and unstaging and R26's commit.
- **More of committing.** Amending, a message body (more than one line), sign-off, choosing the author, skipping hooks, a message history, and commit-and-push. Also staging everything when nothing is staged: VS Code's "smart commit".
- **VS Code features not taken now.** These were weighed in INV §10.4 and left for later tickets:
  - discarding changes, and staging hunks or lines from the diff;
  - a separate Merge Changes group;
  - file-type icons, tooltips, multi-select.
- **Needs a later Fresh** (INV §10.5):
  - a right-aligned status letter;
  - row actions shown only on hover;
  - items in the explorer's and the tabs' right-click menus;
  - buttons in the section header.
- **Auto-reveal on refresh.** R23 acts only on a tab change: a refresh that newly lists the active file does not select it. Also out: a setting to turn auto-reveal off.
- **A default key for Focus.** The user binds one (R22, R27).
- **Translations** (INV §10.6).
- **Partial staging and editing.** Staging or unstaging part of a file (hunks or lines), and editing in the diff view.
- **Resolving conflicts.** Marking a conflict resolved from the section: R15 and R16 never stage a conflicted file.
- **More diff views.** More than one diff tab at a time; a diff that follows edits made after it opened; a diff of unsaved edits; a diff for a directory row.
- **Other ways to open a file.** Opening the file itself by a click, double-click, Enter or Space (R7).
- **Single-letter shortcuts** (`s`, `u`) in the section. Fresh 0.5.9 gives a sidebar section no key bindings (INV §9.3).
- **The title.** Changing its `↑A ↓B`, or adding line or file counts to it.
- Additional git repositories:
  - repositories nested inside the workspace (sub-repos, submodules);
  - a repository created after its window last became active (switch to another window and back, or restart Fresh, instead).
- **Other windows** (R28):
  - refreshing a window that is not active;
  - a Git section in the Orchestrator's preview of a window not yet shown since Fresh started;
  - running a window's git while another window is active. Fresh 0.5.9's `openMachine` could do that (INV §11.4);
  - a section height of its own per window: the divider is the explorer's (INV §8 P32).
- Keeping group expansion across editor restarts. Groups start expanded on each start.
- SSH remote workspaces (best effort, unverified).
- A host without git while attached to a dev container.
- User settings, and palette commands other than R18's.
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
- **Windows** (INV §11):
  - Fresh 0.5.9 has one sidebar section per plugin panel id, editor-wide, so each window's section needs an id of its own.
  - Window ids change on every launch, and two windows can share a folder, so only a workspace's stable id keeps a section's saved state its own.
  - Most plugin APIs act on the active window only: running git in the window's authority, contexts, status messages, prompts and opening buffers.
  - Widget events name the active window, not the section's.
  - No event announces a window restored at startup.
- **Section lifetime.** The section's position, collapsed state and height belong to the host.
  - The host keeps them across a remount of the same section, but not across an unmount and mount (INV §2).
  - So R6 rules out any refresh path that removes the section.
- **Row controls in 0.5.9** (INV §9.3):
  - a tree row carries at most one button;
  - a sidebar section receives no letter keys;
  - Enter and Space are the only activation keys;
  - a right-click reports only absolute screen cells.
- **The right-click menu (R17)** needs a host operation that 0.5.9 implements but its type file does not list: anchoring a floating panel at a screen cell (INV §9.3). It is the one exception to "declared APIs only", and it holds only while a live probe from a sidebar section passes (see Decisions).
- **Presses on the selected row.** In 0.5.9 a sidebar tree in its plain layout lays a selection mark over the selected row, and the mark swallows every press on that row: a click, its button, a right-click (INV §8 P21). The tree layout used for cards, at one line per row, draws the same rows without the mark. The type file says that option acts only on taller rows, so this relies on how 0.5.9 picks the layout, and needs rechecking on each Fresh upgrade.
- **Staging writes the index.** Like any git write, it takes `.git/index.lock`, so it can fail while the user's own git holds that lock (INV §9.5).
- **Dangerous defaults.** Some plain git forms of stage-all and unstage-all resolve conflicts or abort a merge (INV §9.5), and R16 forbids both.
- **The diff's keys belong to Fresh.** `n`, `p`, `]`, `[`, `q` and Esc in a side-by-side view come from Fresh's keymap (INV §10.2). The plugin must leave them working, and must not take Alt+O, which Fresh uses to move the keyboard to and from the dock (0.5.9 keymap, `toggle_dock_focus`).
- **The resolver is another plugin's.** R25 starts the bundled merge-conflict plugin through its action name, `start_merge_conflict`, not through an API (INV §10.3 e). It works only while that plugin is enabled. A rename upstream would make the name unknown, and Fresh would then log an ERROR and show a warning count, as it does for a disabled plugin (INV §8 P29).
- **No default keys from a section.** A sidebar section has no key bindings of its own (INV §9.3), so the plugin cannot give Focus a default key without taking keys from the rest of the editor.
- **A commit is a write.** It follows staging's rules:
  - never killed (INV §8 P16);
  - one at a time with stages and unstages;
  - run where git runs (INV §7). In a bind-mounted dev container that is the host, so the host's git identity, hooks and signing settings apply.

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
- View File on `b.md`, from its right-click menu and again from the palette, opens `b.md` as a tab.
- View File on `gone.ts` shows a "deleted" status message, and the buffer list is unchanged.
- No other gesture opens `b.md` itself as a tab: a click, a double-click, Enter or Space on its row.
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
- While the plugin refreshes and nobody uses R15/R16, a loop of 200 `git add`/`git reset` pairs in a terminal never fails with an `index.lock` error.
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
- View File on `b.md` opens it, and a click on it opens its diff.
- `+` on `b.md` stages it. `git status` in a host terminal shows `M  b.md`.
- Detach: the section stays and is still current.
- Repeat with `debian:bookworm-slim`, which has no git. The git commands run in a host terminal, and only `echo x >> z.txt` runs in the container. Same results.
- **Volume variant:** the host folder is a git repo with its own changes, and `devcontainer.json` sets `workspaceMount: source=gs-vol,target=/workspaces/gs,type=volume`. After attach, the section shows none of the host's rows; per P8 it shows the notice row.

**A14.** (R14)
- **A Changes row.** Click `b.md` under Changes.
  - A read-only side-by-side tab opens. Its left side is `b.md` as staged (here equal to HEAD), its right side the working-tree file, and the changed line is marked on both sides.
  - Down then moves the selection in the section, so focus stayed there.
- **A Staged row, then the same file in Changes.** Click `a.ts` under Staged: HEAD on the left, staged on the right. Then click `a.ts` under Changes: staged on the left, working tree on the right. The number of open tabs is the same as after the first click.
- **Renames, adds, deletes.**
  - `moved.ts` shows `old.ts`'s HEAD content on the left.
  - `new/c.txt` has an empty left side.
  - `gone.ts` has an empty right side.
- **Enter.** Enter on `b.md` opens the same diff as a click.
- **Re-opening.** Close the diff tab while `b.md` stays selected. A click on `b.md` opens its diff again, and so does Enter.
- **The selected row's controls.** With `b.md` selected and the section focused, its `+` stages it and a right-click on it opens the menu. A click on the selected group row toggles it.
- **Closing.** Close the diff tab, and the buffer list equals the one before the first click.
- **Refused files.** For an untracked PNG, for a 6 MiB text file, for a modified tracked Latin-1 file, and for a tracked symbolic link that was retargeted, a click opens no tab and shows a status message.
- **Final newline.** A file whose only change is a blank line added at its end shows that line as added.
- **Unborn branch.** In a repository with no commits and one staged file, that file's Staged diff has an empty left side.
- **Conflict.** In the conflict fixture, a click on the `!` row shows HEAD on the left and the conflict markers on the right.

**A15.** (R15, R5, R10)
- **Stage.**
  - `+` on `b.md`: within 2 s, `b.md` is listed under Staged only, and `git status --porcelain` shows `M  b.md`.
  - Space on `gone.ts` under Changes gives `D  gone.ts`.
  - `+` on `new/c.txt` gives `A  new/c.txt`.
- **Unstage.**
  - `−` on `a.ts` under Staged: `a.ts` is listed only under Changes, and its working-tree file is byte-identical to before.
  - `−` on `moved.ts`: `git diff --cached --name-only` prints neither `moved.ts` nor `old.ts`.
  - `−` on a staged copy `copy.txt` (copy detection on) whose source `orig.txt` is also staged: `copy.txt` is untracked, and `orig.txt` is still staged.
- **Repeated Space.** Select the first file under Changes and press Space three times. Three successive Changes files are staged.
- **Literal paths.** With untracked files `a*` and `ab`, `+` on `a*` stages `a*` only.
- **A deleted file that is now a directory.** Tracked `foo` is deleted and replaced by a directory holding an untracked file and a nested repository. `+` on `foo` gives `D  foo`, and everything under `foo/` stays untracked.
- **Conflict.** In the conflict fixture, the `!` row has no button. Space on it shows a message, and `git status` still shows the conflict.
- **Lock held.** Hold `.git/index.lock` externally and press `+` on `b.md`. A status message gives git's reason, and the section still lists `b.md` under Changes.
- **Unborn branch.** In a repository with no commits, `+` then `−` on a new file leaves it untracked (`??`).

**A16.** (R16, R5)
- **Stage all.** `+` on the Changes group: Changes shows 0, and `git status --porcelain` shows no unstaged or untracked path.
- **Unstage all.** `−` on the Staged Changes group: Staged Changes shows 0, and every working-tree file is byte-identical to before.
- **Past the row cap.** In the repository with 1,200 untracked files, stage all makes `git diff --cached --name-only | wc -l` print 1200.
- **During a merge.** With a merge in progress, one `UU` file and one staged file:
  - stage all leaves the `UU` entry, and its message says one path was skipped;
  - unstage all leaves `.git/MERGE_HEAD` in place and the `UU` entry as it was.
- **No buttons when empty.** In a clean repository, neither group row has a button.
- **No toggle.** A click on a group's button does not toggle the group.

**A17.** (R17)
- **A Changes file.** Right-click `b.md` under Changes: a menu at the pointer lists View Diff, View File and Stage. Choosing Stage does what `+` does in A15.
- **A Staged file.** Right-click `moved.ts` under Staged: View Diff, View File, Unstage.
- **A group.** Right-click the Staged Changes group: Unstage All, and Commit… (R26, A26).
- **Closing.** Esc closes the menu with no change, and Down then moves the selection in the section.
- **Other rows.** Right-click the `… N more` row: no menu.

**A18.** (R18)
- **With a row selected.** Select `b.md` under Changes and open the palette. The eight Git section commands are listed. View Diff, View File, Stage or Unstage, Stage All and Unstage All each do what A14–A16 describe for `b.md` or its group. Resolve Conflict shows a status message, because `b.md` has no conflict.
- **With nothing selected.** On a fresh start, with no row selected, each of View Diff, View File, Stage or Unstage and Resolve Conflict shows a status message and changes nothing.
- **Volume notice.** In the volume variant of A13, only Git Sidebar: Focus is listed.

**A19.** (R19)
- **A Changes row.** Click `b.md` under Changes, move the keyboard into the diff, put the cursor on its added line 2, and press Enter.
  - `b.md` opens as a tab with the cursor on line 2, and typing goes into `b.md`.
  - The diff tab is still open, and `n` still works in it.
- **A Staged row.** Open the Staged diff of `a.ts`, put the cursor on a line of its staged side, and press Enter. `a.ts` opens with the cursor on that line's number.
- **A removed line.** In a diff whose right side lacks the cursor's row (a removed line), Enter puts the cursor on the next line the right side shows.
- **A deleted file.** Enter in `gone.ts`'s diff shows a "deleted" status message, and the buffer list is unchanged.

**A20.** (R20)
- **The hint.** A click on `b.md` opens its diff and shows no hint. A click into the diff then shows a status message naming `n`/`p`, Enter and `q`; a second click into it shows nothing more. Git Sidebar: View Diff from the palette shows the hint as the diff opens.
- **The keys.** In a diff with two changes, `n` moves the cursor to the second change and `p` back to the first. `]` and `[` do the same.
- **Closing.** `q` closes the tab, and the buffer list equals the one before the click. Esc does the same on a new diff.

**A21.** (R21)
- **By extension.** Change `a.ts` and open its Changes diff: both sides show TypeScript keyword colours, as `a.ts` does when opened.
- **By name, at the root.** Commit a `Makefile` at the repository root, change it, and open its diff: both sides show Makefile colours.
- **No syntax.** A file with an unknown extension shows plain text on both sides.
- **By first line only.** An extensionless script that starts with `#!/bin/bash` shows plain text on both sides.

**A22.** (R22)
- **From the editor.** With the keyboard in a buffer, run Git Sidebar: Focus. Down then moves the selection in the section.
- **Nothing selected.** On a fresh start, Focus selects the first row.
- **Explorer hidden.** With the explorer column hidden, Focus shows it, with the section.
- **Section collapsed.** Collapse the section from its header, and run Focus: the section is expanded, with the keyboard in it.
- **A key binding.** The key binding the README gives, added to the Fresh keymap, does the same as the command.
- **No automatic focus.** A1 still passes.

**A23.** (R23)
- **One group.** With the keyboard in the editor, switch to `b.md`: its Changes row is selected, the keyboard stays in `b.md`, and no diff opens.
- **Both groups.** Switch to `a.ts`: its Changes row is selected, not its Staged row. With `a.ts`'s Staged row selected, open its Staged diff and press Enter in it (R19): the Staged row stays selected.
- **Staged only.** Switch to `moved.ts`: its Staged row is selected.
- **Not listed.** Switch to a file that is not listed: the selection does not change.
- **Collapsed group.** Collapse Changes and switch to `b.md`: the selection does not change, and Changes stays collapsed.
- **Scrolling.** In the 1,200-file repository, with the section scrolled to the top, switch to a listed file near row 400: its row is selected and visible.
- **Refreshes.** Open a file that is not changed, edit it and save it. It is listed under Changes within 2 s, and the selection does not move to it.

**A24.** (R24)
- `gone.ts` under Changes draws its name struck through, and so does a file deleted with `git rm` under Staged (`capture-pane -e` shows SGR 9 on the name only).
- No other row in the fixture is struck through.

**A25.** (R25)
- **From the menu.** In the conflict fixture, right-click the `!` row: the menu lists View Diff, View File and Resolve Conflict. Choosing Resolve Conflict opens the file as a tab, and Fresh's merge resolution starts on it.
- **From the palette.** The same with the `!` row selected and Git Sidebar: Resolve Conflict.
- **Deleted.** On a `DU` conflict whose file is absent from the working tree, Resolve Conflict shows a "deleted" status message, and no buffer is created.
- **Resolver disabled.** With the merge_conflict plugin disabled, Resolve Conflict opens the file and shows no error.
- **Still not staged.** `git status` still shows the conflict afterwards.

**A26.** (R26) In the fixture:
- **The menu.** Right-click Staged Changes: the menu lists Unstage All and Commit….
- **A commit.** Choose Commit…, type `first`, and press Enter.
  - Within 2 s Staged Changes shows 0, and the title reads `Git · main ↑2 ↓0`.
  - `git log -1 --format=%s` prints `first`. A status message names the short commit id and `first`.
  - Changes still lists `a.ts`, `b.md`, `c.txt`, `d.txt` and `gone.ts`, and every working-tree file is byte-identical to before.
- **Cancel.** Esc at the prompt: `git rev-parse HEAD` is unchanged, and a status message says the commit was cancelled.
- **The keyboard afterwards.** After Commit… from the menu, once the commit is reported, Down moves the cursor in the editor (R17's exception).
- **An empty message.** Spaces only: no commit, and a status message says the message is empty.
- **Nothing staged.** In a clean repository, Git Sidebar: Commit… opens no prompt, and a status message says there is nothing staged. The Staged Changes menu has no Commit….
- **The message as typed.** Messages `-x` and `#x` give subjects `-x` and `#x`.
- **A failing hook.** A `pre-commit` hook that prints `nope` and exits 1: the status message includes `nope`. HEAD is unchanged, and the section still lists the staged files.
- **A slow hook.** A `pre-commit` hook that sleeps 70 s: after 60 s a status message says git is still running. The commit then completes and is reported. A `+` pressed meanwhile stages only after it, and Commit… meanwhile opens no prompt and shows a status message, whole, that a commit is still finishing.
- **A conflict.** During a merge with one `UU` file and one staged file, Commit… fails with git's reason, and `.git/MERGE_HEAD` stays.
- **A merge with every conflict resolved.** After resolving and staging every file in a merge, Commit… makes a commit with two parents, and `.git/MERGE_HEAD` is gone.
- **An unborn branch.** In a repository with no commits and one staged file, Commit… makes the first commit.
- **A held lock.** With `.git/index.lock` held externally, Commit… shows git's reason, and HEAD is unchanged.

**A27.** (R27) The README describes every item R27 lists. Following its Focus key binding example works (A22).

**A28.** (R28) Fresh runs with the Orchestrator, not `--simple`, on three folders: the fixture as A (the launch folder), a second copy of it as B on branch `feature-b`, and a plain folder P. Each is opened as a window.
- **Switching.** A switch to B shows B's section, titled `Git · feature-b`, with B's rows, and not A's. Back in A, A's section shows its rows, selection and group expansion as left, with no remount, and current status within 2 s.
- **Writes stay in their window.** In B, `+` on `b.md` stages it in B. Back in A, A's rows have not changed. In A, Stage All from the palette changes only A.
- **No repository.** In P there is no Git section, and the palette lists no Git Sidebar command. Back in B, they are listed again.
- **Restart.** Collapse B's section, leave A's open, quit, relaunch in A, then switch to B: B's section is collapsed and A's is open.
- **A write cut off.** With 2,000 untracked files in B, Stage All followed at once by a switch to A: B's remaining commands do not run, and no git runs for B while A is active. Back in B, the status bar says how many files were staged.
- **Windows on one folder.** Extract Tab to New Workspace on a tab of A: the new window has its own section for A's repository.
- **Closing a window.** Closing B's window from A leaves A's section working.
- Nothing is logged above warning level.

## Decisions

Decisions marked "user" were chosen by the user on 2026-11-23. Those marked "default" were proposed and accepted.

| Decision | Why | Source |
|---|---|---|
| Build a new plugin; do not fork or adopt `git-review` | Its gaps (see Why) are the core of the request | user |
| Local git now; GitHub repo later | Publishing is outward-facing | user |
| Branch in the title, not in a row | Saves a row. The remount a branch change triggers must keep group state (R2, R10) | user |
| ~~Activation opens the file, never a diff~~ (superseded on 2026-11-24, see below) | The 0.5.9 diff command works only on the active buffer and only HEAD vs working tree (INV §3) | user |
| Workspace repository only | Matches the explorer root | default |
| Conflicted files go under Changes, marked `!` | Keeps the ticket's two groups | default |
| Untracked files listed one by one, with a 500-row cap per group | Avoids an opaque `dir/` row, and the cap bounds an un-ignored `node_modules` | default |
| No close button | A closed section can't come back without a restart. Collapse hides it, and disabling the plugin removes it | — |
| Empty groups stay visible, with count 0 | The layout doesn't shift as files are staged | — |
| Nothing shown outside a git repository | Matches `git_statusbar` | — |
| Git runs on the host for bind mounts | Fresh's container authority keeps the filesystem on the host and assumes bind mounts; `runOnTarget` passes the host cwd to `docker exec -w`; images may lack git; in-container git meets ownership problems; `kill()` is a no-op there (INV §7) | default |
| Volume workspaces are detected with host-side `docker inspect`, and their behaviour follows P8 | Fresh cannot be assumed to read files that exist only in a volume (INV §7, §8) | user |

**2026-11-24 follow-up.** "user" decisions were chosen by the user on 2026-11-24; "default" ones were proposed and are open at spec approval.

| Decision | Why | Source |
|---|---|---|
| The title keeps `↑A ↓B`, including `↑0 ↓0` | It counts commits against the upstream, which is R2 working as specified (INV §9.2). File counts are already in the group labels | user |
| A click or Enter on a file row opens a side-by-side diff. The file opens only from the menu or the palette | A diff answers "what changed here" without leaving the section, and the file is one menu item away | user |
| A double-click gets no behaviour of its own | Fresh 0.5.9 delivers it as two clicks and then an Enter (INV §9.1), so it opens the diff like a single click | user |
| One diff tab, replaced by each click | No tab pile-up | user |
| `+`/`−` buttons on rows, with Space doing the same | 0.5.9 allows one button per row and no letter keys in a section (INV §9.3) | user |
| A right-click menu at the row, probed live first. If anchoring misbehaves from a sidebar section, the menu is dropped and the user told | It is the only menu that sits at the row, and it uses a host operation missing from the type file (INV §9.3) | user |
| Palette commands that act on the selected row | They are the only keyboard path to View File, and to every action outside the section | user |
| Conflicted files are never staged from the section | `git add` marks a conflict resolved even with its markers still in the file (INV §9.5) | user |
| Enter on a file row opens the diff | View File is menu- and palette-only, and Enter is the keyboard twin of a click | default |
| The diff's working-tree side is the file on disk, not unsaved edits | It matches what the row reflects | default |
| A conflicted row's diff is HEAD vs the working tree | There is no staged version during a conflict (INV §9.4) | default |
| No diff for binary files or over 5 MiB per side | Bounds the text moved through the plugin bridge (INV §9.4) | default |
| Directory rows (submodule, nested repository) get no button, and stage all skips them | `git add` on an untracked nested repository embeds it (INV §9.5) | default |
| After a row goes, the selection keeps its position in its group, not its index in the whole list | With the index, staging a file grows Staged Changes, so the index lands on the Changes group row and the next Space would stage the whole group (plan critique F1). Keeps R15's "repeated Space works down a group" | default |
| A click, a button press or a right-click on the selected row works as on any other row. This replaces the earlier amendment "a click on the already-selected file row opens nothing" | The user asked for the selected row's buttons to work. The plain sidebar tree swallows presses under its selection mark; the card layout at one line per row does not, at the cost of the mark (INV §8 P21) | user |
| The palette commands are listed whenever the section shows rows | Listing them only while the section has focus depends on focus order around opening the palette, which is unconfirmed (INV §9.3) | default |

**2026-11-24 review fixes.** Chosen by the user after the code review.

| Decision | Why | Source |
|---|---|---|
| Unstaging a copy resets only its new path; a rename still resets both | A copy's source keeps its own change, and R15 says "only that path". A rename's original is half of the same change: resetting the new path alone left `D <orig>` staged (INV §9.5, §8 P15) | user |
| No diff for a Changes or conflicted row on a symbolic link | Fresh's file API follows links and has no `readlink`, so the working-tree side would be the target's contents rather than the link (INV §8 P20) | user |
| Deletions, and a Changes rename's original path, are staged with `git update-index --remove`, not `git add` or `git rm --cached` | `add` on a deleted file that is now a directory also adds the directory's contents and embeds a nested repository, against R15's "only that path" (INV §8 P14). `rm --cached` drops the entry even when the file has come back since the row was read, staging the deletion of a file that exists; `update-index --remove` removes only a path that is gone, or is now a directory, when it runs (P23). Accepted cost: a deleted file under a directory since replaced by a symbolic link fails with git's reason (P23 i) | user |
| Stage and unstage are never killed; after 60 s a message says git is still running | Fresh 0.5.9's kill is a SIGKILL, and a killed git write leaves `.git/index.lock` behind (INV §8 P16) | user |
| A write past its 60 s is waited for: later writes queue behind it, and its result is reported when git exits | Until git exits it holds `.git/index.lock`, so the next write would fail; and R15 asks for git's reason when a write fails, late or not | default |
| Status messages carry no `git-sidebar:` prefix, and git's reason drops its `fatal:` or `error:` tag and shows paths inside the repository relative to its root | The status bar cuts a long message at its width, and git's reason comes last, so it was the part lost (seen live on a slow write's filter error, and on a held lock's absolute path). Fresh's bundled plugins use no prefix either; debug lines keep it | default |

**UX follow-up (2026-11-24).** "user" decisions were chosen by the user on 2026-11-24. "default" ones were proposed, and are open at spec approval.

| Decision | Why | Source |
|---|---|---|
| Take diff polish, Focus, auto-reveal, the row polish and a quick commit | VS Code's Source Control view is the standard, and the plugin stays simple. Each uses only the 0.5.9 API (INV §10.3, §10.4) | user |
| Discard and hunk staging wait for their own tickets | Discard is destructive. Hunk staging costs the most, and breaks under autocrlf (INV §10.4) | user |
| Enter in the diff opens the file (R19) | Fresh's Review Diff and the file-diff plugin use Enter for this (INV §10.3 a). `n`, `p`, `]`, `[`, `q` and Esc are already Fresh's | default |
| Enter on a section row still keeps the keyboard in the section | VS Code's keyboard open keeps focus in the list (INV §10.1), so a user can step through diffs. Fresh's explorer moves focus instead. Clicking into the diff reaches R19 and R20, and Esc in the section gives the keyboard back to the editor (INV §8 P25 e) | default |
| The key hint is a status message | 0.5.9 offers no header buttons or toolbar that fit a section (INV §10.5). Fresh's references and diagnostics panels show their keys the same way | default |
| Auto-reveal is always on, with no setting | Settings are out of scope, and VS Code reveals by default. It acts only on a tab change (never on a refresh, R10), never while the keyboard is in the section (where it would move the row Space acts on), and never expands a group | default |
| Focus selects the first row when none is selected | Enter and Space need a selected row | default |
| A collapsed section is expanded by Focus. IF the declared `"focus"` operation does not do it (INV §10.7 P27), the plugin also uses Fresh's undeclared `"reveal"` operation, as Markdown's Focus Contents does. That is a second exception to "declared APIs only", after the menu's anchor, and holds only while a live probe passes. IF neither expands it, R22's collapsed bullet is dropped, and the README says to expand the section first. The probe found that `"focus"` alone expands it, so `"reveal"` is not used (INV §8 P27) | It keeps Focus one step, and matches Fresh's built-in section | default |
| Strike-through only on `D` rows, not on conflicts that delete | A conflict keeps `!` and its colour as its one signal | default |
| Resolve Conflict hands off to Fresh's merge-conflict plugin. IF a live probe (INV §10.7 P29) shows resolution cannot be started on the file just opened, R25 narrows to opening the file, where that plugin shows its own "Merge: Start Resolution" hint (INV §10.3 e). The probe found that resolution does start (INV §8 P29). With the plugin disabled its action is unknown, and asking for it logs an error, so the plugin checks that merge_conflict is enabled first | Building a resolver would not keep the plugin simple. VS Code hands conflicts to its merge editor too | default |
| A commit takes only what is staged, and never stages by itself | Staging everything implicitly could mark conflicts resolved (INV §9.5). VS Code asks before it does | default |
| A one-line message from Fresh's prompt | A message body would need an editor buffer and a save-to-commit flow | default |
| A commit runs the repository's hooks | It behaves like a commit from a terminal | default |
| A commit concludes a merge, cherry-pick or revert in progress | It does what `git commit` does in a terminal, like VS Code's Continue | default |
| Commit lives in the Staged Changes menu and the palette, with no button | A row has one button (INV §9.3), and Staged Changes' button is `−` | default |
| A successful commit's message names its short id and message | The status bar is the only feedback the section has | default |
| R21 covers syntax picked by a file's name or extension. A file Fresh recognises only by its first line (a shebang) stays plain in the diff, and the README says so | Fresh picks a diff source's grammar from the buffer's name and passes it no first line (INV §8 P26). Setting the language by hand would need a language name the plugin cannot derive from the file | user |

**2026-11-24 verification follow-up.** Chosen by the user after the live verification of R19–R26.

| Decision | Why | Source |
|---|---|---|
| The diff's key hint waits until the keyboard is in the diff (R20) | A click or Enter on a row leaves the keyboard in the section (R14), where the hint's keys do nothing: seen live, Enter right after the hint appeared opened nothing. Showing it once the keyboard moves in puts it where the keys work, and the row's quick stepping through diffs stays | user |
| After Commit… from the menu, the keyboard is in the editor (R17's exception) | The prompt takes the keyboard, and Fresh gives it to the editor when the prompt answers, as after the palette (INV §8 P30). Only Focus moves the keyboard into the section (R22), and the section never takes it by itself (R1) | user |
| Auto-reveal keeps a file's Staged row when it is already selected (R23) | Trading it for the Changes row moved the row Space acts on: seen live, opening a file from its Staged diff then made Space stage instead of unstage. VS Code also leaves its selection alone when it already is the active file (INV §10.3 c) | user |
| Esc at the commit prompt says the commit was cancelled (R26) | Fresh draws its own "Search cancelled." beside the plugin's last message, which was left standing: seen live as `Search cancelled. \| nothing staged to commit` with a file staged (INV §8, live checks) | user |

**2026-11-24 every window.** Proposed with R28 ("default"), and open at spec approval. The user asked for the section in every project.

| Decision | Why | Source |
|---|---|---|
| One section per window, each with its own panel id | Fresh 0.5.9 has one section per panel id, editor-wide: a mount with another window's scope moves it (INV §11.1) | user |
| The panel id comes from the window's stable id, or from its folder when the stable id is empty | Window ids change on every launch, and two windows can share a folder. The saved collapsed state is keyed by panel id (INV §11.2) | default |
| A window's section is mounted when the window becomes active, at load for the launch window, never earlier | A mount before Fresh restores the window turns its saved layout into a hint that is not applied. A mount on activation claims it (INV §11.2, §8 P32) | default |
| Only the active window's section refreshes, and git starts only for it | `runOnTarget` runs on the active window's authority, and status messages and contexts go to the active window (INV §11.4). It also keeps R11's 25% across windows. `openMachine` could lift the first limit later | default |
| A stage, unstage or commit not yet run when its window stops being active is not run, and says so when the window is active again | Running it would take the wrong window's authority. Switching in the middle of a write is rare | default |
| Status messages about an inactive window wait until it is active again, all of them in order, shown together; a repeat of the last one waiting is kept once | `setStatus` writes to the active window, where the message would name another project's files. Keeping only the last would lose a git failure's reason (R15) under a later "not run". A repeat back to back adds nothing to read | default |
| Windows on one repository share one write queue | Two windows on one folder, or on folders of one repository, would otherwise write at once and collide on `.git/index.lock` (R15, INV §8 P16) | default |
| A section restarts on `authority_changed` only when its own window's label changed | The hook also comes on a switch between windows with different authorities (INV §11.4). Restarting then would drop the window's mode, and the outcome of a write still running (R15, R26) | default |
| Load unmounts the old panel id 1 once | The host keeps a section across a plugin reload, so an update without a restart would leave the old section on screen beside the new one (INV §2). A window's saved state under id 1 is dropped once, so its collapsed state resets after the upgrade | default |
