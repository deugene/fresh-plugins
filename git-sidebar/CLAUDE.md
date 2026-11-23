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
  - Never unmount to refresh: that loses the collapsed state and height. Update in place.
  - A title change (such as a branch switch) forces a remount. Every mount must pass `closable: false`, `startBlurred: true` and `scope: { window }`, because a mount without them reverts to a closable section that takes focus.
- **Expansion and selection.** The plugin owns them by item key. A remount resets the host's copy, and the host keeps the selection by index, so the plugin re-pushes both.
- **Stale runs.** Every awaited git or docker run re-checks `epoch`, which changes on authority change, trust change and end. A new async step must check it too.
- **Where git runs (INV §7).** In a dev container the filesystem stays on the host. With a bind-mounted workspace, git runs on the host through `spawnHostProcess`, which returns `exit_code`, not `code`. `runOnTarget` in a container gets the host cwd and its `kill()` does nothing. A volume workspace runs no git and shows a notice instead.
- **No `index.lock`.** git always runs with `--no-optional-locks` (R11).
- **Failures.** A definitive failure before anything is shown removes the section (R1). After that, the last good result stays on screen (R10).
