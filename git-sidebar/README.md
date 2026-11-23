# git-sidebar

A **Git** section in [Fresh](https://github.com/sinelaw/fresh)'s file-explorer sidebar, below the explorer:

```
├ ▼ Git · main ↑1 ↓0 ──────────┤
│▼ Staged Changes 2            │
│   M a.ts                     │
│   R moved.ts  ← old.ts       │
│▼ Changes 5                   │
│   M a.ts                     │
│   M b.md                     │
│   D gone.ts                  │
│   U c.txt  new               │
│   U d.txt  new               │
```

- The title shows the branch, with ahead/behind counts when it has an upstream. A detached HEAD shows the short commit id.
- **Staged Changes** lists what differs between HEAD and the index. **Changes** lists working-tree edits, every untracked file, and conflicts (`!`). A file changed in both places is in both groups.
- Markers: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `T` type changed, `U` untracked, `!` conflicted. Colours come from the theme's git file-status colours, so they follow theme changes.
- Enter or double-click on a file opens it. A file that is deleted in the working tree gets a status message instead. Enter on a group toggles it.
- Collapse the whole section from its header (▼/▶). Fresh remembers the collapsed state and the height you drag it to for each workspace.
- It keeps itself current: on save, revert, editor focus and file-explorer changes, and every 2 s for changes made outside the editor. Git is never kept busy more than 25% of the time, and the plugin never takes `.git/index.lock` (it runs `git --no-optional-locks status`).
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

- Read-only: no staging, unstaging, discarding or committing. Rows open the file, not a diff.
- Only the workspace's repository: no submodules or nested repositories. A repository created after Fresh started appears after a restart.
- At most 500 rows per group, then a `… N more` row.
- Clicking a group row that is already selected does not toggle it: Fresh 0.5.9 sends no event for that click, and the row's disclosure column shows the selection bar instead of ▶/▼. Use Left/Right, Enter or Space instead.
- SSH remote workspaces: best effort, not verified.

## Development

```
npm install
npm run check   # tsc, unit tests (node --test), fresh --check-plugin
```

`tests/fixtures/record.sh` re-records the `git status` outputs the parser tests use. `tests/live/fixture.sh` builds the acceptance repository (optionally with a dev-container config) under `~/.cache/gs-live/` for checks in a running editor.

## License

MIT
