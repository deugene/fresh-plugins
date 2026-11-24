# git-sidebar

Spec: `docs/specs/git-sidebar.md` (R*n*). Investigation: `docs/investigations/git-sidebar.md` (INV §*n*, P*n*).

## Structure

- `git_sidebar.ts` only wires the editor to `lib/`. The `lib/` modules never touch editor globals: git runs through the injected `Runner` and time comes in as arguments. Put logic in `lib/` and unit-test it there.
- `tests/fake_editor.ts` fakes the part of Fresh's `EditorAPI` the plugin uses. It installs `getEditor`, `registerHandler` and a manual `Date.now`, and `advance(ms)` fires timers, delays and process completions in order. A newly used editor API has to be added there.
- `tests/plugin.test.ts` re-imports the entry with `?load=N` for each test, so every test gets fresh module state.
- `tests/fixtures/*.z` are real `git status` outputs. To change or add one, edit `tests/fixtures/record.sh` and re-run it; don't hand-edit the files.
- `tests/live/fixture.sh <name> [--devcontainer <image> | --volume]` builds the acceptance repository under `~/.cache/gs-live/` for checks in a running editor.

## Invariants the host forces

- **Section lifecycle (INV §5, P2).**
  - Mount synchronously at load once a `.git` is found. A later mount loses the divider the user dragged.
  - Never unmount to refresh: that loses the collapsed state and height. Update in place. Row buttons are part of the signature, so a button appearing is an in-place update too.
  - A title change (such as a branch switch) forces a remount. Every mount must pass `closable: false`, `startBlurred: true` and `scope: { window }`, because a mount without them reverts to a closable section that takes focus.
- **Expansion and selection.** The plugin owns them by item key. A remount resets the host's copy, and the host keeps the selection by index, so the plugin re-pushes both.
- **Stale runs.** Every awaited git or docker run re-checks `epoch`, which changes on authority change, trust change and end. A new async step must check it too.
- **Where git runs (INV §7).** In a dev container the filesystem stays on the host. With a bind-mounted workspace, git runs on the host through `spawnHostProcess`, which returns `exit_code`, not `code`. `runOnTarget` in a container gets the host cwd and its `kill()` does nothing. A volume workspace runs no git and shows a notice instead.
- **No `index.lock` from refreshing.** Status and the diff's `cat-file` reads run with `--no-optional-locks` (R11); rev-parse takes no lock. Only a stage or unstage the user asked for writes the index, and it runs outside the scheduler, through `OpQueue`, one at a time. Every write's argv starts with `--literal-pathspecs`, and group writes always list their paths: a bare `git reset` or `add -A` ends merges and resolves conflicts (INV §9.5).
  - Never kill a write: in 0.5.9 `kill()` is a SIGKILL on both runners, and a killed git leaves `index.lock` behind (INV §8 P16). Writes go through `runWrite`, which waits past `WRITE_TIMEOUT_MS` for git to exit, so `OpQueue` never starts the next write while one still holds the lock. Only reads are killed.
  - A deletion stages with `update-index --remove`, never `add` or `rm --cached`. `add` on a deleted path that is now a directory adds its contents and embeds nested repositories. `rm --cached` drops the entry even when the file has come back since the row was read. A Changes rename's original path is a deletion too. Stage all runs the deletions first (INV §8 P14, P23).
  - Every write's argv is built from the rows on screen, which may be stale by the time it runs, so each command must take its paths' state when it runs. `add`, `update-index --remove` and `reset` do; that is why a key can be released after a failed refresh.
  - A rename's write names its original path too; a copy's names only its new path (R15).
- **Failures.** A definitive failure before anything is shown removes the section (R1). After that, the last good result stays on screen (R10).
- **Epoch and writes.** Diff builds, writes and each group chunk re-check `epoch` after every await. A write that finishes across an epoch change only logs. A status that was running when a write finished is not drawn (`writeSeq`).
- **Selection by key, then by place.** `select`, `expand`, `activate` and `action` record the selection; `context` does not (the host does not move it). When the selected row goes, the selection takes the same offset in the same group, not the old global index (R10, R15).
- **Panels.** Panel 1 is the section, panel 2 the right-click menu. Route panel 2 before the panel 1 filter. A menu choice is in `widget_key`, not the payload. Panel 2's `cancel` (Esc, a click outside) closes only the menu: it is never the end, which is panel 1's `cancel`.
- **The diff view.** `closeCompositeBuffer` does not close the composite's buffer: close a view with it, then `closeBuffer(id, true)` on the composite and both sources (INV §9.4, P9). Only it drops the host's composite state, so a user close (`buffer_closed`) calls it too (P19). Pass `hunks` as a list, never null, or the host draws nothing. Build them with `compositeHunks`: an empty side counts as one line but draws none, and plain line hunks leave a row pointing at it, which logs a warning every frame (P22).
- **Presses on the selected row (INV §8 P21).** A sidebar tree in the plain layout lays a `▌` mark over its selected row, and the mark swallows every press on that row: its click, its button, a right-click. The tree spec sets `cardBorders: true` with `itemHeight: 1`, which draws the same rows without the mark. Keep both, and recheck after a Fresh upgrade: the type file says `cardBorders` acts only above height 1.
- **Host quirks.** `readFile` returns `undefined`, not null, for a file that is not UTF-8. Process stdout that is not UTF-8 comes back lossy (U+FFFD) from `runOnTarget` and as `""` with exit 0 from `spawnHostProcess` (INV §8 P17). The QuickJS runtime has no `TextEncoder` and no Node globals; tests run on Node and do not catch that, so the live check does.
- **No rejections.** Every handler, command and async entry point goes through `guarded` or `guardedAsync`. Throw nothing synchronously inside an `async` function that is awaited later: QuickJS reports the rejection before the `await` handles it.
