# Investigation: Git section in the Fresh sidebar

**Ticket.** Add a Git section to the sidebar, under the file explorer, "like the markdown plugin does".

- It shows the current branch and two expandable groups, **Staged Changes** and **Changes**.
- The whole section can be collapsed.
- It is the first plugin in a new multi-plugin repo, `deugene/fresh-plugins`, modelled on `sinelaw/fresh-plugins`.

**Context.** Date: 2026-11-23.

- Installed editor: `fresh 0.5.9` at `/opt/homebrew/bin/fresh`.
- Upstream checked at `sinelaw/fresh` master `36f2588` (2026-11-22). Its sidebar, tree and mutation API is unchanged from v0.5.9.
- HEAD-only APIs such as `addFileExplorerMenuItem`, `setWindowState` and tree `hoverAction` are not in 0.5.9 and must not be used.

**Path shorthands**

| Shorthand | Path |
|---|---|
| `EP` | installed embedded plugins, `~/Library/Caches/fresh/embedded-plugins/4236c9a224cc1cfa/` |
| `DTS` | `~/.config/fresh/types/fresh.d.ts`, byte-identical to v0.5.9's `lib/fresh.d.ts` |
| `SRC` | v0.5.9 source worktree, `/tmp/fresh-investigate/v059/crates/` |
| `UP` | upstream master clone, `/tmp/fresh-investigate/fresh/` |

Probe repos are in `/tmp/fresh-investigate/probe/`, and were run with git 2.50.1.

## 1. Does a setting or an existing plugin already do this?

**Editor settings: no** (high).

- `sidebar` has a single key, `accordion` (`free` | `exclusive`).
- `file_explorer.*` covers visibility, ignore rules, layout and glyphs. None of its keys filter by git status (`EP/config-schema.json`).
- Apart from gitignore, no schema key mentions git, staging or VCS.

**Built-in plugins: no** (high).

- **Sidebar sections.** The only built-in that mounts a sidebar section is `markdown_toc.ts:438`.
- **`git_explorer`.** Puts one M/A/D/R/U badge on each row of the whole tree, and the staged letter wins (`EP/git_explorer.ts:90-93`).
  - Staged vs unstaged differs only by colour, and the tree is never filtered to changed files.
  - Its only setting is `colorNames` (`:33`).
- **`git_statusbar`.** Shows the branch in the status bar only (`:98-101`).
- **`git_gutter` and `live_diff`.** Line-level marks inside a buffer.
- **`git_log`.** Commit history in a tab.
- **`audit_mode` "Review Diff".** The closest built-in.
  - It has STAGED / UNSTAGED / UNTRACKED groups (`EP/audit_mode.ts:888-942`, `1520-1533`) and staging.
  - It is a full tab layout (`createBufferGroup`, `:7460`), which is exactly what the ticket wants to avoid.

**Registry and sinelaw/fresh-plugins: no** (high).

- The registry `sinelaw/fresh-plugins-registry` `plugins.json` lists 9 packages (calculator, color-highlighter, todo-highlighter, amp, dotfiles, text-actions, file-diff, polkit, fresh-discord-rpc). None of them is about source control.
- `sinelaw/fresh-plugins` @ `3f32736` has no git plugin.

**Third party: `asukaminato0721/fresh-plugins#git-review` does most of it** (high, verified in source).

- Source copy: `/tmp/fresh-investigate/git-review/git_review.ts`, v1.2.0, last commit 2026-10-13, not in the registry. Its author linked it from issue #3205 ("vscode-like git panel", closed).
- What matches:
  - It mounts a "Git Review" sidebar section (`:199`).
  - It has collapsible "Changes" (untracked merged in) and "Staged Changes" groups (`:121-122`).
  - Clicking a file opens a diff.
- Where it falls short of the ticket:
  - **No automatic refresh.** It listens only to `widget_event` (`:666`) and `buffer_closed` (`:741`), so you have to run "Git Review: Refresh" by hand.
  - **Not always on.** You open it with "Git Review: Toggle" (`:653`).
  - **Group expansion resets** on every reload (`:357`).
  - **An extra commit list is always shown**: the last 50 commits, with no way to turn it off (`:321`).
  - **Wrong order.** "Changes" sits above "Staged Changes".
  - **No branch.** It runs only `rev-parse --show-toplevel` (`:375`).
  - **No settings.**
  - **Unsaved buffers mixed in.** It adds unsaved buffers to "Changes" (`:302-313`).
- Installing it via `…#git-review` should work (`EP/pkg.ts:447-503`), but this is UNCONFIRMED.

**Upstream** (high).

- **PR #3539 "add source control plugin"** was closed unmerged on 2026-10-19.
  - It was a tab, not a sidebar section.
  - The maintainer said: "How about publishing this in your own repo and listing it in the plugin registry?"
- **Issue #526.** The maintainer said explorer git features are "a good candidate for plugins, rather than core code".
- **The internal design doc** (`UP/docs/internal/sidebar-sections-design.md:240,288`) has "Git Changes" only as a mockup, and nothing implements it.

**Verdict.** No setting or built-in does this. The maintainer wants this kind of feature to be a third-party plugin, so a new plugin is justified.

- git-review is the nearest existing piece.
- Choosing between a new plugin, a fork of git-review, and git-review as is goes to the user (§6).

## 2. Host API: sidebar sections and trees (all in 0.5.9)

**Mounting** (high).

- **Call:** `mountSidebarSection(panelId, spec, title, rows, {closable=true, startBlurred=false, scope})` (`DTS:8128-8158`, `SRC/fresh-plugin-runtime/src/quickjs_backend.rs:8731-8790`).
- **Return value:** `false` only for an invalid spec.
- **Update:** `updateFloatingWidget(id, spec)`.
- **Remove:** `unmountFloatingWidget(id)`.
- **Other ops:** `floatingPanelControl(id, "sidebar_rows"|"focus"|"blur"|"reveal", n)`. `"reveal"` is used by `markdown_toc.ts:453` but is missing from the DTS list.

**Placement** (high).

- The explorer is always section 0.
- New sections are appended in mount order (`SRC/fresh-editor/src/app/sidebar.rs:659-678`).
- Neither the plugin nor the user can reorder them.

**`rows`** (high). It is the body height, without the 1-row header.

- `0` shares the leftover space.
- The last open section takes whatever remains.
- Once the user drags a divider, the plugin's `rows` values are ignored (`app/sidebar.rs:241-292,687-690`).
- When space runs out, sections collapse from the bottom up.

**Scope** (high).

- The default is the window that was active at mount.
- Sections outside the current scope are parked, keeping their rows and collapsed state.
- When the scope's buffer or window dies, the section is dropped and a `cancel` event fires (`plugin_dispatch.rs:6466-6478`, `app/sidebar.rs:937-1028`).

**Collapsing the whole section is the host's job** (high).

- The `▼/▶` header toggles on click when there is more than one section, which is always true with the explorer present (`SRC/fresh-editor/src/view/shell/sidebar.rs:486-640`).
- Enter/Space on a focused header reopens the section.
- The plugin **gets no event** on collapse or expand, cannot collapse the section itself, and cannot read the collapsed state. It can only `"reveal"` or `"focus"`.
- Collapsed state and rows are saved per workspace for window- and editor-scoped sections (`app/sidebar.rs:754-787`).
- On restore, a placeholder waits about 4 frames for the same id, so **mount at plugin load** (`:809-899`).
- An unmount followed by a mount loses the user's collapsed state, so keep the section mounted and update it.
- `sidebar.accordion = "exclusive"` collapses the other sections when one opens.
- **So the plugin writes no code for "the section itself is collapsible".**

**Remounting the same id** (high).

- Position, rows and collapsed state survive. The title is replaced.
- **Tree expansion and selection reset to the spec's seeds** (`plugin_dispatch.rs:6513`).
- The `focused` flag is cleared, and a non-blurred mount takes focus again.
- The title is plain text, fixed per mount, and truncated when narrow, so showing the branch in the title means a remount on every branch change. `markdown_toc.ts:356,420-447` does this.

**Tree spec** (high).

- **Shape.** `{kind:"tree", key, nodes, itemKeys, selectedIndex, expandedKeys, toggleOnClick, indentCols, …}` (`DTS:2456-2532`).
  - The node list is flat.
  - A group is `{depth:0, hasChildren:true}` and a file is `{depth:1}`.
  - `itemKeys` holds stable keys in the same order, and expansion is keyed by them.
- **State ownership.** `selectedIndex` and `expandedKeys` only seed the first render. After that the host's instance state wins (`DTS:2463-2470`, `SRC/fresh-editor-core/src/widgets/kinds/tree.rs:372-424`).
- **Updating** with `updateFloatingWidget` and the same tree `key`:
  - Expansion is kept by key.
  - Selection is kept by **index**, so rows inserted above it shift the highlight. Track the selected key yourself and push `widgetMutate({kind:"setSelectedIndex"})`.
  - `setExpandedKeys` replaces the expansion set.
  - `markdown_toc.ts:333,460-461,505-522` owns its expansion and re-pushes it.
- **Scroll** surviving an update: UNCONFIRMED.
- **`toggleOnClick:true`.** A click on a group row toggles it and fires `expand`. A click on the disclosure glyph always toggles.

**Events.** All arrive through `editor.on("widget_event", e)`, filtered on `e.panel_id`. Panel ids are scoped per plugin (high).

| Event | Payload | Triggered by |
|---|---|---|
| `select` | `{index, key, via?:"click"}` | moving or clicking the selection |
| `activate` | `{index, key, via?:"space"}` | Enter, double-click, Space |
| `expand` | `{index?, key, expanded}` | group toggled |
| `context` | `{index, key, col, row}` | right-click |
| `action` | `{index, key}` | the row's `[ label ]` button |
| `focus` / `blur` | | section gains or loses keyboard focus |
| `cancel` | | × clicked or scope died; the host has already unmounted |

**Styling** (high).

- **Text.** `TreeNode.text` is a `TextPropertyEntry` with `segments:[{text, style}]` (`DTS:107-155`).
- **Colours.** These accept `"theme.key"` strings, which are resolved at render time, so they follow theme changes.
- **Git colour keys.** `ui.file_status_{added,modified,deleted,renamed,untracked,conflicted}_fg`.
- **Badges.** 0.5.9 has no field for a right-aligned badge. The options are:
  - inline segments: `name  M`, or a count in the group label;
  - a table, via `columns` and `cells`. It always draws a header row, and its types are missing from the DTS;
  - `action:"M"`, which is a clickable button and cannot be themed.
- **Width.** No API reports the section width (UNCONFIRMED).

**Hazards** (high).

- **No cleanup on unload.** The host does not clean up sections when a plugin unloads, and there is no unload hook (`quickjs_backend.rs:694-733`). A reload must mount the same id straight away.
- **Hidden explorer.** Sections are not drawn while the explorer column is hidden.
  - A blurred mount waits invisibly.
  - A non-blurred mount, or a `"focus"`/`"reveal"` call, forces the column open. That is hostile for an automatic mount, so use `startBlurred:true`.
- **Unhandled rejections.** An unhandled promise rejection kills the plugin runtime (`fresh --cmd help plugin`).

## 3. Git plumbing

**Running git** (high).

- **Call:** `await editor.runOnTarget("git", args, cwd)` returns `{code, stdout, stderr}` (`DTS:8815-8846`).
- **Never rejects.** A process that fails to start, including when git is missing or workspace trust is denied, gives `code:-1`. A directory that is not a repo gives `128`.
- **Always pass `cwd`.** An empty one means the editor's own process cwd.
- **Encoding.** stdout is lossy UTF-8.
- **No timeout.** There is no host-side timeout. Use `Promise.race` with `editor.delay` plus `handle.kill()`.
- **`spawnProcess`** is deprecated.

**Status command.** `git --no-optional-locks status --porcelain=v2 --branch -z -uall` (high, probed).

- `--no-optional-locks` avoids racing the user's own `git add` or `git commit` for `index.lock` (`EP/audit_mode.ts:977-985`).
- One call returns everything below.

| Probed case | Output |
|---|---|
| Branch | `# branch.head <name>` |
| Detached HEAD | `# branch.head (detached)` |
| Unborn branch | `# branch.oid (initial)` |
| Upstream | `# branch.upstream`, `# branch.ab +A -B` |
| Upstream gone | `branch.upstream` present, no `branch.ab` |
| Ordinary change | `1 XY …` |
| Rename / copy | `2 XY … R100 new\0old\0`. The orig path is the next NUL field, so consume it. git_explorer gets this wrong (`:81-83`). |
| Conflict | `u XY …`, one of `DD AU UD UA DU AA UU` |
| Untracked | `? path` |

- **Classification** (`audit_mode.ts:897-937`): X ≠ `.` means Staged, and Y ≠ `.` means Changes.
  - The two checks are independent, so `MM` lands in both groups.
  - `git rm --cached f` yields `1 D.` and `? f`, so the same path lands in both groups.
  - `add -N` gives `1 .A`.
- **Conflicts** are not grouped by any built-in. The ticket names only two groups (§6).
- **`-uall` vs `-unormal`.** `-uall` lists every untracked file, whereas `-unormal` collapses a new directory to `? d/`.
  - `-uall` is what audit_mode uses (`:954-963`).
  - It can blow up with an un-ignored `node_modules`, so cap the rendered rows.

**Repo root** (high).

- git_explorer uses `editor.getCwd()` plus `rev-parse --show-toplevel`.
- `lib/git_repo.ts:37-72` tries the active buffer's directory first.
- Built-in `lib/` helpers **cannot be imported** by third-party plugins (`UP/docs/plugins/development/utilities.md:10`), so copy them.

**Refresh triggers** (high unless noted).

- **Events git_explorer uses** (`EP/git_explorer.ts:228-256`): `after_file_save`, `after_file_revert`, `after_file_open`, `after_file_explorer_change`, `editor_initialized`, `focus_gained`, `config_changed`. It coalesces with an in-flight/pending pair (`:38-39,153-157`).
- **Events to avoid:** `render_start` and cursor events, which are hot (`git_statusbar.ts:113-116`). `idle` is declared but never emitted.
- **Host index poll.** The host stats `<git-dir>/index` every `file_tree_poll_interval_ms` (default 3000) and fires `after_file_explorer_change` (`SRC/fresh-editor/src/app/file_operations.rs:1022-1190`).
  - It only runs once the explorer has been created in the active window (medium-high).
- **What changes in `.git`** (probed):
  - A commit touches `index` and `logs/HEAD`.
  - A branch switch touches `HEAD`, `index` and `logs/HEAD`.
  - **A plain edit outside the editor touches nothing**, so no event fires.
- **`watchPath`.** `watchPath(<absolute git dir>, false)` catches changes to `HEAD`, `index` and `MERGE_HEAD`.
  - Use the absolute git dir, because relative paths containing `..` never match (`live_diff.ts:1385-1418`, #2503).
  - On macOS, non-recursive watches poll every 2 s.
  - git replaces `HEAD` by rename, so prefer a directory watch to a file watch (UNCONFIRMED on inotify).
- **Backoff poll.** audit_mode covers outside edits with a self-re-arming timer (`audit_mode.ts:6264-6349`).
  - The delay is 2 s at minimum, `lastTick*4`, capped at 60 s.
  - It skips while a tick is in flight and re-renders only when the result's signature changes.
  - Its comment says there is "no cheaper signal".

**Acting on a row** (high).

- **Opening.** `editor.openFile(path)`.
- **Deleted files.** Opening a deleted file creates an empty unsaved buffer (`SRC/fresh-editor/src/app/file_open_orchestrators.rs:284-290`), so check `fileExists` first.
- **No per-file diff API.**
  - `runCommand("Side-by-Side Diff")` works on the active buffer only, always compares HEAD with the working tree, and its name is localized (`audit_mode.ts:8025-8082`).
  - A plugin-built diff via `compare-files` or a composite buffer is possible but more work (medium).

## 4. Repo layout, packaging, dev loop, tests

**Layout** (high). Follow `sinelaw/fresh-plugins`:

- one kebab-case directory per package, with an entry `.ts` at the package root (usually snake_case);
- an optional `<stem>.i18n.json`, `README.md`, `lib/` and `tests/` per package;
- a MIT LICENSE at the repo root;
- no CI upstream.

Its stale vendored `fresh.d.ts` copies are not worth copying, and `calculator.ts` doesn't even typecheck.

**package.json** (high).

- **`$schema`:** `fresh-editor.dev` does not resolve. Use `https://raw.githubusercontent.com/sinelaw/fresh/main/crates/fresh-editor/plugins/schemas/package.schema.json`, which is the `$id` and what the scaffold writes.
- **Validation on install.** `pkg.ts validatePackage` (`EP/pkg.ts:820-892`) checks that:
  - `name` is present;
  - `type` is one of `plugin`, `theme`, `language`, `bundle`;
  - the entry `fresh.entry || fresh.main || <name>.ts` exists.
- **Version fields.** `min_api_version > 2` only warns. `min_version` is not enforced.

**Install from a monorepo** (high).

- **URL:** `https://github.com/deugene/fresh-plugins#<dir>` (`pkg.ts:447-503`, `~1530-1590`).
- **What gets copied:** a depth-1 clone, from which only the subdirectory is copied into `~/.config/fresh/plugins/packages/<manifest.name>`. Shared code at the repo root is not available after install, so vendor helpers into each plugin.
- **Registry entries** use the same `#subdir` form.

**Loading rules** (high).

- **Every top-level `*.ts`/`*.js` in a package directory loads as its own plugin**, non-recursively, skipping `.i18n.` files (`SRC/fresh-plugin-runtime/src/thread.rs:1622-1640`). `fresh.entry` is not consulted at startup.
- **Name and settings key.** The plugin name, which also keys its config entry `plugins.<name>`, is the file stem.
- **Helpers** go in `lib/` or `src/` and are imported relatively.
- **Stem collisions.** A stem that collides with a built-in overwrites it messily. Avoid:
  - `git_blame`, `git_explorer`, `git_find_file`, `git_grep`, `git_gutter`, `git_log`, `git_statusbar`
  - `live_diff`, `diff_nav`, `merge_conflict`, `audit_mode`, `compare_files`

**i18n** (high).

- `<stem>.i18n.json` is auto-loaded, and strings are looked up with `editor.t()`.
- `%cmd.x` names are translated automatically.
- Fallback to `en` happens per whole map, not per key.
- i18n is optional: without the file, `t()` returns the key itself.

**Dev loop** (high from code, not exercised live).

- **Symlink.** `ln -s <repo>/<plugin> ~/.config/fresh/plugins/packages/<name>` is supported. "Load Plugin from Buffer" then reloads it in place, matched by canonical path (`SRC/fresh-editor/src/app/lsp_actions.rs:1427-1440`).
- **Scaffold.** `fresh --cmd init plugin`.
- **Logs.** `~/.local/state/fresh/logs/fresh-server-<pid>.log` (`editor.debug` → `DEBUG … Plugin:`).
- **`fresh --check-plugin <file>`** is hidden but works on 0.5.9. It parses and bundles only and **does not typecheck**.

**Tests and CI** (high).

- **Model:** fresh-inline-blame (`~/.config/fresh/plugins/packages/fresh-inline-blame/`, upstream `thedadams/fresh-inline-blame`).
  - Pure logic lives in `src/` and is compiled to CJS, then tested with `node --test`.
  - A fake `getEditor` drives the compiled entry.
  - `make check` runs typecheck, test, manifest-check and plugin-check (`fresh --check-plugin`).
  - Its CI installs `@fresh-editor/fresh-editor` from npm (0.5.9) to get the `fresh` binary.
- **Node.** Node 24 here can run `.ts` tests directly through type stripping, as Fresh core's own lib tests do (medium).
- **TypeScript.**
  - `npx typescript` now resolves to 7.0.2, which removed `moduleResolution: node`.
  - Use `bundler`, or `nodenext` for a CJS test build, and pin the TS major version in devDependencies.

## 5. Constraints that shape any design

1. **No plugin code for section collapse.** The host owns it, so the plugin writes nothing for it.
2. **Mount once, at load.** Use a stable id and `startBlurred:true`, then update in place. Never unmount to refresh, because that would lose the user's collapsed state and divider position.
3. **Track expansion and selection by key.** The plugin should do this and re-push them after any remount, and the selected index after updates that shift rows.
4. **Refresh on three signals:**
   - editor events;
   - an absolute git-dir watch;
   - a backoff poll for edits made outside the editor.

   Coalesce runs and re-render only when the result changes.
5. **Status data.** Use `--porcelain=v2 --branch -z`, with renames handled, and the same file allowed in both groups.
6. **Packaging.**
   - Pick a plugin stem that is not a built-in name.
   - Keep helpers in `lib/`.
   - Pin the TypeScript major version.
   - Use the raw-GitHub `$schema` URL.

## 6. Decisions for the user

1. **Approach:** a new plugin, a fork of git-review, or git-review as is.
2. **GitHub repo:** create `deugene/fresh-plugins` now (outward-facing; public or private), or `git init` locally and publish later.
3. **Branch display:**
   - In the section title. This is compact, but each branch change remounts the section.
   - As a row inside the tree. This updates in place and can carry ahead/behind counts.
4. **Row action:** open the file, which is robust (deleted files need handling). A diff is fragile in 0.5.9.

Defaults proposed unless overridden:
- **Repo:** the workspace repo (`getCwd()`), window-scoped.
- **Conflicted files:** go under Changes, with the conflict colour and a `!` badge.
- **Untracked files:** listed individually (`-uall`), with a row cap.
- **Staging actions:** none, out of scope.
- **Refresh:** event + watch + backoff poll, as in §5.4.

## 7. Dev containers

Read from the v0.5.9 source (`SRC`) during planning and re-verified by the plan critique; §8 records the live probes (P7, P8).

- **Attach keeps the window** (high). Attach and detach reload no plugin and keep the same window, so a mounted section and the plugin's in-memory state survive. Both fire `authority_changed` with `{label:"Container:<id>"}` on attach and `{label:""}` on detach.
  - `SRC/fresh-editor/src/app/editor_accessors.rs:464-472,492-518,668-683`, `SRC/fresh-editor/src/app/window_actions.rs:97-133`; `DTS:8238-8246`, `DTS:8903`.
- **The filesystem stays on the host** (high from code). A container authority's filesystem can only be `Local`. `getCwd`, `fileExists`, `openFile` and the host's `.git/index` poll all use **host** paths. Fresh assumes a bind mount: "containers bind-mount, so paths coincide".
  - `DTS:3074-3085`, `SRC/fresh-editor/src/services/authority/mod.rs:232-240`, `docs/internal/remote-authority-trust.md:152,222`.
  - The user docs say otherwise (`docs/features/devcontainer.md:28`), so P8 settles it live.
- **`runOnTarget` in a container probably breaks** (medium-high). It passes `cwd` verbatim to `docker exec -w`, so every built-in git tool sends the container a host path that probably does not exist there (`SRC/fresh-editor/src/services/authority/docker_spawner.rs:107-113`). A probable upstream bug. `kill()` is a no-op for that spawner (`SRC/fresh-editor/src/services/remote/spawner.rs:192`).
- **`spawnHostProcess(cmd, args, cwd)` always runs on the host** (high), returning `{stdout, stderr, exit_code}` (note: `exit_code`, not `code`). It is gated only by workspace trust; a bare `git` is allowed under Restricted.
  - `DTS:8222-8232`, `DTS:3708-3723`; `SRC/fresh-editor/src/app/plugin_dispatch.rs:3823-3870`.
- **Consequence for the plugin.** For a bind-mounted workspace, run git on the host with the host root as cwd (`spawnHostProcess`). For a volume workspace, the host folder's status is not the container's; detect it with host-side `docker inspect <id> --format '{{json .Mounts}}'` and follow P8.

## 8. Probe results

Run on 2026-11-23 against Fresh 0.5.9, git 2.50.1, Node 24.18.0, colima (Docker 28.5.0). Live probes used a throwaway plugin (`/tmp/gs-live/probe/gs_probe.ts`, not in the repo) under an isolated home (`HOME=/tmp/gs-live/home`), launched as a tmux pane command with `FRESH_SESSION` unset. Mouse input was sent as SGR escapes through `tmux send-keys -l`.

| Probe | Result | Evidence |
|---|---|---|
| P0a | **Pass.** `node --test tests/*.test.ts` type-strips tests that import `../lib/*.ts` with a nearest `package.json` of `"type":"plugin"`. Node prints one `MODULE_TYPELESS_PACKAGE_JSON` "Reparsing as ES module" warning per file; tests run and pass. | Node 24.18.0, `/tmp/gs-live/p0` scratch package. |
| P0b | **Pass.** `fresh --check-plugin` bundles `./lib/x.ts` imports, including a lib importing another lib. `import type` / inline `type` specifiers become harmless `const {T} = __mod_…` destructures (undefined at runtime). | Bundled output printed by `fresh --check-plugin p0.ts`, exit 0. |
| P0c | **Pass.** In a tmux pane with `env -u FRESH_SESSION HOME=/tmp/gs-live/home`, `fresh --cmd config paths` lists only `/tmp/gs-live/home/...` paths (config, data, logs); `devcontainer`, `docker`, `git` resolve; `docker context` is `colima`. | `/tmp/gs-live/p0c.txt`. |
| P1 | **Pass.** `closable:false` draws the header as `├ ▼ Probe · A────┤` with no `×` (the explorer header keeps its `⟳─×`). | `capture-pane`. |
| P2 | **Hint lost with a delayed mount → fallback taken.** Same-id remount with a new title keeps the section's height, position and collapsed state (`├ ▶ Probe · B3` → `├ ▶ Probe · B4`, same row). Across a restart, the collapsed state survives either way, but the dragged divider does not survive when the mount happens after an awaited `rev-parse` (~60 ms after load): with the same saved state (`explorer rows 15, panel rows 14`) a synchronous mount at load put the header at row 18 (as dragged), the delayed mount at row 29 (the panel's own 14 rows, explorer the rest). So the plugin mounts synchronously at load after a `fileExists(.git)` walk-up and unmounts only if git then fails (the plan's named fallback). | Workspace file `sections[]` and `capture-pane` row numbers, A/B on one saved state. |
| P3 | **Pass.** With the explorer hidden at start, a synchronous `startBlurred:true` mount leaves it hidden; Ctrl+B shows the explorer with the section below it. A blurred remount (new title) and an `updateFloatingWidget` while hidden also leave it hidden. | `capture-pane`. |
| P5 | Event shapes with `toggleOnClick:true` (below). A double-click on a **group** row yields exactly one `expand` and no `activate` (`activate_on_double_click` ignores non-`select` hits, `SRC/fresh-editor/src/app/widget_runtime.rs:101-125`), so there is no echo to drop: the 400 ms filter is not needed. A double-click on a **file** row sent as SGR escapes produced no `activate` (only the first click's `select`); not reproducible through the harness, so it stays a manual check. | Probe event log. |
| P6 | **Pass.** Segments with `fg:"ui.file_status_*_fg"` render in theme colours and follow "Select Theme" with no reload: high-contrast M `255;255;0`, A `0;255;0`, D `255;0;0`; after switching to gruvbox M `250;189;47`, A `184;187;38`, D `251;73;52`, U `146;131;116`, dir (`editor.line_number_fg`) `146;131;116` — exactly the gruvbox theme values. | `capture-pane -e`, `fresh-editor-core/themes/gruvbox.json`. |

**P5 event shapes** (tree key `t`; `focus`/`blur` also arrive when the section gains or loses the keyboard):

| Input | On a group row | On a file row |
|---|---|---|
| Click (row body) | `expand {index, key, expanded}`; no `select` | `select {index, key, col, row, via:"click"}` |
| Click on the disclosure column of a *selected* group | nothing (the column draws the selection bar `▌`) | — |
| Double-click | one `expand` | `select` only (see above) |
| Enter | `activate {index, key}` (no toggle) | `activate {index, key}` |
| Space | `activate {index, key, via:"space"}` | `activate {index, key, via:"space"}` |
| Right / Left | `expand {index, key, expanded}` | Right: nothing; Left: `select` of the parent group |
| Down past the last row | `select` with the same index | — |
| Esc | `blur` | `blur` |

Other findings:

- `writeFile` refuses an existing path in 0.5.9 (`quickjs_backend.rs:3218-3226`); `replaceFile` overwrites. The plugin writes no files.
- The default log filter writes `DEBUG` lines to `~/.local/state/fresh/logs/fresh-<pid>.log`; `warnings-<pid>.log` holds WARN and above.
- Ctrl+P opens the palette in command mode (`>` prefilled).

### P7: bind-mounted dev container

Fixture `fixture.sh b --devcontainer mcr.microsoft.com/devcontainers/base:debian`, `devcontainer up` (container `6516756aef93`, `remoteUser` `vscode`, `remoteWorkspaceFolder` `/workspaces/b`), then Fresh's "Reopen in Container" popup (the "Dev Container: Attach" flow). Workspace trust left at **Restricted**.

| # | Check | Result |
|---|---|---|
| 1 | `devcontainer up` and attach succeed | **Pass.** Status bar `Container:6516756aef93`, explorer header `[Container]`. |
| 2 | A file written in the container appears on the host | **Pass.** `docker exec -u vscode … sh -c 'echo fromc > /workspaces/b/from-container.txt'` → host file with that content. |
| 3 | No plugin reload; `authority_changed` fires | **Pass.** Same probe instance id before and after; `authority_changed {"label":"Container:6516756aef93"}` on attach, `{"label":""}` on detach. The section stayed mounted at the same row. |
| 4 | `getCwd()` is a host path | **Pass.** `/Users/eugenes/.cache/gs-live/b` while attached. |
| 5 | `spawnHostProcess("git", statusArgs, hostRoot)` | **Pass.** `exit_code 0` in 66 ms, full porcelain output; result keys `stdout,stderr,exit_code`. Allowed under Restricted. |
| 6 | In-container `git status` with the `safe.directory` post-create | **Pass.** As `vscode` in `/workspaces/b`: `MM a.ts`, ` M b.md`, … ; `safe.directory` = `*`. |
| 7 | `runOnTarget("git", …, hostCwd)` fails | **Confirmed.** `code 127` after 154 ms; the error is in **stdout**, stderr empty: `OCI runtime exec failed: exec failed: unable to start container process: chdir to cwd ("/Users/eugenes/.cache/gs-live/b") set in config.json failed: no such file or directory: unknown`. `runOnTarget("pwd", [], hostCwd)` fails the same way; `runOnTarget("ls", ["-la","/workspaces"], "")` works. So every built-in git plugin that passes `getCwd()` as cwd breaks while attached (upstream issue candidate). |
| 8 | Collapsed state survives attach and detach | **Pass.** Collapsed `├ ▶` at row 43 stayed collapsed and in place across detach and a re-attach. |

`docker inspect 6516756aef93 --format '{{json .Mounts}}'` (host) → `[{"Type":"bind","Source":"/Users/eugenes/.cache/gs-live/b","Destination":"/workspaces/b",…}]`: on colima, `Source` is the host path exactly as given, so no `realpath` fallback is needed.

Other observations (Fresh's devcontainer plugin, not this plugin):
- Attach writes `.fresh-cache/devcontainer-logs/build-<ts>.log` into the workspace and tries to write `.fresh-cache/.gitignore` with `writeFile`, which did not land, so `git status` shows the log as untracked. The live fixtures commit a `.fresh-cache/` ignore line so A13's rows can match A4.
- "Dev Container: Detach" runs `docker stop` on the container (`Exited (0)`), and then shows a "Dev Container Attach Failed: attach did not complete" popup although detaching worked.

### P8: workspace in a container volume

Fixture `fixture.sh v --volume` (host folder is the acceptance repo with its own changes), `devcontainer up` (container `88d99bb42e11`, volume `gs-vol` at `/workspaces/gs`), then `echo "volume only" > /workspaces/gs/only-in-volume.txt` inside the container, then attach.

| # | Check | Result |
|---|---|---|
| 1 | `docker inspect` mounts | **Volume only.** `[{"Type":"volume","Name":"gs-vol","Source":"/var/lib/docker/volumes/gs-vol/_data","Destination":"/workspaces/gs",…}]`; no bind covers the host root. |
| 2 | Explorer lists the volume or the host folder? | **Host folder.** `[Container]` explorer shows `new/`, `a.ts M`, `b.md M`, `moved.ts`; `only-in-volume.txt` is absent. `getCwd()` stays the host path. |
| 3 | Can `openFile` open a volume-only file? | **No.** `fileExists` is false and `readFile` undefined for both `<host root>/only-in-volume.txt` and `/workspaces/gs/only-in-volume.txt`; `openFile("/workspaces/gs/only-in-volume.txt")` returns `true` but opens an **empty new buffer**, not the file's content. |

**Decision (per the plan):** Fresh cannot open files that exist only in the volume, so in volume mode the plugin runs no git and shows the single notice row. No stop.

### Found during live acceptance (S11)

- **A click on the already-selected group row does nothing.** With `toggleOnClick:true`, a row-body click toggles a group only when that click also moves the selection onto it. Clicking the selected group row again emits no `widget_event` at all and does not toggle (probe log: `expand {"index":2,"key":"g:c","expanded":false}` for the first click on `Changes`, nothing for the second; `focus` only, for a first click that lands on the selected row while the section is blurred). The disclosure column of a selected row draws the selection bar `▌`, so there is no glyph to click either. Keyboard Left/Right/Enter/Space always work. Host behaviour in 0.5.9; the plugin receives nothing to act on. Cause and fix: P21.

### P9–P13: diff, menu, palette and staging edges (2026-11-24)

Same harness as above: a throwaway probe package (`/tmp/gs-probe/gs-probe/gs_probe.ts`, not in the repo) symlinked into `HOME=/tmp/gs-live/home`, Fresh 0.5.9 in a tmux pane on `GS_LIVE_BASE=/tmp/gs-live/fix tests/live/fixture.sh acceptance`, mouse as SGR escapes. The probe mounts a section with the plugin's real options (`closable:false`, `startBlurred:true`, `scope:{window}`): a group `g:a` and leaves `f:one` (`action:"+"`), `f:two` (`action:"−"`), `f:three`. It logs every `widget_event` and `buffer_closed` with `getActiveSplitId()` and `listBuffers()`. A click or Enter on a leaf builds the git-review style view: two hidden read-only virtual buffers, `computeLineDiff`, `createCompositeBuffer` (mode from `defineMode(…, [], true)`), `showBuffer`, then closes the previous view.

**P9: diff from a focused section.**

| # | Check | Result |
|---|---|---|
| a | Which split gets the tab | **Pass.** Two splits (0 left, 3 right, via `splitWindow`), focus in the right one, then a click on `f:one`: `focus {previous:"(re-focus)"}`, `select {index:1, key:"f:one", col:5, row:24, via:"click"}`. `getActiveSplitId()` was 3 before and after; the diff tab opened in split 3. |
| b | Focus after `showBuffer` | **Pass.** Down then logged `select {index:2, key:"f:two"}` on the section, so focus stayed in it. No `"focus"` call needed. |
| c | A replace keeps the tab count | **Fail as planned, pass with `closeBuffer` on the composite.** Enter on `f:two` built a second view (`activate` with no `via`). `closeCompositeBuffer(5)` plus `closeBuffer(src, true)` for both sources fired `buffer_closed` for the two sources only. Buffer 5 stayed in `listBuffers()` (name `""`, not virtual) and in the split's tabs as `[No Name] 2`: one tab more. The host's `close_composite_buffer` only drops the composite's state and metadata, not the buffer (`SRC/fresh-editor/src/app/composite_buffer_actions.rs:217-222`). Re-run with `closeBuffer(5, true)` after `closeCompositeBuffer(5)`: `buffer_closed` for 5 and both sources, the same three tabs, and the same buffer count as after the first view. |
| d | A user close leaves nothing | **Pass for the user close.** A click on the tab's `×` fired `buffer_closed` for the composite. After `closeBuffer(src, true)` for both sources (each fired `buffer_closed`), `listBuffers()` was `[Welcome, [No Name]]`, the list before the first click. In the run without the (c) fix, the stray buffer 5 from the replace was still listed. |
| e | A re-click on the selected file row | **Fail.** With the section blurred, a click on the selected `f:two` gave `focus` only. With it focused, it gave no event at all. Same as S11 for group rows. Cause and fix: P21. |

**P10: anchored menu from the section. Pass.**

- **Right-click.** A right-click on `f:one` (SGR cell 8,25) gave `context {index:1, key:"f:one", col:7, row:24}`, 0-based screen cells. The selection stayed on `f:two`.
- **Mount.** `mountFloatingWidget(2, col(3 bare buttons), 30, 20, false, false, "", false, false, "", "left")` and `floatingPanelControl(2, "anchor", (24+1)*65536 + 7)` both returned true. The popup's frame was drawn with its top-left corner at column 7, row 25, right under the pointer.
- **Esc.** `cancel` on panel 2 (`widget_key` `m:diff`), nothing on panel 1. Down then logged a panel 1 `select`.
- **A click outside** (an empty row of the section). `cancel` on panel 2; Down then logged a panel 1 `select`.
- **A choice.** Down then Enter gave panel 2 `focus {previous:"m:diff"}` and `activate` with `widget_key` `m:file`, payload `{}`. A mouse click on an item gave `activate` with `widget_key` `m:stage`, payload `{via:"click"}`. After `unmountFloatingWidget(2)`, Up/Down logged panel 1 `select`.
- **The section.** Its header row, title and collapsed state did not change. Focus came back without a `"focus"` call.

**P11: palette. Pass.** `registerCommand("Probe Zeta: Show Sel", "probe", "gsProbeShowSel", "gs-probe-rows")` with `setContext("gs-probe-rows", true)`: listed under Ctrl+P. Run with `f:two` selected, its handler logged `selectedKey=f:two`. After `setContext(…, false)` it was no longer listed; the context-free commands still were.

**P12: real double-click.** Not run: it needs a real mouse (manual, by the user).

**P13: git edges** (scratch repos under `/tmp/gs-p13.*`, git 2.50.1; what it means for staging is in §9.5).

| # | Command | Result |
|---|---|---|
| i | `git --literal-pathspecs reset -q -- s.txt` during a merge, with `s.txt` staged and an unrelated `UU uu.txt` | rc 0, stderr `uu.txt: needs merge`. `s.txt` unstaged (` M`), `UU` kept, `MERGE_HEAD` kept |
| ii | `git --literal-pathspecs add -A -- d.txt`, `d.txt` tracked and deleted | rc 0, `D  d.txt` |
| iii | `git --literal-pathspecs add -A -- vanished.txt u.txt`, with `vanished.txt` absent | rc 128, `fatal: pathspec 'vanished.txt' did not match any files`, and **nothing is staged**: `u.txt` stays `??`. Plain `add --` behaves the same |
| iv | `git --no-optional-locks cat-file -s HEAD:absent.txt` | rc 128, `fatal: path 'absent.txt' does not exist in 'HEAD'` |
| v | `cat-file -s :0:ita.txt` and `cat-file blob :0:ita.txt` for an intent-to-add path | rc 0, size `0`, empty blob |
| vi | the (i) argv during a conflicted cherry-pick, a revert and a rebase stop | rc 0 with `uu.txt: needs merge` in each. `CHERRY_PICK_HEAD`, `REVERT_HEAD` and `.git/rebase-merge` stay, and `UU` stays |

### Found during the live checks of R14–R18 (2026-11-24)

The plugin itself, installed in the same isolated home, on the acceptance fixture and on scratch repositories with a merge in progress, a PNG, `a*` and `ab` on an unborn branch, and a held `.git/index.lock`.

- **`hunks: null` draws nothing.** A composite created with `hunks: null` showed both pane headers and no lines, for an `R100` rename whose two sides are equal. Without hunks the host sets no line alignment (`SRC/fresh-editor/src/app/composite_buffer_actions.rs:1190-1231`). An empty list aligns the equal lines. git-review passes `null`, so it has the same problem.
- **`readFile` gives `undefined` for a file that is not UTF-8**, a PNG here, although the DTS says `string | null`. P8 saw the same for a missing file.
- **No `TextEncoder`.** The plugin runtime has no `TextEncoder` (`ReferenceError` at load), although `tsc` accepts it through `@types/node`. UTF-8 lengths are counted by hand.
- **A synchronous throw in an `async` function** that the caller awaits inside `try` still logs `ERROR … Unhandled Promise rejection` from QuickJS before the `catch` runs. The plugin kept working afterwards (a later Space still staged).

### P14–P20: review fixes (2026-11-24)

Run for the code review's fixes, cited as F0–F14 in the code's comments. Git probes in scratch repos under `/tmp/gs-rev-f1.*` (git 2.50.1, script `/tmp/gs-rev/probe/f1.sh`, not in the repo). Live probes used the same kind of harness as P9–P13 with its own isolated home (`HOME=/tmp/gs-rev/home`, tmux sessions `gsrev-f5` and `gsrev-acc`, both killed afterwards) and a throwaway package `/tmp/gs-rev/probe-pkg/gs_rev_probe.ts` that logs `GSREV` lines (log `fresh-25458.log`). The live repository `/tmp/gs-rev/f5repo` has a Latin-1 blob `latin1.txt` (`caf\xe9\n`, 5 bytes), a UTF-8 file `utf8.txt` (`naïve → 😀`, 23 bytes), `plain.txt`, and an index-only path `bad\xff.txt` (APFS refuses that name on disk, so it shows as ` D`).

**P14: staging a deletion with `rm --cached` (F1).** Every command is `git --literal-pathspecs rm --cached -q -- <p>`.

| # | State | Result |
|---|---|---|
| a | ` D f` | rc 0, `D  f` |
| b | `AD n` | rc 0, nothing left for `n` (it was never in HEAD) |
| c | `MD f` | rc 0, `D  f` |
| d | ` D foo`, with `foo/` now a directory holding untracked `foo/x` and a nested repository `foo/sub` (status v2: `1 .D … foo`, `? foo/sub/`, `? foo/x`) | rc 0, `D  foo`, `?? foo/sub/`, `?? foo/x`; the index holds only the other files, and a tar of `foo/` is byte-identical before and after. The same state with `add -- foo` (the old command): rc 0, `D  foo`, `A  foo/sub` as a 160000 gitlink ("adding embedded git repository"), `A  foo/x` |
| d′ | (d) without the nested repository, `update-index --remove -- foo` | rc 0, `D  foo`, `?? foo/x`. Not needed then; adopted later, because `rm --cached` drops a restored file's entry too (P23) |
| e | Stage all on (d) without the nested repository | `rm --cached -- foo` then `add -A -- foo/x`: both rc 0, `D  foo`, `A  foo/x`. The other order: `add -A -- foo/x` rc 0 (it replaces `foo` in the index), then `rm --cached -- foo` rc 128, `fatal: not removing 'foo' recursively without -r`. So deletions run first |
| f | ` D a*` and ` D ab` | rc 0, `D  a*`; ` D ab` unchanged |
| g | `p` already removed from the index, ` D q` | rc 128, `fatal: pathspec 'p' did not match any files`, and `q` is not staged either (as P13 iii for `add`) |
| h | Unborn branch, `AD p` | rc 0, nothing left |
| i | Intent-to-add path deleted | rc 0, nothing left |
| j | Staged `D foo` and staged `A foo/bar`, then `reset -q -- foo` | rc 0, ` D foo`, `?? foo/bar`: unstaging `foo` also unstaged `foo/bar`, because the index cannot hold both |

**P15: unstaging a copy (F2).** `C  orig.txt -> copy.txt` with `M  orig.txt` (status with `status.renames=copies`), then `git --literal-pathspecs reset -q -- copy.txt`: rc 0, `M  orig.txt` and `?? copy.txt`. The source keeps its own staged change.

**P16: what `kill()` does (F0).** From the source:
- **`runOnTarget`.** `kill()` calls `_killHostProcess(callbackId)` (`SRC/fresh-plugin-runtime/src/backend/quickjs_backend.rs:10658-10669`). That sends `KillHostProcess`, whose handler fires the run's oneshot (`SRC/fresh-editor/src/app/plugin_dispatch.rs:5353-5366`; registered in `SRC/fresh-editor/src/app/plugin_commands.rs:3776-3780`). The local spawner's `spawn_cancellable` then calls `child.start_kill()` (`SRC/fresh-editor/src/services/remote/spawner.rs:354-367`). The docker spawner keeps the default `spawn_cancellable`, which ignores the kill (`spawner.rs:186-199`), so in a container the run goes on (§7).
- **`spawnHostProcess`.** Its wrapper's `kill()` calls `_killHostProcess` too (`quickjs_backend.rs:10574-10607`), and the spawn task's `select!` calls `child.start_kill()` (`plugin_dispatch.rs:3933-3945`).
- **`start_kill()` is a SIGKILL on Unix** (`plugin_dispatch.rs:7792-7794`, the test of that path).
- **Live.** `sh -c "trap '' TERM INT HUP; sleep 3; echo survived > <mark>"`, killed after 500 ms. Both `runOnTarget` and `spawnHostProcess`: `kill()` true, settled with code -1, and no mark after 4.5 s. A signal the script ignores would have let it write the mark.

A git write killed this way cannot remove `.git/index.lock`, so every later write fails until someone deletes it. Writes are therefore never killed (§9.5).

**P17: stdout that is not UTF-8 (F5, F6).** Live, the same command through both runners:

| Command | `runOnTarget` | `spawnHostProcess` |
|---|---|---|
| `cat-file -s :0:latin1.txt` | `5` | `5` |
| `cat-file blob :0:latin1.txt` | rc 0, `caf\uFFFD\n` (lossy) | rc 0, `""` |
| `cat-file blob :0:utf8.txt` (23 bytes) | the text, 18 UTF-16 units, 23 UTF-8 bytes | the same |
| `status --porcelain=v2 -z …` with `bad\xff.txt` in the index | rc 0, the full output, the path as `bad\uFFFD.txt` | rc 0, `""`: the whole status |

The source agrees. The local spawner decodes stdout with `String::from_utf8_lossy` (`SRC/fresh-editor/src/services/remote/spawner.rs:380-384`). The host spawn reads it with tokio's `read_to_string`, which leaves the string empty on invalid UTF-8, and the error is ignored (`plugin_dispatch.rs:3915-3921`). So a blob side is binary unless its text is exactly `cat-file -s` bytes of UTF-8. And a status path with U+FFFD names no file git knows: per P13 iii, one such path fails a whole `add` with rc 128.

**P18: the line diff and one text per side (F3).**
- **`computeLineDiff`.** It keeps each line's `\n` as part of the token, and a final unterminated segment is a line. So a change to the final newline alone is a hunk, and the hunk indices are those of the text split on `\n` with a trailing empty segment dropped (`SRC/fresh-core/src/diff.rs:36-55`).
- **git-review** passes the same text to its buffer entry and to `computeLineDiff` (`GR:443-479`). It first appends a final newline to a text that lacks one (`normalizedContent`, `GR:389-392`), which would make `a` and `a\n` equal.
- **audit_mode** builds the buffer with `contentToEntries(content)` from the file's own text (`EP/audit_mode.ts:5304-5311`, `8165-8166`).
- **The plugin** passes each side's text, as read, to `computeLineDiff`, and the same text through `contentToEntries` (one final newline dropped) to its buffer. Stripping before both, as before, lost the change: `a\n` vs `a\n\n` showed one line on each side, and `a` vs `a\n` was an empty diff.

**P19: composite state (F9).** `close_composite_buffer` is the only place that removes an entry from `composite_buffers` in `SRC/fresh-editor/src/` (`app/composite_buffer_actions.rs:217-222`). Closing the composite's buffer does not remove it. git-review's `buffer_closed` handler calls `closeDiff`, which calls `closeCompositeBuffer` and then closes both sources (`GR:218-229`, `741-751`). The plugin now does the same on a user close, and when a source closes first.

**P20: symbolic links in status (F7).** Recorded in `tests/fixtures/symlink.z`:
- a tracked link retargeted: `1 .M N... 120000 120000 120000 …`;
- a file replaced by a link: `1 .T N... 100644 100644 120000 …`;
- a staged retarget: `1 M. N... 120000 120000 120000 …`;
- a file replaced by a link and staged: `1 T. N... 100644 120000 120000 …`;
- an untracked link: `? new-link`, with no mode.

`mW`, the sixth field (the seventh of a `u` record), is the working-tree mode. `fileStat` and `readFile` follow links, and the DTS has no `lstat` or `readlink`, so for a link the working-tree side would be the target's contents.

**Live check of the fixes** (`GS_LIVE_BASE=/tmp/gs-rev/fix tests/live/fixture.sh acceptance`, and `/tmp/gs-rev/f5repo`, with the plugin installed from the checkout):
- **Diffs.** A click on `plain.txt` (`two`→`TWO`) opened the diff with line 2 marked on both sides, with intra-line colours. `utf8.txt` opened with its multi-byte line as is, and `b.md` in the acceptance fixture showed its added line 2 in the add colour. `latin1.txt` gave `latin1.txt is binary; no diff shown`. `bad\uFFFD.txt` had no button, and a click gave the "not valid UTF-8" message.
- **Staging.** `+` on `b.md` gave `M  b.md`; `+` on `new/d.txt` gave `A  new/d.txt`; `+` on `gone.ts` gave `D  gone.ts` (through `rm --cached`); `−` on Staged `a.ts` gave ` M a.ts`, with the working-tree file byte-identical.
- **Closing.** The probe logged `listBuffers()` as `[Welcome, [No Name]]` before the first click. After the diff opened it was those plus the composite and its two sources. A click on the tab's `×` fired `buffer_closed` for the composite, then for both sources, and the list was `[Welcome, [No Name]]` again. No warnings were logged.
- **The selected row.** With the section focused, a press on the row that is already selected (its button, or a right-click on it) reached nothing, like a row-body click there (P9 e). The same press on any other row worked, and Space on the selected row worked. Host behaviour, not the plugin's. Cause and fix: P21.

### P21: presses on the selected row (2026-11-24)

**Cause (high, source and live).** In the plain tree layout, a selected row in a sidebar section is drawn as `stack([piece, row([text("▌")])])` (`SRC/fresh-editor/src/view/shell/widgets.rs:1320-1329`). `piece` carries the row's hits: the body's `select`/`context`, and the `expand` and `action` buttons.
- **The overlay covers the whole row.** `stack()` gives every child the whole rect (`SRC/fresh-ui/src/desc.rs:1332`), so the overlay `row()` spans the full width, not just the `▌` cell. It sets no pointer mode, and the default hit is opaque (`SRC/fresh-ui/src/render/object.rs:269-272`, `hit.rs:510`).
- **The press stops there.** Hit-testing walks children topmost-first and stops at the first opaque hit (`SRC/fresh-ui/src/hit.rs:496-540`). The row's own gestures never run.
- **Where the press goes instead.** It reaches the section's press handler, which answers a left press with section focus only (`SRC/fresh-editor/src/view/shell/sidebar.rs:296-306`). So a blurred section gets `focus` and nothing else; a focused one gets nothing, and a right-click gets nothing either way.
- **The source comment is wrong.** It says "The overlay carries no gesture, so a press on that cell continues to the row's own `select` beneath".
- **Not the cause.** `tree.rs` has no selected-row check, and no double-click or drag logic is involved.
- **Upstream.** Master (`f29630048`) is unchanged. Upstream issue sinelaw/fresh#3828 (open, on 0.5.9) reports the same layer hiding the selected row's expand arrow.

**Real, not the harness.** Each click was a press, a 400 ms hold, the release, then a 1.5 s wait. On the plain tree with the section focused:
- `+` on the selected row: no event. `+` on another row: `action {index:2,key:"f:two",via:"click"}`.
- A right-click on the selected row: no event. A right-click on another row: `context {index:3,…}`.
- A body re-click on the selected row: no event.
- Blurred: `+` on the selected row gave `focus` only. The `▌` stays drawn while blurred.

**Fix: `cardBorders: true` with `itemHeight: 1` (high, source and live).**
- **Why the rows don't change.** The tree picks the card layout on `cardBorders` alone (`widgets.rs:2855`), and that layout adds no `▌` overlay. A row is drawn as a card only when it has continuation lines and the height is above 1 (`SRC/fresh-editor-core/src/widgets/render.rs:2594-2601`, `:2884-2886`), so at height 1 every row is the usual one-line row with its button.
- **Live, focused:** `+` on the selected row gave `action {index:1,key:"f:one",via:"click"}`, a right-click gave `context`, and a body re-click gave `select … via:"click"`.
- **Live, blurred:** `+` gave `focus` then `action`; a right-click gave `focus` then `context`.
- **Keyboard and groups:** Up, Down, Space and Enter work. A click on the selected group row toggles it both ways (S11 fixed).
- **Selection:** `selectedIndex`, `setSelectedIndex` and `expandedKeys` work as before.
- **Cost:**
  - The selected row has the selection band without the `▌`.
  - Outside the dock, the card layout keeps a one-column scrollbar gutter, so the button sits one column further left (`card_width`, `widgets.rs:1458`).
  - The card layout ignores `columns`, which the plugin doesn't use.
  - The type file documents `cardBorders` as acting only when `itemHeight > 1`, so recheck this on each Fresh upgrade.

**Rejected:**
- Clearing the selection after each event (`setSelectedIndex -1`). It works, but no row is ever highlighted, and Enter and Space have nothing to act on.
- Buttons in a column beside the tree. The click moves focus to the button, the tree drops its selection (`tree.rs:67-70`), and the column doesn't follow the tree's scrolling or collapsing.
- The `mouse_click` hook. It fires only for buffer panes (`app/click_handlers.rs:196-217`).
- Other tree options (`toggleOnClick`, `checkable`, `indentCols`). They stay in the plain layout.

Probe: `/tmp/gs-selrow/pkg/gs_selrow.ts` (not in the repo), logs `fresh-56225.log` and `fresh-59752.log` under `/tmp/gs-selrow/home`.

### P22: a diff with an empty side (2026-11-24)

Found in the final live run (`HOME=/tmp/gs-run/home`, `GS_LIVE_BASE=/tmp/gs-run/fix tests/live/fixture.sh acceptance`, the plugin linked from the checkout).

**Symptom (high, live).** While the diff of untracked `new/d.txt` was open, every frame logged `WARN … render_composite: ViewLine missing for composite buffer: pane=0, line=0, pane_data=true` (52 times in a few seconds), and the status bar showed `[⚠ 1]`. The warnings stopped when that view was closed. A deleted file (an empty right side) does the same on pane 1.

**Cause (high, source).** An empty buffer reports `line_count() == 1` (`SRC/fresh-editor/src/app/composite_buffer_actions.rs:1205-1228`) but draws no line. The diff of `""` against `"d\n"` is one pure insertion (`oldCount 0`). After it, `LineAlignment::from_hunks` still adds a row for every old line it hasn't passed, so it adds one for that phantom line 0 (`SRC/fresh-editor-core/src/model/composite_buffer.rs:356-375`). The renderer then finds no line to draw for it (`render_composite.rs:420-485`, whose comment calls this "unreachable in practice"). The bundled audit_mode's `contentToEntries` (`[]` for empty text) is open to the same.

**Rejected:** one empty entry (`[{ text: "" }]`) instead of `[]`. It was probed live and changed nothing: the same warning came back 23 times.

**Fix (high, live).** `compositeHunks` (`lib/diff.ts`): when a side's buffer is empty, pass one hunk whose count on that side is 1, which covers the phantom line, with `ops` listing only the other side's lines (`+`… or `-`…). With `ops` present, the host builds the rows from `ops` alone (`composite_buffer.rs:265-305`), so no row names the empty side's line 0. When both sides are empty, the hunk has `ops: ""`. Live: the diffs of untracked `new/d.txt` and deleted `gone.ts` drew correctly with no phantom gutter line, the log had zero `WARN`/`ERROR` lines, and no `[⚠]` appeared.

**Rest of the final live run** (same build, all pass, zero warnings):
- **Clicks on the selected row:** a click on `b.md` opened `b.md (staged ↔ working tree)` with line 2 marked as added. `+` on the selected `b.md` gave `M  b.md`, and Space on the next selected row gave `D  gone.ts` through `rm --cached`.
- **The menu:** a right-click on the selected row opened the menu at the pointer, and Down, Down, Enter on Stage gave `A  new/c.txt`.
- **Re-clicks:** a click on the selected `d.txt` replaced the diff tab. Two clicks on the Changes group collapsed it and expanded it again.
- **Rename:** `−` on the selected rename gave ` D old.ts` and `?? moved.ts`.
- **Groups:** Unstage All returned everything with the working tree unchanged, and the empty Staged group showed no button. Stage All staged everything again.
- **Closing:** closing the diff tab with `×` closed both sources, and the tab bar went back to `[No Name]` and `Welcome`.

### P23–P24: second code review (2026-11-24)

Git probes in scratch repositories under `/tmp/gs-cr-probe/w` (git 2.50.1, script `/tmp/gs-cr-probe/probe.sh`, not in the repo). The review found that a row read before an outside change, such as a file restored in Fresh's terminal, which raises no `focus_gained`, could make `rm --cached` stage the deletion of a file that exists. It also found that a Changes `.R` passed its deleted original path to `add`.

**P23: staging a deletion with `update-index --remove`.** Every command is `git --literal-pathspecs update-index --remove -- <p>`.

| # | State | Result |
|---|---|---|
| a | ` D foo`, then `git checkout -- foo` before the write (the row is stale) | `rm --cached -q -- foo`: rc 0, `D  foo` and `?? foo`, so the deletion of a file that exists is staged. `update-index --remove -- foo`: rc 0, clean |
| b | ` D foo`, restored with other content | rc 0, `M  foo`: the index takes the working tree's state |
| c | P14 d: `foo` now a directory with untracked `foo/x` and a nested repository `foo/sub` | rc 0, `D  foo`, `?? foo/sub/`, `?? foo/x`; the index holds only the other file |
| d | P14 g: `p` already removed from the index, ` D q` | rc 0, `D  p`, `D  q`, so a repeated write is harmless (`rm --cached`: rc 128, nothing staged) |
| e | `.R bar ← foo` (`bar` intent-to-add), `foo` now a directory with `foo/x` and a nested `foo/sub`; `update-index --remove -- foo`, then `add -- bar` | both rc 0: `R  foo -> bar`, `?? foo/sub/`, `?? foo/x`. The old `add -- bar foo` stages `foo/x` and embeds `foo/sub`, as in P14 d |
| f | P14 e's order: `add -A -- foo/x`, then `update-index --remove -- foo` | rc 128, `error: foo: is a directory - add individual files instead`. Deletions first: both rc 0, `D  foo`, `A  foo/x` |
| g | `AD n` with `MD k`; a deleted intent-to-add path; `AD p` on an unborn branch | rc 0 each, as P14 b, c, h and i |
| h | ` D a*` and ` D ab`, `-- 'a*'` | rc 0, `D  a*`; ` D ab` unchanged |
| i | ` D d/f` where `d` is now a symbolic link to a directory | rc 128, `error: 'd/f' is beyond a symbolic link`, nothing staged. `rm --cached` stages `D  d/f`; `add` fails too (`pathspec 'd/f' is beyond a symbolic link`). The one case that got worse; accepted (spec, decisions) |

**P24: a blob's id.** `git rev-parse :0:<p>` and `HEAD:<p>` print the object id. An intent-to-add path's is the empty blob (`e69de29…`), whose `cat-file -s` is 0. For an absent path, `rev-parse HEAD:absent` is rc 128 with `fatal: path 'absent' does not exist in 'HEAD'`, the same message as `cat-file -s`. `--verify` gives only `fatal: Needed a single revision`, so it is left off. Without it, a worktree file named `HEAD:absent` makes `rev-parse` echo the argument with rc 0, so the output is accepted only if it is an object id. A diff side reads its size and its content by that id: two reads of `:0:<p>` could straddle a write and pair one blob's size with another blob's text, which the size check would call binary.

### P25–P30: UX follow-up probes (2026-11-24)

Fresh 0.5.9, git 2.50.1, through the `run-git-sidebar` driver (isolated `HOME`, tmux session `gs-ux-probe`, `GS_DRIVE_DIR=/tmp/gs-ux-probe/drive`). The probe package (`/tmp/gs-ux-probe/pkg/gs_ux_probe.ts`, not in the repo) is a copy of the plugin with extra logging: every panel 1 `widget_event`, `active_buffer_changed` with `getBufferPath`, `chrome_focus_changed` and `buffer_closed`. Its diff mode is `defineMode(DIFF_MODE, [["Enter", "gsProbe_enter"]], true)`, and the handler logs `getActiveBufferId()` and `getCompositeCursorInfo()`, then calls `openFile(abs, line + 1)`. Palette commands call `floatingPanelControl(1, "focus", 0)`, `editor.prompt`, a naive reveal (`setSelectedIndex` on `active_buffer_changed`), and `openFile` followed by `executeAction("start_merge_conflict")`. The repositories were the acceptance fixture plus `two.txt` (20 lines, with two changed lines, then with lines 10 and 20 deleted), `Makefile`, `x.zzz` and an extensionless `deploy` starting with `#!/bin/bash`, a merge with `UU f.txt` and a staged `s`, and a 1,200-untracked-file repository opened through a symbolic link (`/tmp/gs-ux-probe/biglink → big`).

**P25: the diff's keys. Pass, no fallback.**

| # | Check | Result |
|---|---|---|
| a | `n`/`]`, `p`/`[` with Enter bound in the mode | Cursor lines `[0,0]`, `n` → `[2,2]`, `n` → `[16,16]`, `p` → `[2,2]`, `]` → `[16,16]`, `[` → `[2,2]`. Keys the mode does not bind fall through to the `compositeBuffer` keymap |
| b | `q`, Esc | Each closes the tab; `buffer_closed` fires for the composite and both sources, and `listBuffers()` is back to the list before the diff |
| c | Enter runs the handler | Yes. `getActiveBufferId()` is the composite. `lines` on an added line `[null,1]`, a changed line `[2,2]`, a removed line `[9,null]`, a removed last line `[19,null]`. The blank row the host draws above a hunk, and the pane-label row, resolve to the nearest content row above (`[8,8]`) |
| d | `openFile(abs, n)` from the handler | The file opens in the diff's split (the active one, split 0) at line `n`, the keyboard moves to it (typed text went into `b.md`), and the diff tab stays. Back on the diff tab, `n` still moves to the next change |
| e | Esc in the section | `blur`, then `chrome_focus_changed {region:"editor"}`; the keyboard goes to the active editor buffer |

**P26: syntax colours. Pass.** `capture-pane -e` on both panes: `*Staged:a.ts*` and `*Working tree:a.ts*` draw TypeScript keyword colours (`0;255;255` on `export const`); `*Staged:Makefile*` draws Makefile colours (`255;255;0` on the target and the recipe). `*Staged: Makefile*`, with the space, is plain, as are `*Staged:x.zzz*` and `*Staged:deploy*` (the `#!/bin/bash` script): detection from a virtual buffer's name gets no first line (spec R21).

**P27: Focus. Pass, no `"reveal"` needed.** `floatingPanelControl(1, "focus", 0)` returned true and sent `focus` then `chrome_focus_changed {region:"section", plugin:"<entry stem>", panel_id:1}`; Down then logged a `select`.
- From the palette with the keyboard in a buffer: as above.
- With the explorer column hidden: the column comes back with the section, and the keyboard is in the section.
- With the section collapsed from its header: it is expanded (`├ ▼`), with the keyboard in it.
- From a user key binding: `{"key":"g","modifiers":["ctrl","alt"],"action":"<handler>","when":"global"}` in `config.json`'s `keybindings` runs the handler. Ctrl+Alt+G is unbound in 0.5.9's `default.json` (only Alt+G, Ctrl+G and a prompt Alt+G use `g`), and tmux's `C-M-g` arrives as it. So the README's example key is Ctrl+Alt+G.

**P28: auto-reveal. Pass, no fallback.**
- **a, echo.** `setSelectedIndex` from `active_buffer_changed` sends no `widget_event` back.
- **b, scrolling.** With 1,200 untracked files and the section scrolled to the top, revealing `f00398.txt` (index 400) scrolled the tree so its row is visible (its last row).
- **c, focus signals** (panel 1's `focus`/`blur`, and `chrome_focus_changed`):

  | Change | Panel 1 | `chrome_focus_changed` | Where the keyboard is |
  |---|---|---|---|
  | A click into the editor | `blur` | `editor` | the editor |
  | Alt+Shift+N, explorer → section → editor | `focus`, then `blur` | `section`, then `editor` | as named |
  | Alt+Shift+P | — | `explorer` → `editor` | as named |
  | Right-click menu opens, then Esc | `focus` (if blurred), no `blur` | none for the menu | the section after Esc |
  | Opening the palette from the section | `blur {passed_on:true}` | `editor` | the editor after the palette |
  | A remount (branch switch) while focused | no `blur` | `editor` | the editor |
  | Ctrl+B (hide) while focused | `blur {passed_on:true}` | `editor` | the editor |
  | Collapse from the header while focused | nothing | nothing | the section's header: Up and Down reach neither the tree nor the editor. A later click into the editor gives `blur` and `editor` |

  So hiding the column does send `blur` in 0.5.9, against what an earlier test comment assumed. Collapsing sends neither signal, because the keyboard does not leave the section. Together the two signals catch every change in which the keyboard left.
- **d, order.** A click on a tab while the section is focused gives `blur`, then `active_buffer_changed`, then `chrome_focus_changed {region:"editor"}`. The chrome event comes **after** the buffer change, so the panel's `blur` has to clear the focus flag too.
- **e, paths.** `getCwd()`, `rev-parse --show-toplevel` and `getBufferPath()` all give the resolved form: `/private/tmp/…` on macOS, and `/private/tmp/gs-ux-probe/big/f00398.txt` for a file opened as `/tmp/gs-ux-probe/biglink/f00398.txt` in a workspace started through the link.

**P29: conflicts. Pass; the disabled case needs the `listPlugins` check.**
- `openFile` on the `UU` file (not open before), then `executeAction("start_merge_conflict")` right after it: the merge view (`*OURS*`, `*RESULT*`, `*THEIRS*`) opened on that file, with `Merge: 1 conflicts to resolve (0 auto-resolved)`. No WARN or ERROR line.
- With `"plugins": {"merge_conflict": {"enabled": false}}`: the file opens, but the call logs `ERROR … console.error: [JS] Action start_merge_conflict is not defined as a global function`, and the status bar shows `[⚠ 1]`. `listPlugins()` then has no `merge_conflict` entry at all; with it enabled the entry is `{name:"merge_conflict", enabled:true}`. So the plugin asks `listPlugins()` first (the plan's fallback).

**P30: git and the prompt. Pass, `-m <msg>` kept.**
- `git commit -q -m -x` and `-m '#x'`: rc 0, subjects `-x` and `#x`, nothing on stdout.
- A `pre-commit` hook that prints `nope` and exits 1: rc 1, stdout empty, stderr `nope`.
- An unborn branch: the first commit, rc 0.
- A merge with `UU f` and a staged file: rc 128, `error: Committing is not possible because you have unmerged files.`, `MERGE_HEAD` stays. After resolving and staging: rc 0, two parents, `MERGE_HEAD` gone.
- A held lock: rc 128, `fatal: Unable to create '<root>/.git/index.lock': File exists.`.
- `rev-parse --short HEAD` afterwards prints the new id.
- A hook running `git ls-files -- "*.txt"`: `env= files=t.txt` for a plain commit, and `env=1 files=` with `--literal-pathspecs`.
- `editor.prompt("Commit message: ", "")` from the palette: Esc resolves `null`, Enter resolves the text. Opening the palette from a focused section blurs it (`passed_on:true`), and after the prompt the keyboard is in the editor.

### Found during the live checks of R19–R27 (2026-11-24)

The plugin itself, through the same driver (`GS_DRIVE_DIR=/tmp/gs-ux-probe/live`), on the acceptance fixture and on scratch repositories: hooks that fail and that sleep 70 s, a held lock, an unborn branch, a merge with `UU` and `DU` paths, and the 1,200-file repository.

- **The status bar cuts the diff hint.** At 140 columns with the explorer shown, a message is cut after about 70 characters. The first hint, `diff: n/] next change, p/[ previous, Enter opens the file at this line, q/Esc closes`, lost its `q/Esc`. It is now `n/] next change, p/[ previous, Enter open file, q/Esc close` (59 characters), which shows whole.
- **After Commit… from the menu, the keyboard is in the editor.** The menu closes on the choice and the prompt takes the keyboard. Once the prompt answers, the keyboard goes to the editor, not back to the section, as with the palette (P30). The plugin sends no `"focus"` to bring it back: only Focus does (R22).

Then a verification pass of the staged change, through the driver with its default `GS_DRIVE_DIR`, on the acceptance fixture and a scratch merge with `UU` and `UD` paths, also with merge_conflict disabled:

- **The status bar joins Fresh's message and the plugin's.** It draws Fresh's latest message, then ` | ` and the plugin's last `setStatus`, which stays until the plugin replaces it: `Opened b.md | n/] next change, …` after Enter in a diff, and `Search cancelled. | nothing staged to commit` after Esc at the commit prompt with a file staged, the second half left from an earlier Commit… with nothing staged. So Esc at the prompt now says `commit cancelled` (R26).
- **Less room beside a TypeScript buffer.** With `TypeScript   LSP (off)` at the right, the bar cut the 70-character busy message, `the last commit is still running or being shown; try again in a moment`, after 58 characters. It is now 50.
- **The hint showed where its keys do nothing.** After a click on a row the keyboard is in the section: Enter opened nothing and Down moved the selection, though the hint had just named Enter. It now waits for the keyboard to reach the diff (R20).
- **Auto-reveal traded a selected Staged row for the Changes row.** With `a.ts`'s Staged row selected, Enter in its Staged diff opened `a.ts` and moved the selection to `c:a.ts`, so Space would stage instead of unstage. It now keeps a row of the file that is already selected (R23).
- **A pre-commit hook that runs `git reset -q` makes git record an empty commit** instead of refusing, as a terminal commit does, so the plugin reports a commit.
- **A terminal `git reset` just before the prompt's Enter** made the commit find nothing staged: `could not commit: nothing is staged` in 3 runs, with a hook printing `lint ok`. A first run instead failed with `Unable to create '.git/index.lock': File exists.`, git's reason shown and no lock left behind. What held the lock was not identified.

### P31–P34: one section per window (2026-11-24)

Fresh 0.5.9, launched without `--simple`, so the daemon saves workspaces and restores them on the next launch. It ran in tmux session `gs-mw` under `HOME=/tmp/gs-mw/home` and `XDG_RUNTIME_DIR=/tmp/gs-mw/run`, with the driver's token terminal in `init.ts`. The probe package is `/tmp/gs-mw/probe/mw-probe/mw_probe.ts`, not in the repo.
- It mounts one tree section per window, with the plugin's real options (`closable:false`, `startBlurred:true`, `scope:{window}`).
- The mounts happen at load and in `active_window_changed`, synchronously, for a root with a `.git`.
- Its panel id is `3 + fnv1a(stable_id) % (2^32 − 3)`.
- It logs every window hook, `widget_event` and `chrome_focus_changed`.

The windows held two acceptance fixtures, `/tmp/gs-mw/fix/a` (the launch folder) and `b`. Windows were made with `createWindow`, switched with `setActiveWindow` through `fresh --cmd script run`, and quit with Quit → "Quit and Stop All". Background in §11.

**P31: a section per window. Pass.**

| # | Check | Result |
|---|---|---|
| a | `stable_id` at load | `listWindows()` at load lists only window 1, `{id:1, stable_id:"ws-18eb070c450a98d8-0", root:"/private/tmp/gs-mw/fix/a"}`. The section mounts as panel 1164453195 |
| b | A new window | `createWindow(b)` → `window_created {id:2,…}`. `setActiveWindow(2)` → `active_window_changed {previous_id:1, active_id:2}`; in the handler `activeWindow()` is 2 and `getCwd()` is B's root. Mount of panel 1903869748 scoped to window 2 → `true`. Then `active_buffer_changed {window_id:2, reason:"window"}` and `chrome_focus_changed {window_id:2}` |
| c | Only its own section | B shows `Probe · b` and not A's. Back in A, only `Probe · a` |
| d | `widget_event` | A click in B: `panel 1903869748 window 2 select`. In A: `panel 1164453195 window 1 select`. No WARN or ERROR in the log |
| e | Two windows on one root | Extract Tab to New Workspace on A made window 3, `{root:"/private/tmp/gs-mw/fix/a", label:"a (2)", stable_id:"ws-18eb0740584f6c00-2"}`: `window_created`, then `active_window_changed`, and the probe mounted panel 2569877109 |
| f | Closing a window | `closeWindow(3)` from window 1: `active_buffer_changed {previous.window_id:3}`, then `widget_event panel 2569877109 window 1 cancel {}`, then `window_closed {id:3}`. The `cancel` names the *active* window |

**P32: layout across switches and a restart.**

| # | Check | Result |
|---|---|---|
| a | Drag the divider in B | B's header moved from row 20 to row 12. In A, A's header was at row 12 too. The divider is the explorer's height, and the explorer is one editor-wide section, so **the height is shared by all windows** |
| b | Collapse | Collapsing A's section left B's open, and the other way round: **collapsed state is per window** |
| c | What is saved | Each window's file holds `{"kind":"explorer","scope":"editor","rows":9}` and only its own panel, by id: A `{"id":1164453195,"scope":"window","collapsed":true}`, B `{"id":1903869748,…,"collapsed":false}` |
| d | Relaunch, the launch window | A came back collapsed. The log shows `dropped 1 sidebar placeholder(s) no plugin mounted after restore` about 140 ms before the plugin's load mount: in daemon mode the placeholder expires first, and the layout comes back through the host's hint (§2) |
| e | Relaunch, a window shown later | With B saved collapsed and A open: `loadWorkspaces()`, then `setActiveWindow(B)` → `Materialized window Window-2 from workspace` → the mount from `active_window_changed` → B collapsed, A open. No placeholder dropped: **the mount claimed B's restored placeholder**. Explorer rows 9 in both |

**P33: contexts per window. Pass.** `setContext("mwprobe-a", true)` while A was active. The palette in A listed `MW Probe: In a`, in B it did not, and back in A it did again.

**P34: a parked section. Pass.** While A was active, `updateFloatingWidget(1903869748, …)` on B's section returned `true`. On switching to B it showed the new rows (`b bumped 1`). No WARN or ERROR.

### P35–P38: row cap, diff navigation, graph, push and pull (2026-11-25)

Fresh 0.5.9, git 2.50.1 (Apple Git-155), through the `run-git-sidebar` driver with `GS_DRIVE_DIR`/`GS_DRIVE_SESSION` set per probe (`/tmp/gs-inv-diffnav`, `/tmp/gs-inv-graph`, `/tmp/gs-inv-push`). Probe plugins were loaded with `editor.loadPlugin` from `/tmp/gs-inv-diffnav-probe/gs_nav_probe.ts` and `/tmp/gs-inv-graph-probe/gs_graph_probe.ts`, not from the repo. Background in §12.

**P35: Next/Previous Change in the plugin's diff. Root cause found.**

| # | Check | Result |
|---|---|---|
| a | Palette **Next Change** (diff_nav) in `two.txt (staged ↔ working tree)`, two hunks | Status `No changes`; the cursor stays on Ln 10 |
| b | What diff_nav reads on the active buffer | The active buffer is the composite (id 5). `getViewState(5, "git_gutter_hunks")` and `"live_diff_hunks"` are null; `getBufferSavedDiff(5)` is `{equal:true}`; `getBufferText(5)` is `""` |
| c | The same in Fresh's own Side-by-Side Diff (`*Diff: b.md*`, audit_mode) | Also `No changes`: no Fresh composite feeds diff_nav |
| d | Feeding diff_nav: `setViewState(5, "git_gutter_hunks", [...])` | Returns true, and Next Change still says `No changes`: `getLineStartPosition` is null on a composite |
| e | A palette command calling `editor.compositeNextHunk(getActiveBufferId())`, then `compositePrevHunk` | Inside the handler the active buffer is the composite. The cursor goes `[9,9]` → `[24,24]`, then `[24,24]` → `[2,2]`. `getCompositeCursorInfo()` awaited right after shows the new row. At the last hunk Next does nothing and still returns true |
| f | `executeAction("composite_next_hunk")` from a palette command | Also moves the cursor (`[2,2]` → `[24,24]`): the action uses the active buffer. It relies on an action name, not an API |
| g | Typing `Hunk` in the palette | Nothing: the core's "Next Hunk (Side-by-Side Diff)" actions are not palette commands |

**P36: graph rows in the section tree. Pass.** A tree mounted as the plugin mounts it (`cardBorders: true`, `itemHeight: 1`, `indentCols: 1`), screen captures in `/tmp/gs-inv-graph/shots/`.
- **a, glyphs.** `│ ─ ╮ ╯ ╭ ╰ ├ ┤ ┼ ● ○` each drew one column wide and lined up across 11 lane rows. They are East Asian "ambiguous" width; Fresh counts them as 1.
- **b, columns.** A row's text starts at `depth × indentCols + 2`: the 2 columns are `▶ `/`▼ ` on a node with `hasChildren`, two spaces on a leaf. Depth-1 commit rows with `hasChildren: true` and a depth-1 leaf put their lanes in the same column; a `flush` leaf sits 2 columns left of them.
- **c, nesting.** Group → commit → file (depths 0, 1, 2) drew as a tree.
- **d, lazy children.** Every toggle fires `expand {index, key, expanded}`: a click with `toggleOnClick`, the disclosure glyph, Right/Left. (Enter, listed here at first, does not toggle a row: it sends only `activate`, P39 g.) A node with `hasChildren: true` and no child rows yet shows `▼` over nothing, so children can be pushed after the event.
- **e, styles.** Bold, italic, underline, RGB `fg` and a theme-key `bg` badge drew. There is no dim flag. The selection band repaints `bg` across the row.
- **f, cutting.** A row wider than the section is cut at the display column and ends with `…`; a `[ label ]` button stays pinned at the right edge, and a badge's `bg` is kept up to the `…`. In a 140-column screen the section body was 39 columns.
- **g, colours.** `editor.bracket_rainbow_1` … `_6` resolved to six colours. In the dark theme `_5` and `_6` are both light blue.
- **h, cost.** Plugin-side time per full update (signature JSON, then `updateFloatingWidget`): 1,020 nodes 17 + 7 ms; 3,020 nodes 23 + 18 ms; 6,020 nodes 47 + 36 ms. Down and PageDown felt the same with 3,000 rows as with 20.
- **i, a commit as text.** A virtual buffer named `*<short>:show.diff*` holding `git show --stat --patch` output is coloured as a diff (added lines on the diff-add background, `@@` and `diff --git` lines styled), with the embedded TypeScript coloured too.

**P37: push and pull from a Fresh-spawned process.**

| # | Check | Result |
|---|---|---|
| a | `runOnTarget("git", ["push", "h401", "main"])`, an http remote answering only 401 | `Username for 'http://127.0.0.1:18401':` is drawn over Fresh's screen: the child has no tty on stdout but `/dev/tty` opens (the editor's pane) |
| b | `kill()` after 5 s | Kills `git`, leaves `git-remote-http` orphaned and reading `/dev/tty`; the handle settles only when that orphan is killed by hand (129 s) |
| c | `git -c core.askPass=false ls-remote …` | Still falls back to the terminal: no config key turns the prompt off |
| d | `env GIT_TERMINAL_PROMPT=0 git push h401 main` | rc 128 in 154 ms, `fatal: could not read Username for 'http://127.0.0.1:18401': terminal prompts disabled` |
| e | A closed port, with (d)'s env | rc 128 in 76 ms, `Failed to connect … Couldn't connect to server` |
| f | An unreachable ssh host, `GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=5"` | rc 128 in 5.1 s, `ssh: connect … Operation timed out` / `fatal: Could not read from remote repository.` `-c core.sshCommand=…` behaves the same |
| g | SIGKILL of `git push` while the remote's pre-receive hook sleeps | No `.lock` on either side, but the remote completes the push; the local `origin/main` stays stale |
| h | SIGKILL of `git pull` | Its `git fetch` child is orphaned (ppid 1) and still updates `origin/main`; HEAD is not merged |
| i | After a push, `status --porcelain=v2 --branch` | `# branch.ab +1 -0` → `+0 -0` with no fetch. A new remote commit shows as `-1` only after a fetch |

ssh's own host-key and passphrase prompts read `/dev/tty` too; starting a local sshd to probe them was not allowed, so that `BatchMode=yes` turns them into failures is from ssh's documentation, UNCONFIRMED here. Confirmed later against a local sshd (P39 a).

**P38: git's push and pull outcomes** (rc, then stderr unless noted).

| Case | Result |
|---|---|
| push, no upstream (one or several remotes) | 128, `fatal: The current branch feat has no upstream branch.` and a `--set-upstream origin feat` hint |
| push, no remote; or two remotes, none named `origin` | 128, `fatal: No configured push destination.` |
| push, detached HEAD (also mid-rebase) | 128, `fatal: You are not currently on a branch.` |
| push, upstream name differs (`push.default=simple`) | 128, `fatal: The upstream branch of your current branch does not match the name of your current branch.` |
| push rejected | 1, `! [rejected] main -> main (fetch first)` or `(non-fast-forward)`, then `error: failed to push some refs` |
| nothing to push | 0, `Everything up-to-date` |
| push during a merge | pushes HEAD; MERGE_HEAD is ignored |
| pull, diverged, no `pull.rebase`/`pull.ff` | 128, `fatal: Need to specify how to reconcile divergent branches.`; the fetch has already moved `origin/main` |
| pull `--ff-only`, diverged | 128, `fatal: Not possible to fast-forward, aborting.` |
| pull would overwrite local changes | 1, `error: Your local changes to the following files would be overwritten by merge:` with the files, then `Aborting`. With `--rebase`: 128, `error: cannot pull with rebase: You have unstaged changes.` |
| pull `--autostash` with a conflicting stash | **0**, with `UU f` and the stash left behind (`Applying autostash resulted in conflicts.`) |
| pull with conflicts (merge) | 1, `CONFLICT (content): Merge conflict in f` / `Automatic merge failed` on stdout; MERGE_HEAD, ORIG_HEAD and `UU` rows left |
| pull with conflicts (rebase) | 1, `could not apply …`; `rebase-merge/`, REBASE_HEAD, detached HEAD |
| pull, no upstream (or no remote) | **1**, `There is no tracking information for the current branch.` |
| pull with unmerged files | 128, `error: Pulling is not possible because you have unmerged files.` |
| pull, merge resolved but not committed | 128, `error: You have not concluded your merge (MERGE_HEAD exists).` |
| pull up to date | 0, `Already up to date.` on stdout |

### P39: implementation probes (2026-11-25)

Fresh 0.5.9, git 2.50.1 (Apple Git-155), through the `run-git-sidebar` driver with `GS_DRIVE_DIR=/tmp/gs-impl-drive`, `GS_DRIVE_SESSION=gs-impl-drive`, on the acceptance fixture. The probe plugin `/tmp/gs-impl-probe-plugin/gs_impl_probe.ts` (not in the repo) was loaded with `editor.loadPlugin`: a tree section like the plugin's (`g:g`, depth-1 `h:` rows with `hasChildren`, a depth-2 file row, `more:h`), a right-click menu, a prompt with two suggestions, and a command registered with context `"git-sidebar-diff"`. Plain git ran in `/tmp/gs-impl-p2`. ssh ran against a throwaway `alpine:3` container with OpenSSH (`docker run -p 127.0.0.1:22339:22`), removed afterwards.

| # | Check | Result |
|---|---|---|
| a | ssh prompts with the plugin's env (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, `SSH_ASKPASS=false`, `SSH_ASKPASS_REQUIRE=force`) and `-o BatchMode=yes -o ConnectTimeout=10` appended, through `runOnTarget("env", …)` | **Confirmed.** An unknown host key (an empty `UserKnownHostsFile`): rc 128 in 155 ms, `Host key verification failed.`, and the file stays empty. A passphrase key not in an agent: rc 128 in 96 ms, `Permission denied (publickey,password,keyboard-interactive).` A wrapper script that runs ssh without BatchMode: the passphrase case fails in 444 ms (`Permission denied, please try again.` three times: the askpass `false` answers each prompt), the host-key case in 341 ms (`Host key verification failed.`). Nothing was drawn over Fresh, and no ssh process was left. stderr lines end in `\r` |
| b | The full argv against (a)'s sshd | **Confirmed.** A `core.sshCommand`-style `ssh -i <key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<kh>` with the two options appended pushes (rc 0, `* [new branch] main -> main`). An unreachable host (`ssh://git@10.255.255.1/r.git`): rc 128 after 10.1 s, `ssh: connect to host 10.255.255.1 port 22: Operation timed out` |
| c | `editor.getEnv` against a spawned child's environment | **Confirmed.** In a Fresh started with `GIT_SSH_COMMAND='ssh -o P39=yes'` and `GIT_SSH=/opt/p39/ssh`, `getEnv` returns both, and `env` run through `runOnTarget` and through `spawnHostProcess` prints the same two. `HOME` and `PATH` match too. **An unset variable gives `undefined`, not the declared `null`** |
| d | `GIT_ASKPASS=` with `SSH_ASKPASS` set to a script that records its runs, against an http remote that answers only 401 | **Confirmed.** rc 128 in 179 ms, `could not read Username for 'http://127.0.0.1:18439': terminal prompts disabled`, and the script never ran. Control, without `GIT_ASKPASS=`: git ran the script for the username and the password, then `Authentication failed` |
| e | `%D` of `log --decorate=full --decorate-refs-exclude=refs/remotes/*/HEAD` | **Confirmed.** Attached: `HEAD -> refs/heads/main`; detached: `HEAD, refs/remotes/origin/main`; tags: `tag: refs/tags/v1a, tag: refs/tags/v1` (annotated and lightweight alike); the upstream: `refs/remotes/origin/main`. The exclusion drops `refs/remotes/origin/HEAD`, which plain `--decorate=full` adds. **A shallow clone's boundary commit decorates as `grafted`** (and its `%P` is empty), which is not a ref and must not become a badge |
| f | `show --no-color --format=fuller --stat --patch --diff-merges=first-parent` | **Confirmed.** On a merge: `Merge: <p1> <p2>`, both dates, the message, then the stat and patch of its first-parent diff (the files the merged branch brought). On a root commit: every line added (`--- /dev/null`). `diff-tree -r -z --raw -M <m>^1 <m>` lists the merged files as `A`; `diff-tree --root --no-commit-id -r -z --raw -M <root>` lists the root's |
| g | Enter on a depth-1 `hasChildren` row; `setExpandedKeys` | **Contradicts P36 d's "Enter".** Enter on a commit row sends only `activate {index, key}`: no `expand`, and the host does not toggle the row; on the depth-0 group row the same. Right and Left send `expand` and toggle; Space sends `activate {via:"space"}`. A click on a `hasChildren` row sends only `expand {index, key, expanded}`, no `select`, also on a row not selected before; a click on a leaf (`hf:`, `more:h`) sends `select {via:"click"}`. `setExpandedKeys` sends no `expand` back. So the plugin toggles a commit on Enter itself, as it does a group |
| h | `startPrompt(label, type)` with `setPromptSuggestions` (two suggestions), from the palette and from a right-click menu's button | **Confirmed**, the same from both. On open: `prompt_changed {input:""}`. The first suggestion is highlighted: Enter at once gives `prompt_confirmed {prompt_type, input:"origin", selected_index:0}`; Down then Enter gives `"backup"`, 1. Typed text that matches no suggestion hides the list, and Enter gives `{input:"zzz", selected_index:null}`. Esc gives `prompt_cancelled {input:""}`, and the host shows `Search cancelled.`. Every prompt hook fires for every prompt type: the plugin filters by `prompt_type` |
| i | `compositeNextHunk` on a 200-line diff with changes at lines 20 and 150 | **Confirmed.** From line 30 the cursor goes to 150 (`getCompositeCursorInfo().lines` `[29,29]` → `[149,149]`), and the view scrolls so that `line 150 CHANGED` is on screen. A second call at the last change leaves it there |
| j | `spawnHostProcess("env", ["GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "git", …])` | **Confirmed.** `{exit_code: 0, stdout: "main\n"}`; a child sees the assignments |
| k | Palette listing of a command registered with context `"git-sidebar-diff"` | **Confirmed.** Listed while a section diff is the active tab, with the keyboard in the section or in the diff; not listed with `b.md`'s tab active; not listed in a second window (its own active buffer); listed again back in the first |
| l | `editor.setClipboard("p39-clip-…")`, then Ctrl+V in `[No Name]` | **Confirmed.** The buffer holds the text, and the system clipboard (`pbpaste`) has it too |

### Found during the live checks of R29–R36 (2026-11-25)

Same driver setup, on `tests/live/fixture.sh graph` and `graph-long`.
- **Fresh's bundler cannot load an import cycle.** The first build failed to load with `ReferenceError: __mod_actions_ab62 is not initialized`, while `npm run check` passed. The bundle wraps each module in a function run once, in dependency order, that destructures its imports when it runs (`const {badName} = __mod_actions_…;`), and it counts `import type` as a dependency: `actions → graph → (type) diff → actions` was a cycle. Node runs a cycle and `fresh --check-plugin` only bundles, so `tests/imports.test.ts` now fails on one.
- **A key binding added to `config.json` while Fresh runs takes effect only after `editor.reloadConfig()`** (or a restart). With it, F7 and Shift+F7 bound to `gitSidebar_nextChange` / `gitSidebar_prevChange` moved the diff's cursor as the palette commands do.
- **A section scrolled far down stays scrolled when its list shrinks.** After 1,200 untracked files were deleted with the section scrolled near row 1,000, it showed blank rows until the next key moved the selection. The same happens without the Graph; the plugin pushes the reconciled index, and the host draws it only on the next move.
- **The right-click menu opens above the row when the row is near the screen's bottom**, so the driver's `click … --below <row>` finds no item there.
- The `driver.mjs` `cmd` and `eval` act on the window of the fixture's folder (as SKILL.md warns): a Commit… and Push sent with `cmd` while window B was active ran in window A.

### P40: review-fix probes (2026-11-25)

git 2.50.1 (Apple Git-155) in fresh `/tmp` repositories with `GIT_CONFIG_GLOBAL=/dev/null`, except (c), which needed a gettext build: git 2.56.1 in the `mcr.microsoft.com/devcontainers/base:debian` image (`docker run --rm --network none`, `de_DE.UTF-8` made with `localedef`).

| # | Check | Result |
|---|---|---|
| a | `pull` with the user's autostash config (`pull.rebase=true` + `rebase.autoStash=true`; `merge.autoStash=true`, with and without `pull.ff=only`), a dirty `f.txt` the upstream also changed | Without `--no-autostash`: rc 0, `Created autostash: …` … `Applying autostash resulted in conflicts.`, a `stash@{0}: autostash` left behind and `UU f.txt`. With it, rebase: rc 128, `error: cannot pull with rebase: You have unstaged changes.`; merge: rc 1, `error: Your local changes to the following files would be overwritten by merge:` … `Aborting`. No stash, HEAD unchanged. `--no-autostash` without `--rebase` needs git 2.27: v2.26.0's `builtin/pull.c` dies with `--[no-]autostash option is only valid with --rebase.` |
| b | Revisions without `--` beside a same-named path | `git log … HEAD @{upstream}` with a committed `HEAD` file, an untracked one, an untracked `head` (the filesystem is case-insensitive) or a `HEAD/` directory: rc 128, `fatal: ambiguous argument 'HEAD': both revision and filename`. A top-level file named as a full commit id does the same to `diff-tree`, `show` and `log -1`. With `--` after the revisions, all rc 0 |
| c | A conflicting pull under `LANG=de_DE.UTF-8` | rc 1, `KONFLIKT (Inhalt): Merge-Konflikt in f.txt`, stderr `Von ../o`. With `LC_ALL=C` as well: `CONFLICT (content): Merge conflict in f.txt`, `From ../o`. A hook run by `env LC_ALL=C git commit` sees `LC_ALL=C`. Apple's git ignores `LANG` (no gettext) |
| d | `pull` on a branch only ahead of its upstream | `pull.rebase=true` or `merges`: rc 0, stdout `Current branch main is up to date.`; `pull.rebase=false` or `pull.ff=only`: `Already up to date.` |
| e | `show` of a root commit with `-c log.showRoot=false` | Without `--root`: the header and message only. With `--root`: `a.txt \| 1 +`, `new file mode 100644`, `--- /dev/null`. With `--root --`, a non-root commit, a merge, and a root commit under the default config print the same as without |

Not probed, from the review: in a partial clone, `diff-tree -M` (inexact rename detection reads blobs), `cat-file` of a historical blob and `show --patch` make git fetch the missing objects from the promisor remote. These are plain reads, killed at 10 s and without `remoteEnv`, so a remote that needs credentials can prompt as P37 a describes. git 2.44's `--no-lazy-fetch` / `GIT_NO_LAZY_FETCH=1` would stop the fetch, and the read would fail instead. Left as a documented limit (spec Decisions, README Limits).

### P41: diff placement and change markers (2026-11-25)

Fresh 0.5.9, through the `run-git-sidebar` driver, each probe with its own `GS_DRIVE_DIR`/`GS_DRIVE_SESSION` (`gs-place`, `gs-scroll`, `gs-group`, `gs-gplace`), editor calls through `eval`. The dock was opened with Alt+`` ` `` (a terminal in a new dock leaf). Scrollbar cells were read with `tmux capture-pane -p -e -N`: the driver's `screen --color` drops the last column, because tmux trims trailing cells. Scratch files: `/tmp/gs-place-scratch/`, `/tmp/gs-scroll-scratch/`, `/tmp/gs-group-scratch/`, `/tmp/gs-gplace-scratch/`. §13 draws the conclusions.

| # | Check | Result |
|---|---|---|
| a | A section row click while the dock (split 6) is the active split | **The diff opens in the dock.** Its tabs read `*Terminal 1* ×   b.md (staged ↔ working tree) ×`, and `describeWorkspace` gives `active:6` with pane 6 showing the diff |
| b | A File Explorer click on `a.ts` in the same state | Opens `a.ts (preview)` in the top pane; afterwards `active:0`, and the keyboard stays in the explorer |
| c | `listSplits()` / `describeWorkspace()` with the dock open | **No role field.** Both panes report `kind:"virtual"`, `label:null`, `x:42`, `w:98`; only `y`/`height` differ (1/26 against 28/11) |
| d | With the keyboard in the section and the dock active: a composite made by hand, then `setSplitBuffer(0, comp)`; for View Commit, `createVirtualBuffer({…, background: true})` then `moveBufferToSplit(buf, 0)` | **Both land in pane 0** (side by side for the composite), the active split stays 6, the dock's tabs are untouched, and `keys Down Enter` still act in the section (`focus=Some(#widget_focus:git)` in the log) |
| e | `focusSplit(0)`, `showBuffer`, `focusSplit(6)` | Keeps the section's focus, but promotes the explorer's `a.ts (preview)` tab in pane 0 to a permanent one |
| f | A composite diff of a 300-line file with 5 changes, 140×30: the scrollbar | **Drawn, never marked.** Column 140, rows 2–28: thumb bg `255,255,0`, track bg `80,80,80`; after End the thumb is at rows 26–28. `setScrollbarMarkers` with `[255,0,255]` on the composite (id 5), the left source (3) and the right source (4) each returns `true`, and column 140 stays plain. Control: the same call on the file opened as a tab paints `▌` fg `255,0,255` on the track at rows 15–16, and git_gutter's own marks show there too |
| g | `setLineIndicator`, `addOverlay` (bg) and `addVirtualLine` on a composite's source | Each returns `true`; none is drawn in the composite |
| h | `createBufferGroup` with two scrollable leaves carrying the `bufferId` of hidden, read-only, `editingDisabled` virtual buffers `*Staged:big.ts*` and `*Working tree:big.ts*` | **One tab**, named as given; the sources get no tabs (with `hiddenFromTabs: false` each also gets its own). Both panels show line numbers and TypeScript colours picked from the buffer name. A borrowed buffer keeps its own `mode`; the group's `mode` applies only to panels the group owns (`buffer_groups.rs:150-232`) |
| i | `setScrollbarMarkers` on each panel's buffer, RGB colours, `line`/`endLine` | **Painted** on each panel's own track (left at column 103, right at 159): `220,160,90` at row 3, `80,200,120` at row 9, `220,90,90` at row 31, and an 11-line deletion as a streak over rows 29–31 |
| j | `compareBuffers` on the two virtual buffers; filler `addVirtualLine`s, line and intra-line overlays, `setLineIndicators`, `createScrollSyncGroup` + `setScrollSyncAnchors` | `compareBuffers` resolves with 5 hunks and their spans. A modified line's bg is `60,55,0`, its intra-line span `140,0,0` (left) / `0,110,0` (right); the gutter shows `~`, `+`, `-`; three filler rows face three added lines, and 11 blank rows face the deletion. PageDown and the wheel in either panel keep the sides aligned (51↔54, 211↔203, 269↔261, 175↔178) |
| k | Keys in a panel | With a mode from `defineMode(…, true)` set on the sources, `n`, `p`, `]`, `[`, Enter, `q`, Esc and Tab each reach the plugin's handler. Unbound, `n`, `p`, `q` and Enter only say `Editing disabled in this buffer`, and Esc does nothing: Fresh's `q`/Esc close is bound in the `compositeBuffer` context only. Tab does not switch panels; a click does, and so does `focusBufferGroupPanel`. `setBufferCursor` on both sources plus `scrollToLineCenter(leftSplit, buf, 279)` centres a change. A palette command whose context is the mode name is listed while a panel has the keyboard |
| l | `createBufferGroup` with the keyboard in the section | **No focus steal:** Down still moves the section's selection; `getActiveBufferId()` then gives the left source. The group's tab goes in the active split: with the dock active (split 26), into the dock beside `*Terminal 2*` |
| m | Closing a group: `closeBufferGroup`, the tab's `×`, Alt+W | Each fires only `buffer_group_closed {group_id, window_id}`; both sources stay in `listBuffers()`. `closeBuffer(id, true)` on each then fires `buffer_closed` for each, with no WARN or ERROR. Closing the sources while the group is open closes the group: `buffer_group_closed`, then two `buffer_closed` |
| n | Cursor reads in a group | `getPrimaryCursor()`, `getCursorLine()` and `getCursorPosition()` read the panel with the keyboard (line 202 in buffer 7; line 209 in buffer 6 after a click on the left). `getActiveSplitId()` gives the host split (0), not the panel's |
| o | A second group, then the first closed through its sources | The second stays active, no empty tab is left; its tab is appended at the end of the tab bar, not in the first's place |
| p | A buffer group into a split that is not active (the dock active, the keyboard in the section) | **No call does it.** `create_buffer_group` shows the group in the active split (`app/buffer_groups.rs:186-205`; no dock redirect in `plugin_dispatch.rs:7038-7060`), `inTabOf` acts only on the active split's own tab, and the group's tab is a `TabTarget::Group` with no buffer id: its split drops out of `listSplits()`/`describeWorkspace()`, its panel buffers list `splits: []`, and `moveBufferToSplit` on a panel buffer moved the bare panel and broke the layout. **`focusSplit(target)`, then `createBufferGroup`, not focusing back:** the group opens in the target, beside its `a.ts (preview)` tab, which stays a preview; the dock is untouched; the target stays active, `getActiveBufferId()` is the left panel's buffer, and `active_buffer_changed {reason:"buffer"}` fires once; the keyboard stays in the section. Focusing back to the dock afterwards fires nothing but promotes the target's preview (`focus_split` → `promote_preview_if_not_in_split`, `app/active_focus.rs:240-243`). Closing the group (`closeBufferGroup` or its `×`) gives the split back its previous tab, a preview still a preview, and leaves the dock alone; the borrowed sources stay open (`buffer_groups.rs:648-656`) |
| q | Revealing the row's file in the File Explorer when its diff opens, the keyboard in the section (`src/deep/x.ts` in a collapsed `src/`, and `new/c.txt`) | A plain row click reveals nothing, even with `file_explorer.follow_active_buffer` on: the composite has no path. **In one script: `previewFileInSplit(split, abs)`, `showBuffer(composite)`, `dismissPreview()`, with `follow_active_buffer` on** (set for the call with `setSetting` and set back): `src` expands (drawn compacted as `src/deep`), `x.ts` is selected with the unfocused band, the composite stays the active tab, no preview tab is left, and Up still moves the section's selection. Without `dismissPreview` an `x.ts (preview)` tab stays. The status bar then says `Opened <path>`. A deleted file reveals nothing, keeps the explorer's old selection and logs `WARN … Component 'gone.ts' not found in tree`. With the explorer section collapsed the selection moves and shows once it is expanded |
| r | The same with `executeAction("focus_file_explorer")` instead of the setting | Reveals with the setting off, but the explorer takes the keyboard (`File explorer focused`); `focus_next_sidebar_section` gives it back to the section |

Not probed: a theme key as a marker colour (the code resolves one, `split_rendering/scrollbar.rs:371-386`); a group in several windows (R28); `compareBuffers` with an empty side (P42 b).

### P42: the two-pane diff's build, placement and close (2026-11-25)

Fresh 0.5.9, through the `run-git-sidebar` driver with `GS_DRIVE_DIR=/tmp/gs-p42`, `GS_DRIVE_SESSION=gs-p42`, on the acceptance fixture at 140×40. The probes ran in a helper plugin loaded with `editor.loadPlugin` (`/tmp/gs-p42-scratch/gs_p42_probe.ts`), which runs a script file in its own realm, so handlers and state persist, and logs `active_buffer_changed`, `buffer_closed`, `buffer_group_closed` and `chrome_focus_changed`; the scripts are in `/tmp/gs-p42-scratch/`. Sources: hidden, read-only virtual buffers with one mode, filled with the exact texts. Layout: `{split h .5: {split v: fixed "leftHeader" h1 / scrollable "left"}, {split v: fixed "rightHeader" h1 / scrollable "right"}}`. Decorations as the plan's `paint`: line and span overlays, empty `addVirtualLine` fillers, `setLineIndicators` `-`/`+`, `setScrollbarMarkers` (a range `[from, max(to-1, from)]`, or a point at the seam), `createScrollSyncGroup` on `panelSplits.left/right` with an anchor at each hunk's end.

| # | Check | Result |
|---|---|---|
| a | The layout above, A38's 300-line `long.ts` | **Works.** Both headers are drawn by `setPanelContent` (each followed by a separator row); line numbers, TypeScript colours, `-`/`+` gutters and marks on both tracks; PageDown and the wheel keep the sides paired (211↔203 with eleven blank rows facing the deletion) |
| b | An empty side | `compareBuffers` resolves: empty left → one hunk `left {start 0, count 0, from 0, to 0, jump 0}`, `leftLines 0`; empty right likewise; equal texts → `hunks: []`. A marker at position 0 of an empty buffer draws one cell at the top of its track. **Fillers never render in an empty (zero-byte) buffer**, `above` or not: its pane shows a single empty line `1` and nothing below, no tint. In a non-empty buffer, fillers `above` at byte 0 do render (an add at the top). **With an empty left and the anchor `[0, N]`, the right pane opens scrolled past its last line, blank**, also after `setBufferCursor` on both and `scrollToLineCenter(leftSplit, L, 0)`; a click and Ctrl+Home bring it back. The same group with no anchors (sync group made, `setScrollSyncAnchors` not called), or with no sync group, shows the right side from line 1. An empty right (`[N, 0]`) draws as expected |
| c | `compareBuffers` on the two hidden sources before `createBufferGroup` | Resolves, with the same hunks |
| d | Replacing: the old group in split 0, the dock (terminal, split 62) active, the keyboard in the section (Focus). (i) `focusSplit(0)`, create, close the old sources; (ii) `focusBufferGroupPanel(old, "left")`, create, close the old sources | **Both** put the new group in split 0, leave the dock's terminal tab alone, leave no stray tab, and keep the keyboard in the section (no `chrome_focus_changed`; Down moves the section's selection band). (i) fires `active_buffer_changed` for the **old** group's left source first, then for the new one; (ii) fires it once, for the new left source |
| e | `focusSplit(9999)` + `flush()` | Returns true; `getActiveSplitId()` unchanged; **logs `WARN … Split SplitId(9999) not found`**, which shows a warning count. `listSplits()` is `[]` while the only editor split shows a group (H3) |
| f | `defineMode(mode, [j→scroll_down, k→scroll_up, Escape, BackTab, Tab, q, n, ], p, [, Enter → handlers], true)` on the sources | `j`/`k` scroll both panes one line, the cursor stays (`Ln 20`). Every other key reaches its handler; `getPrimaryCursor()`/`getCursorLine()` read the focused pane. `focusBufferGroupPanel(g, "right")` from the Tab handler moves the keyboard (the next key's active buffer is the right source), and from BackTab back |
| g | A command registered with the mode as its context, the group the active tab, the keyboard in the section | Listed in the palette |
| h | Sources, `compareBuffers`, group, headers, wrap, every decoration, sync and cursors, in one script | 10,000 lines with 500 one-line changes: 353 ms (sources 83, compare 121, group and decorations 64, flush 85). A 5 MiB full rewrite (52,428 changed lines, one hunk): 1.78 s |
| i | Exact texts | `"a\n"→"a\n\n"`: one hunk, right line 2 (`[1,1]`), a blank row faces it on the left. `"a\nb\n"→"a\nb\nc\n"`: only line 3. `"a"→"a\n"`: one `eolOnly` hunk on line 1, `spans: [null]`. Each pane draws its empty last line (`2 │`, `4 │`); no WARN or ERROR |
| j | `closeBuffer(left, true)` alone, the group open | `buffer_closed` (both headers), **`buffer_group_closed`, with `getBufferInfo(left)` already null and `getBufferInfo(right)` not null**, then `buffer_closed` (left). The right source stays open until closed |
| k | `focusSplit(0)` (showing `a.ts`) then `createBufferGroup` with no `flush` between, the dock active, the keyboard in the section | One `active_buffer_changed`, for the new left source; none for `a.ts` |
| l | A one-panel group (after GATE C): `{split v: fixed "header" h1 / scrollable "<side>" bufferId S}`, S a hidden read-only source with the mode, no decorations, no sync group | **Works.** The header is drawn; with `setLineWrap(S, panelSplits.<side>, false)` a 300-column line is not wrapped. `j`/`k` scroll the pane, the cursor stays; Tab, BackTab and `n` reach their handlers. `closeBuffer(S)` from the `q` handler: `buffer_closed` (header), `buffer_group_closed` (`getBufferInfo(S)` already null), `buffer_closed` (S), and `listBuffers()` is as before. The tab's `×`: `buffer_closed` (header) and `buffer_group_closed` only, S still open until closed. Replacing from the dock with the keyboard in the section, by `focusBufferGroupPanel(old, <its side>)`, create, close the old sources: one-pane → two-pane and two-pane → one-pane each land in split 0, fire one `active_buffer_changed` (the new view's first source), leave the dock alone and the keyboard in the section (Down moves the selection band). No WARN or ERROR |

### P43: review-fix probes, the Graph's reads (2026-11-26)

git 2.50.1 (Apple Git-155) in a fresh `/tmp` repository with `GIT_CONFIG_GLOBAL=/dev/null`; git 2.30.2 in the `buildpack-deps:bullseye-scm` image (`docker run --rm`), and older git from its source at the release tags. (c) is Fresh 0.5.9 through the `run-git-sidebar` driver on the `graph` fixture at 140×40, the explorer shown.

| # | Check | Result |
|---|---|---|
| a | `log --topo-order -z --decorate=full --format=%H%x00%P%x00%D%x00%an%x00%s HEAD --`, one subject `fix<US>thing<RS>x` (bytes 0x1F, 0x1E) | Each commit is five fields, each ended by a NUL, the last too; the subject comes out with both bytes as they are, so the old `%x1f`/`%x1e` format split it into six fields and lost the commit. `tests/fixtures/record.sh` re-recorded with this argv gives the old log fixtures byte for byte, with only the separators changed |
| b | `show --format=fuller --stat --patch --first-parent --root <id> --` against the same with `--diff-merges=first-parent`, on a merge and a root commit, and with `-c log.diffMerges=combined` | Byte-identical; re-recorded `show-*.txt` unchanged. git 2.30.2 has `--diff-merges` but not its `first-parent` value: rc 128, `fatal: unknown value for --diff-merges: first-parent`; with `--first-parent` it prints the merge's first-parent diff, and (a)'s log and `log -1 … HEAD --` beside a `HEAD` file work too. In v2.27.0 and v2.30.0, `builtin/log.c` `show_setup_revisions_tweak` leaves `combine_merges` off when `--first-parent` is given, and `log-tree.c` `log_tree_diff` then diffs a merge against its first parent only; v2.50.1's `show_setup_revisions_tweak` calls `diff_merges_default_to_first_parent` for it |
| c | The diff hint (R20), 69 characters, the keyboard in a diff | A `.txt` diff: the whole hint shows, 3 columns to spare. A `.ts` diff, whose status bar also shows `TypeScript` and `LSP (off)`: cut after about 52 characters (`… j/k scroll, Enter …`), so a hint ending with `q/Esc close` lost it. With the close keys first: `q/Esc close, n/] next, p/[ prev, Enter file, (S-)Tab…`, only the pane and scroll keys cut |


**Ticket.** "Click on file does not open it in tab. Diff numbers near the branch do not show actual changes count (I changed one line in README, it's shown in Changes but the numbers show 0 0)." Added: stage and unstage per file and per group; view file and view diff per file row, the diff side by side (Changes: index vs working tree; Staged: HEAD vs index).

Same sources as above (`DTS`, `SRC`, `EP`), plus the third-party `git-review` copy (`/tmp/fresh-investigate/git-review/git_review.ts`, `GR`). Logs: `~/.local/state/fresh/logs/fresh-server-{91211,53581,59110}.log`. Throwaway git repos under `/tmp/gs-stage-probe*` were used for the staging commands (git 2.50.1).

### 9.1 A click on a file row opens nothing (root cause, high)

- **What the host sends.** A row-body click on a leaf row is a `select` hit; only rows with `hasChildren` toggle on click (`SRC/fresh-editor-core/src/widgets/kinds/tree.rs:320-353`). The plugin gets `select {index, key, col, row, via:"click"}` (`SRC/fresh-editor/src/app/widget_runtime.rs:217-227`).
- **What the plugin does with it.** `select` only records the selection (`git_sidebar.ts:404-406`); files open on `activate` only (`:412-414`), which is R7 as written ("Enter or a double-click").
- **What users expect.** The explorer opens a file on a single click, as a preview tab that keeps focus in the explorer; a double-click opens a permanent tab and focuses the editor (`SRC/fresh-editor/src/app/chrome/file_explorer.rs:83-147`). Built-in sidebar and panel trees act on `select` with `via === "click"`: `EP/search_replace.ts:2837-2846` opens on click, `EP/markdown_toc.ts:745-754` previews on click and keeps the section focused. Keyboard moves carry no `via`.
- **Double-click.** From the code, a double-click on a leaf row in a sidebar section gives `select`, `select`, `activate`: `Slot::Sidebar` hits take the shared tail that calls `activate_on_double_click` when `clicks >= 2` (`SRC/fresh-editor/src/app/shell_host.rs:2209-2213,2259-2265`). The second press must land on the same cell within `editor.double_click_time_ms` (default 500) (`SRC/fresh-editor/src/app/mouse_input.rs:346-379`, `SRC/fresh-editor-core/src/config.rs:1776-1778`). P5 saw only one `select` through SGR injection. Live behaviour with a real mouse is UNCONFIRMED.
- **Runtime evidence.** The plugin logged no error, no `setStatus`, and no open after the user's clicks in the section (`fresh-server-91211.log`, 22:27:33Z onwards: `refocus_floating_panel … git_sidebar:1`, mouse input, then only `gitSidebarTick`). The host does not log `select`/`activate`.
- **Ruled out.** `fileStat` returns `{isFile, isDir, size, readonly}` or `null` (`SRC/fresh-plugin-runtime/src/backend/quickjs_backend.rs:4577-4593`), so `activate()` reads it correctly. The installed copy is byte-identical to the repo.
- **Opening.** `openFile(path)` returns true once the request is sent and opens a permanent tab in the main split (`SRC/fresh-editor/src/app/file_open_orchestrators.rs:265-400`). `previewFileInSplit(splitId, path)` (`DTS:5742`) opens a preview tab, the explorer's single-click behaviour; `getActiveSplitId()` is `DTS:5343`.

### 9.2 The title's "0 0" is ahead/behind, not changes (high)

- The title is `Git · <branch> ↑A ↓B` from `# branch.ab` (`lib/status.ts:110-114`, R2). The repository now has an upstream (`origin/main`, both at `d34cc44`), so `# branch.ab +0 -0` renders `↑0 ↓0`. A modified README does not change it.
- The file counts are already in the group labels (`Changes 1`).
- **Line counts would need another git run.** `git --no-optional-locks diff --numstat` (and `--cached`) per refresh. They change on every saved edit, and a title change forces a remount (§2), so the section would remount on most refreshes.

### 9.3 Row affordances in 0.5.9 (high unless noted)

- **One button per row.** `TreeNode.action?: string | null` (`DTS:1979-1993`, `SRC/fresh-core/src/api.rs:2394`).
  - Drawn as `[ label ]` against the panel's right edge, always visible, theme colour `ui.help_key_fg`.
  - A long name slides under it.
  - Costs the label plus 6 columns, and 1 more for the scrollbar (`SRC/fresh-editor-core/src/widgets/render.rs:2163-2177,2660-2715,2778-2791`; `SRC/fresh-editor/src/view/shell/widgets.rs:853-858`).
  - Works on group rows too, and does not conflict with `toggleOnClick`: a press on it is an `action` hit, not a `select`, so it does not toggle (`tree.rs:288,320,334-356`; `widgets.rs:1259-1310`).
- **Button events.**
  - A click fires `action {index, key, via:"click"}` only, with no `select`, but the host moves the highlight to that row (`tree.rs:280-285,320-325`).
  - A double-click fires `action` twice and no `activate` (`widget_runtime.rs:101-110`).
  - A right-click on the button fires nothing.
- **No other clickable segment.** Row clicks carry absolute screen `col`/`row`, but no API gives the section's screen origin or width (§2), so glyphs inside the label cannot be hit-tested (medium-high).
  - `checkable:true` draws a native `[v]`/`[ ]` box on the left that fires `toggle` (`DTS:2475-2484`; `render.rs:2627-2650`).
  - Table `columns` exist but are untyped in the DTS.
  - `hoverAction` is HEAD-only.
- **Keyboard.**
  - A sidebar section has no keymap: "A sidebar section takes its keys through `widget_event` and never through a mode" (`widget_runtime.rs:2447-2470`; mounted with `mode: None`, `plugin_dispatch.rs:6491`). Plain letters (`s`, `u`, `+`, `-`) reach the tree, which has no text handler, and are swallowed. Ctrl/Alt chords leave the section for the editor keymap (`router.rs:374-411`).
  - Usable keys:
    - Up/Down, PgUp/PgDn;
    - Left/Right;
    - Enter → `activate {index, key}`;
    - Space → `activate {index, key, via:"space"}` (non-checkable tree, `tree.rs:205-227`);
    - Esc leaves the section.
- **Right-click.** `context {index, key, col, row}`, with absolute screen cells. It focuses the section and does not move the selection (`shell_host.rs:2738-2760`).
- **Menus.**
  - **Row-anchored floating menu.** An anchored floating panel is the only menu that sits at the row. `mountFloatingWidget` (`DTS:8127`) with a column of buttons, then `floatingPanelControl(id, "anchor", row * 65536 + col)`.
    - The op is implemented (`plugin_dispatch.rs:6782-6796`) but missing from the DTS op list (`DTS:8171-8185`), and is used by the built-in orchestrator's context menu (`EP/orchestrator.ts:7039-7088,17982-18003,18561-18571`).
    - A choice arrives as `activate` with the button's `widget_key`; Esc or a click outside arrives as `cancel`.
    - It takes focus. There is one floating slot.
    - Where focus returns to after a menu opened from a sidebar section is UNCONFIRMED (medium).
  - **Not anchored.** `showActionPopup` (`DTS:7839-7852`) is drawn bottom-right as a notification. `startPrompt` + `setPromptSuggestions` (`DTS:7100,7157`) is a quick-pick at the bottom or centre.
- **Composite section content.** The sidebar draws a section with the dock's generic renderer (`SRC/fresh-editor/src/view/shell/sidebar.rs:373-382`), so `col([row([button…]), tree])` should host a button bar above the tree. Not probed in a sidebar (medium).
- **Palette commands.** `registerCommand(name, description, handler, context?)` (`DTS:5447-5462`). The handler gets no arguments, so a command acts on the plugin's own `selectedKey`. `setContext` (`DTS:5468-5477`) can show such commands only while the section is focused.

### 9.4 A side-by-side diff of two texts (high unless noted)

- **No built-in fits.**
  - `runCommand`/`executeAction` take no arguments and match localized names. "Side-by-Side Diff" is fixed to the active buffer, HEAD vs working tree (§3).
  - `getPluginApi("compare-files").compare(leftPath, rightPath)` (`EP/compare_files.ts:731-734`) takes existing file paths only, returns no handle to close the view, and is `null` when compare_files is disabled.
  - Feeding it temp files would mean files the plugin cannot delete (no delete API in the DTS), and `getTempDir()` is the host's while `replaceFile` follows the window authority.
- **Composite buffer built by the plugin** (git-review's approach, `GR:441-517`). All in the 0.5.9 DTS, none marked experimental:
  1. Read both sides with git through the existing Runner. Working-tree side: `readFile`, or the open buffer's text.
  2. Two hidden read-only virtual buffers: `createVirtualBuffer({readOnly, editingDisabled, hiddenFromTabs, entries})` (`DTS:7926`).
  3. `computeLineDiff(old, new)` gives `{oldStart, oldCount, newStart, newCount}` hunks, which `createCompositeBuffer` accepts as is (`DTS:6046,3540,223-247`; `GR:476-479`).
  4. `createCompositeBuffer({name, mode, layout: side-by-side, sources, hunks})` (`DTS:6674,375-400`), then `showBuffer(id)` (`DTS:5777`), which opens it as a tab in the current split.
  5. `setSyntaxRegions` (`DTS:6695`) highlights a virtual source (UTF-8 byte offsets).
  6. `closeCompositeBuffer` (`DTS:6699`) drops only the composite's state. The plugin closes its own view with it, then `closeBuffer(id, true)` on the composite and both sources (P9 c). On a user's tab close, `buffer_closed`, it calls `closeCompositeBuffer` too and then closes the sources, as git-review does: only that call drops the host's composite state (§8 P19). A source that closes first is handled the same way.
  7. Pass `hunks` as a list, even an empty one: with `null` the host draws neither pane (§8, live checks).
- **What the composite does for us.** Both panes scroll as one, and the host draws intra-line highlights (`SRC/fresh-editor-core/src/model/composite_buffer.rs:251`; `render_composite.rs:266-292`).
- **Vendorable helper.** `contentToEntries` (`EP/audit_mode.ts:5124-5141`, about 10 lines) drops the trailing newline that otherwise breaks the last view line. Apply it once, to the same text that goes to `computeLineDiff`, so that a change to the final newline still shows (§8 P18).
- **Tab pile-up.** git-review keeps one diff slot plus a generation counter: a stale slow click is dropped, the new view is shown, then the old one closed (`GR:467,501-523`). audit_mode closes the previous view first (`audit_mode.ts:8143-8162`).
- **Sides per row:**

  | Row | Left | Right |
  |---|---|---|
  | Changes, modified/deleted/type change | `git show :<path>` | working file (`""` if deleted) |
  | Changes, untracked | `""` | working file |
  | Changes, intent-to-add (`.A`) | `""` (index blob is empty) | working file |
  | Changes, conflicted (`u`) | no stage 0: `:2:<path>` (ours) or `HEAD:<path>` | working file with markers |
  | Staged, modified/type change | `git show HEAD:<path>` | `git show :<path>` |
  | Staged, added | `""` | `git show :<path>` |
  | Staged, deleted | `git show HEAD:<path>` | `""` |
  | Staged, renamed/copied | `git show HEAD:<orig>` | `git show :<path>` |
  | Unborn branch | every `HEAD:` side is `""` | |

  - Binary contents need a status message instead of a view: a NUL byte, `readFile` returning null or `undefined`, or a git object whose text is not exactly its `cat-file -s` bytes of UTF-8 (§8 P17).
  - A Changes or conflicted row whose working-tree mode is 120000 (a symbolic link) is refused too: the file API follows the link (§8 P20). A Staged row's sides are git objects, which hold the link text.
  - Very large files cross the bridge about three times, so cap them.
- **Split and focus (P9, high).** With the keyboard in the section, `showBuffer` opens the tab in the split that was active before the click, and focus stays in the section.
- **Closing a composite (P9, high).** `closeCompositeBuffer` drops the composite's state only. The buffer stays as an empty, unnamed tab until `closeBuffer(id, true)` closes it (`SRC/fresh-editor/src/app/composite_buffer_actions.rs:217-222`). A user's tab close fires `buffer_closed` for the composite.

### 9.5 Staging commands (probed, git 2.50.1)

- **How to run them.** From the repository root, through the existing Runner, so bind-mounted dev containers keep working (§7). Use `git --literal-pathspecs`: without it, `git add -- 'a*'` also staged `ab`.
- **They take `index.lock`.** They cannot use `--no-optional-locks`, so R11's first bullet has to narrow to the background refresh. On failure (the user's own git holding the lock), report it and refresh.

| State | Stage (Changes row) | Unstage (Staged row) |
|---|---|---|
| Modified, added, type change | `git add -- <p>` | `git reset -q -- <p>` |
| Deleted (` D`, `AD`, `MD`) | `git update-index --remove -- <p>`. `add` also adds what is now under a directory at `<p>` and embeds a nested repository there (§8 P14 d). `rm --cached -q` was used first; it also drops the entry of a file restored since the row was read (P23 a) | `git reset -q -- <p>`. This also unstages a staged `<p>/…`: an index cannot hold `foo` and `foo/bar` at once (P14 j), and no command can avoid it |
| Untracked | `git add -- <p>` | — |
| Renamed (`orig`) | Changes `.R` (onto an intent-to-add path): `git update-index --remove -- <orig>`, then `git add -- <p>`. The original is a deletion: `add -- <p> <orig>` embeds a nested repository at `<orig>` (P23 e) | `git reset -q -- <p> <orig>`. Resetting `<p>` alone left `D  <orig>` staged |
| Copied (`orig`) | — | `git reset -q -- <p>` only: the source keeps its own staged change (§8 P15) |
| Conflicted (`!`) | `git add` marks it resolved even with markers still in it | — (never in Staged) |
| Unborn branch | `git add -- <p>` | `git reset -q -- <p>` works. `git restore --staged` fails with rc 128, "could not resolve HEAD" |
| Group: stage all | `git update-index --remove -- <every deletion and Changes rename original>`, then `git add -A -- <every other Changes path but conflicted>`. Deletions go first: after `add` has put `foo/x` in place of a deleted `foo`, removing `foo` fails (§8 P14 e, P23 f). A bare `git add -A`/`-u` resolves conflicts | — |
| Group: unstage all | — | `git reset -q -- <every Staged path and orig>`. A bare `git reset -q` deleted `MERGE_HEAD` (aborting a merge), and `git reset -- :/` turned `UU` into ` M`. Listing the paths keeps both (git warns "needs merge") |

- **Edge exit codes (P13, §8).**
  - An unstage that lists paths while a conflict is open exits 0 and prints `<path>: needs merge`. That is success: it keeps the conflict and `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `.git/rebase-merge`.
  - One path that no longer exists fails the whole `add` with rc 128 (`pathspec '<p>' did not match any files`), and nothing in that command is staged.
  - `cat-file -s HEAD:<absent>` is rc 128. So is "not a repository", so an absent side is decided from the status, not from this exit code. An intent-to-add path's `:0:` blob is empty, with rc 0.
- **Directory rows** (submodule, nested repo): `git add` on an untracked nested repo adds an embedded repository, so offer no action there (P14 d saw it).
- **Names that are not UTF-8.** Status comes back with U+FFFD in such a path (§8 P17), so it names nothing, and one such path fails a whole `add`. Those rows get no button; the group commands skip them and count them.
- **Writes are never killed.** In 0.5.9 `kill()` is a SIGKILL on both runners (§8 P16), and a killed write leaves `.git/index.lock`. A write gets 60 s; after that the user is told git is still running, and it is waited for: until it exits it holds the lock, so the next write waits too, and its own result is reported. Reads keep the 10 s timeout and the kill.
- **Precedent.** `audit_mode` stages with `git add -- <p>` and unstages with `git reset HEAD -- <p>`, awaiting a refresh after each (`EP/audit_mode.ts:4229-4240`). It has no stage-all and passes only the new path of a rename. git-review has no staging.

### 9.6 Open

- **Double-click.** Does a real mouse double-click on a file row deliver `activate` (§9.1)? Manual (P12), not yet run.
- ~~**Focus.**~~ Closed by P9: `showBuffer` uses the split active before the click, and focus stays in the section. `openFile` was not probed.
- ~~**Anchored menu.**~~ Closed by P10: it is drawn at the pointer, Esc and a click outside give `cancel` on the menu panel only, and focus returns to the section.
- ~~**Re-click.**~~ Closed by P21: with `cardBorders: true` at `itemHeight: 1`, a click, a button press and a right-click on the selected row all reach the plugin.
- ~~**Command length.**~~ Handled: stage all and unstage all run in commands of at most 16 KiB of paths each, with a rename's two paths in the same command. They are not atomic, and a failure reports how many paths it got through.
- **Line endings (follow-up, not fixed).** Under `core.autocrlf` or `eol`/`text` attributes, a Changes diff compares the raw LF blob with the CRLF file on disk, so every line shows as changed. `git cat-file --filters` would give the file as git compares it, but it runs the repository's smudge filters on every click.
- ~~**Windows and the rows context.**~~ Fixed with one section per window (§11.5): `setContext` writes to the active window, so each section sets its contexts only while its window is active, and both are set again on every switch. Load still clears the contexts a previous load left set in the active window.
- **Status that is not UTF-8 in a bind-mounted dev container (found, not fixed).** Through `spawnHostProcess`, a status whose output holds one path that is not UTF-8 comes back as `""` with rc 0 (§8 P17). The section then shows empty groups and the title `Git · HEAD`. `runOnTarget` (local) is lossy instead, and the rows show U+FFFD.
- **Lossy text of the same length (low).** A blob refusal compares UTF-8 lengths. A blob in which three bad bytes become one U+FFFD (3 bytes), such as a truncated 4-byte sequence, keeps its length and is shown with U+FFFD in it.
- **Untracked symbolic links.** `?` records carry no mode, so an untracked link's diff shows its target's contents (README Limits).

## 10. UX review against VS Code's Source Control view (2026-11-24)

**Ticket.** "Review fresh editor docs, source code, official plugins. Find APIs, patterns and approaches that we could use to improve UX/UI of our plugin. Golden standard is VS Code git integration. Try to keep the plugin simple."

Same sources as above (`DTS`, `SRC`, `EP`, `GR`), plus:

- `UP` at master `8958d125d`, 82 commits past v0.5.9, none of them released (v0.5.9 is still the latest release);
- `PR3539`, the closed upstream source-control plugin (`/tmp/fresh-investigate/pr3539/`);
- `FD`, sinelaw/fresh-plugins `file-diff/file_diff.ts`;
- `VS`, VS Code's git extension and SCM sources, cached under `/tmp/gs-ux-vscode/`: `package.json` is the git extension's manifest, and `docs/` holds the code.visualstudio.com source-control pages.

No live probe was run while writing this section. UNCONFIRMED marks each claim one had to settle; §8 P25–P30 have since settled them (§10.7).

### 10.1 Where the section stands (high)

**What already matches VS Code's defaults:**

- **Groups.** Staged Changes and Changes, each with a count. Untracked files are mixed into Changes (`git.untrackedChanges: mixed`, `VS/repository.ts:3133`).
- **Rows.** The letters M A D R C T U `!`, in the theme's git colours (`VS/repository.ts:61-148`).
- **Clicks.** A click opens the diff and the keyboard stays in the list (`VS/listService.ts:718-735`). One replaced diff tab plays the part of VS Code's preview tab.
- **Enter.** It opens with the keyboard kept in the list. VS Code's keyboard open defaults to `preserveFocus: true` (`VS/listService.ts:711-712`). Fresh's own explorer and Markdown contents move the keyboard to the editor on Enter instead (`UP/docs/features/file-explorer.md:18-21`, `markdown.md:147`).
- **The diff.** It opens on its first change: `initialFocusHunk: 0` (`git_sidebar.ts:677`), as VS Code's `revealFirstDiff` does (`VS/textDiffEditor.ts:147`).
- **Actions.** Stage and unstage per row and per group, and a context menu.

**Where it differs by an earlier decision (spec, Decisions):**

- Conflicts are `!` rows under Changes, not a first Merge Changes group (`VS/sourceControl.ts:175-178`).
- An empty Staged Changes group stays visible. VS Code hides it (`git.alwaysShowStagedChangesResourceGroup: false`).
- Space stages. VS Code's Space expands and collapses (`VS/listCommands.ts:754`). Fresh's tree sends Space as `activate` with `via:"space"` so that a plugin can give it a meaning of its own (`UP/docs/internal/widget-controls-own-interaction.md:55-58`).
- No discard and no commit.

**What it lacks:**

- the diff's Open File (`VS/package.json` `menus["editor/title"]` `git.openFile`);
- a key that focuses the view (Ctrl+Shift+G);
- auto-reveal of the active file (`scm.autoReveal: true`);
- strike-through on deleted files (`VS/repository.ts:249-260`);
- file icons;
- a right-aligned letter;
- actions shown only on hover;
- tooltips;
- multi-select;
- a commit box;
- discard;
- staging selected ranges;
- a progress indicator.

### 10.2 Already there, not documented (high from code; confirmed live by §8 P25, P26)

- **Diff keys.** The core keymap's `compositeBuffer` context binds:
  - `n` / `]` to `composite_next_hunk`;
  - `p` / `[` to `composite_prev_hunk`;
  - `q` / Esc to `close` (`SRC/fresh-editor-core/keymaps/default.json:1760-1805`).

  Composite panes get that context (`SRC/fresh-editor/src/app/render.rs:5864`). A buffer mode without text input lets keys it does not bind fall through to normal handling (`SRC/fresh-editor/src/input/router.rs:595-600`). So the plugin's empty `defineMode(DIFF_MODE, [], true)` keeps all of them. `q` closes the tab, which raises `buffer_closed`, already handled (P19).
  - The keyboard stays in the section after a diff opens (P9), so the keys work once the user is in the diff. Esc in the section sends `blur` (P5), and what gets the keyboard next is UNCONFIRMED.
  - VS Code's equivalent is Alt+F5 / Shift+Alt+F5 (`VS/diffEditorCommands.ts:47-65`).
- **Reaching the section from the keyboard.** Alt+Shift+N and Alt+Shift+P cycle focus through the explorer, each section and the editor (`UP/docs/features/file-explorer.md:11`; v0.5.9 `default.json:1892-1959`).
- **Syntax colours in the diff, probably.** A virtual buffer picks its grammar from its name (`SRC/fresh-editor/src/app/virtual_buffers.rs:341,371` → `state.rs:617`). `DetectedLanguage::from_virtual_name` strips the `*`s and takes the text after the last `:` (`SRC/fresh-editor-core/src/primitives/detected_language.rs:225-240`).
  - The plugin names its sources `*<label>: <path>*` (`git_sidebar.ts:638`), so the name looked up is `" <path>"`, with a leading space.
  - An extension still matches. A file at the repository root that is known by its name alone (`Makefile`) would not, and neither would a path that holds a `:`.
  - A survey agent read the absence of `setSyntaxRegions` as "no highlighting". The name-based detection says otherwise. UNCONFIRMED live.

### 10.3 Small additions, all in the 0.5.9 DTS

| # | What | How | Evidence | Cost |
|---|---|---|---|---|
| a | **Open the file at the diff's cursor line** (VS Code's Open File in the diff) | Bind a key in `DIFF_MODE`. Its handler reads `getCompositeCursorInfo()` (`{focusedPane, paneCount, lines[]}`, `DTS:5630`), then `openFile(path, line + 1)` (`DTS:5696`). A Changes row's right pane is the file on disk, so its line is exact. A Staged pane's line is only near. A deleted file gets a message | `EP/audit_mode.ts:6732-6759,6859-6862` (Enter); `FD:511-524` | S |
| b | **A focus command** (Ctrl+Shift+G) | `floatingPanelControl(PANEL, "focus")` (`DTS:8146,8175`). markdown_toc's "Focus Contents" also sends `"reveal"` (`EP/markdown_toc.ts:486-500`), but `"reveal"` is not in the DTS op list. A user can bind any handler name in their keymap (`SRC/fresh-editor/src/input/keybindings.rs:938`). Whether `"focus"` expands a collapsed section is UNCONFIRMED. With the explorer hidden, it opens the column (§2) | — | S |
| c | **Auto-reveal the active file** (`scm.autoReveal`) | Handle `active_buffer_changed` (`DTS:9368`). When the section is not focused and the file is listed, select its row with `setSelectedIndex`, which never moves focus (`SRC/fresh-editor/src/app/plugin_dispatch.rs:6054-6063`). Prefer Changes over Staged, as VS Code does (`VS/scmViewPane.ts:1921-1960`). When a row of the active file is already focused and selected, in any group, VS Code changes nothing (`VS/scmViewPane.ts:1937-1944`). The explorer's own follow setting, `file_explorer.follow_active_buffer`, defaults to false (`SRC/fresh-editor-core/src/config.rs:1956,2426`). Whether the mutation echoes a `select` event is UNCONFIRMED | — | S/M |
| d | **Strike-through on deleted files** | Segment styles take `strikethrough`, as well as `bold`, `italic` and `underline` (`DTS:1694-1742`), and tree text honours them (`SRC/fresh-editor/src/view/shell/widgets.rs:5122-5140`) | `VS/repository.ts:249-260` | S |
| e | **Resolve a conflict with merge_conflict** | On `!` rows: `openFile(path)`, then `executeAction("start_merge_conflict")` (`DTS:5487`; unknown names become plugin actions, `keybindings.rs:938`). merge_conflict exports no API (`EP/merge_conflict.ts:1215-1227,1818`). On open it already shows a "use 'Merge: Start Resolution'" hint (`:131-167`). The order of the two queued calls is UNCONFIRMED. If merge_conflict is disabled, nothing happens and only a warning is logged | VS Code opens the file with its markers and Accept actions | S |
| f | **A key hint when the diff opens** | One `setStatus` line naming the diff keys. find_references and diagnostics_panel show such hints (`EP/find_references.i18n.json`, `EP/diagnostics_panel.i18n.json`) | — | S |
| g | **File history** | `openFile` then `executeAction("show_git_log_current_file")` (`EP/git_log.ts:695-704`), with the same caveats as (e). VS Code's core SCM view has no such item; its Timeline view does | — | S |

### 10.4 Larger VS Code features (each widens the spec's scope)

- **Commit** (M). A quick commit takes a message from `editor.prompt(label, initial)` (`DTS:7067`) and runs `git commit -m <msg>` through `runWrite` and `OpQueue`, never killed (P16).
  - With nothing staged, it says so. VS Code offers to stage everything (`VS/commands.ts:2440-2470`), and that would need the same care as stage all (§9.5).
  - Risks:
    - hooks can run long: past 60 s the existing "still running" message shows;
    - GPG signing with a terminal pinentry has no terminal under Fresh's runners, so it fails with git's reason (UNCONFIRMED);
    - in a bind-mounted container, the commit runs on the host with the host's identity (§7).
  - PR3539 had one (`pr.diff:1162-1200`). Its `ensureStaged` falls back to `git add -A`, which resolves conflicts (`:1626`). Avoid that.
- **Discard** (M, destructive).
  - A Changes row is restored from the index: `git restore --worktree -- <p>`, not from HEAD, which audit_mode does (`EP/audit_mode.ts:4337-4359`).
  - An untracked file is deleted.
  - It needs a confirmation. audit_mode uses `startPrompt` plus `setPromptSuggestions([Discard, Cancel])` (`:4398-4407`), then checks `git status` rather than the exit code (#2318).
- **Stage or unstage a hunk from the diff** (M-L). audit_mode builds a patch, writes it with `scratchCreate` / `scratchPath` (`DTS:6112-6122`), and runs `git apply --check`, then `--cached [--reverse]` (`EP/audit_mode.ts:4088-4116,8869-8875`).
  - `computeLineDiff` gives zero context lines, so the patch needs `--unidiff-zero`.
  - Fresh's process API has no stdin, so a file is required.
  - In a bind-mounted container the patch path must be the host path (UNCONFIRMED).
  - Under autocrlf the patch does not apply (§9.6).
- **A Merge Changes group first** (S-M). It changes R3 and R4, and the "conflicts go under Changes" decision.
- **File icons** (M). The explorer draws icons only with `editor.nerd_font_icons` (`SRC/fresh-editor/src/view/file_tree/slots.rs:296-335`).
  - A plugin can match them with `getBuiltinFileIcons()` (`DTS:6520`), the host's lookup order (`view/file_icons.rs:218-238`), and the theme's overrides from `getThemeData`.
  - Risk: a copy of the host's merge drifts from it.

### 10.5 Not possible in 0.5.9, or coming upstream (high)

- **A right-aligned status letter.**
  - `columns` / `cells` have no alignment, always draw a header (`SRC/fresh-core/src/api.rs:2408-2432`), and are ignored by the card layout that P21 needs.
  - `padToChars` needs the section width, which no API gives (§2).
  - Master adds `align:"between"`, `splitByte`, `fadeTail` and `hoverAction` as untyped row properties (`UP` `3838ead19`, #3826, unreleased).
- **Actions shown on hover only.** `hoverAction` is master-only. The always-visible `[ + ]` is 0.5.9's equivalent, and moving to `hoverAction` later is compatible.
- **Items in the explorer and tab menus** (Stage, Open Changes): `addFileExplorerMenuItem` and `addTabMenuItem` are master-only (`36f25885a`, #3838).
- **Header buttons.** The header draws a chevron, the title and optional `⟳`/`×` only, and a plugin section gets no `⟳` (`SRC/fresh-editor/src/view/shell/sidebar.rs:486-566`, `app/render.rs:3268`).
  - A toolbar row above the tree would render, but a press on it blurs the tree, which clears the tree's selection (`SRC/fresh-editor-core/src/widgets/kinds/tree.rs:62-70`).
- **Tooltips, multi-select, icon fields.** None of them is on a 0.5.9 or master `TreeNode` (`DTS:1906-2002`).
- **A unified (inline) diff.** `"unified"` is accepted, but it splits the panes without interleaving lines (`SRC/fresh-editor/src/view/composite_view.rs:40-56`).
- **A diff as a preview tab.** `previewFileInSplit` takes file paths only (`SRC/fresh-editor/src/app/buffer_management.rs:336,359-396`).
- **A persistent status-bar item.** `registerStatusBarElement` and `setStatusBarValue` are per buffer, and the item shows only if the user adds `{git_sidebar:<token>}` to `status_bar.*` (`DTS:5513-5518`).
- **Direction.** The maintainer wants git panels as third-party plugins (#3539, #526). The internal "Git Changes" mockup only illustrates the accordion (`UP/docs/internal/sidebar-sections-design.md:230-246`). Nothing upstream competes with this section.

### 10.6 Conventions not followed (medium)

- **No i18n file.** The docs ask for `<stem>.i18n.json`, `%cmd.*` names and `editor.t()` (`UP/docs/plugins/development/i18n.md:9-85`). A sibling `git_sidebar.i18n.json` is not loaded as a second plugin (`SRC/fresh-plugin-runtime/src/thread.rs:1448,1538`).
- **Settings.** If settings are ever added, master names them in snake_case (`9821caa3a`).

### 10.7 Open

- ~~**P25, the diff keys.**~~ Closed by §8 P25: all six keys work with Enter bound in the mode, and Esc in the section sends the keyboard to the active editor buffer.
- ~~**P26, syntax colours.**~~ Closed by §8 P26: coloured by name or extension once the name has no space after the `:`. A shebang-only file stays plain.
- ~~**P27, the focus command.**~~ Closed by §8 P27: `"focus"` expands a collapsed section and shows a hidden column, so `"reveal"` is not used.
- ~~**P28, auto-reveal.**~~ Closed by §8 P28: no echo, and the row scrolls into view. The panel's `blur` comes before `active_buffer_changed`, and `chrome_focus_changed` after it.
- ~~**P29, conflicts.**~~ Closed by §8 P29: resolution starts on the newly opened file. With merge_conflict disabled the call logs an ERROR, so the plugin checks `listPlugins()` first.

## 11. Multiple windows (2026-11-24)

**Ticket.** "Why does git-sidebar disappear when I switch project in the orchestrator or reopen the Fresh editor? Can I install it once so it's shown in every project?" The package is installed once, in `~/.config/fresh/plugins/packages/git-sidebar`. The plugin loads once per Fresh process. It mounted its section only in the window active at load, which the spec put out of scope.

Sources: `SRC` paths as above (`app/` is `SRC/fresh-editor/src/app/`), `DTS`, `EP`, and the user's log `~/.local/state/fresh/logs/fresh-server-33807.log`. Live results are §8 P31–P34.

### 11.1 Windows and their sections (high)

- **A window is an Orchestrator session.** Each one has its own root, explorer tree, tabs, authority, trust, contexts and status message. One Fresh process holds them all, and the plugin loads once for all of them.
- **Panel ids are per plugin, not per window.**
  - The registry key is `PanelKey {plugin, id}` (`SRC/fresh-editor-core/src/widgets/registry.rs:26-40,565,744-746`), and the sidebar keeps "one section per identity, wherever it is" (`app/sidebar.rs:8-10,806-808`).
  - A second `mountSidebarSection` with the same id and another window's scope moves the one section (`app/plugin_dispatch.rs:6461-6484`, `app/sidebar.rs:654-690`). The user's log shows `git_sidebar:1` re-scoped this way.
  - So a section per window needs a panel id per window. Id 0 is the prompt toolbar's (`registry.rs:42-49`). Ids pass through `f64 as u64` (`SRC/fresh-plugin-runtime/src/backend/quickjs_backend.rs:8777,8822,8846`).
- **Parked sections.** A section whose window is not active is parked whole, with its rows, collapsed state and panel. A focused one is blurred first (`app/sidebar.rs:931-970`).
  - `updateFloatingWidget`, `widgetMutate` and `unmountFloatingWidget` work on a parked section (`app/plugin_dispatch.rs:5968,6558,6594-6598`; P34). An unmount of a parked section sends no `cancel`.
  - `floatingPanelControl` sees only sections on the column, and warns otherwise (`app/plugin_dispatch.rs:6654-6657`, `app/editor_accessors.rs:1105-1127`).
- **The divider is the editor's.** The explorer is one editor-wide section (`scope:"editor"`). So the height dragged between it and the Git section is the same in every window (P32 a). Collapsed state is the section's own, and so per window (P32 b).

### 11.2 Saved layout and restore (high)

- **Each window's workspace file** holds the editor-wide sections and its own: `{"kind":{"kind":"panel","plugin":…,"id":…},"scope":"window","title":…,"rows":…,"collapsed":…}` (`SRC/fresh-editor/src/workspace.rs:627-660`, `app/sidebar.rs:754-787`). The title is stored but does not identify the section; the key does (`app/sidebar.rs:827,902-907`).
- **Lazy restore.** A window other than the launch window is restored when it is first shown: `set_active_window` → `materialize_window` → `restore_sidebar_sections`, while still inactive, then the switch (`app/window_actions.rs:709,721`, `app/workspace.rs:284-294,561,832-849`). The restore parks a placeholder, which a mount of the same key claims within about 4 frames (`app/sidebar.rs:832-899`). After that the layout survives as an editor-wide hint keyed `{plugin, id}`, which a later first mount takes (`:666-669,1055-1069`).
  - If the key is already mounted somewhere when the window is restored, its saved layout only becomes a hint (`:833-835`). So a section must not be mounted for a window before that window is first shown.
  - P32 e: a synchronous mount from `active_window_changed` claims the placeholder.
- **Window ids are not durable.** They are re-derived on every boot (`app/orchestrator_persistence.rs:1039-1041`), so a panel id taken from one would not match its saved state.
- **Roots are not unique.** Extract Tab to New Workspace makes a co-tenant window on the same root, with a numbered label, and it persists (`app/window_actions.rs:173,197,1069-1079`; P31 e).
- **`WindowInfo.stable_id`** is minted once per workspace and survives restarts, relabels and moves (`DTS:970-983`; P31 a, e). It is empty only for a workspace file written before stable ids.
- **So the Git section's panel id comes from `stable_id`,** and from the root only when `stable_id` is empty.

### 11.3 When windows appear (high)

- **`window_created`** fires only from `createWindow` and `createWindowWithTerminal`, co-tenant extraction included (`app/window_actions.rs:310-317,634-641`). It never fires for windows restored at startup, for `loadWorkspaces()` or for a window being restored. The type file's "or when sessions are restored at startup" (`DTS:9341-9342`) does not match the code.
- **`listWindows()`** lists every window known so far, restored or not (`app/plugin_dispatch.rs:456-539`). At boot that is the launch folder's workspaces only. The Orchestrator then calls `loadWorkspaces()`, which adds the rest without restoring them (`app/orchestrator_persistence.rs:1101-1115`, `EP/orchestrator.ts:2750-2758`). `WindowInfo.root` is the path `getCwd()` gives in that window (`app/plugin_dispatch.rs:406,525`).
- **`active_window_changed {previous_id, active_id}`** fires after the window is restored and active, and `getCwd()` already gives its root (`app/window_actions.rs:795`, `app/focus_announcer.rs:121-124`; P31 b). The first focus announcement fires `active_buffer_changed` without it (`focus_announcer.rs:131`).

### 11.4 Events and APIs across windows (high)

- **`widget_event` carries the active window's id,** not the section's (`app/widget_runtime.rs:272-283`). So does the `cancel` sent when a window closes. The host closes only an inactive window (`app/window_actions.rs:1470-1476`): `buffer_closed` for each of its buffers, then the `cancel`, then `window_closed {id}` (`:1496-1529`, `app/sidebar.rs:973-1028`; P31 f). Route by `panel_id`.
- **Hooks for the active window only:**
  - `chrome_focus_changed`. It is also deduplicated editor-wide, so none fires on returning to a window (`app/mod.rs:784`, `app/focus_announcer.rs:74-95`).
  - `active_buffer_changed` (`:161-181`).
  - `after_file_explorer_change`.
  - auto-revert's `after_file_revert`.
  - `trust_changed` (`app/action_dispatch.rs:26-71`).
- **`authority_changed`** fires for the active window, and on a switch when the label differs. That is after the active pointer moves, and before `active_window_changed` (`app/editor_accessors.rs:668-684,769-796`, `app/window_actions.rs:753`). Neither it nor `trust_changed` carries a window id.
- **`buffer_closed`** fires for any window, with its `window_id`; buffer ids are global (`app/mod.rs:584-598`). `focus_gained` is editor-wide.
- **APIs that act on the active window** (`app/plugin_dispatch.rs`, `app/plugin_commands.rs`, `quickjs_backend.rs` as cited):
  - `getCwd`, `getAuthorityLabel`, `setStatus`, `prompt`;
  - `setContext`: contexts are stored per window and written to the active one (`app/plugin_dispatch.rs:6857-6869`; P33);
  - `showBuffer`, `createVirtualBuffer`, `createCompositeBuffer`, `closeCompositeBuffer`, `getActiveBufferId`, `findBufferByPath`;
  - `runOnTarget`, which runs on the active window's authority (`app/plugin_commands.rs:3604-3617`);
  - `floatingPanelControl`.
- **Other cross-window behaviour:**
  - `spawnHostProcess` always runs on the host, but its trust check is the active window's.
  - `closeBuffer` on another window's buffer can leave that window's split pointing at it (`app/buffer_close.rs:313-319,614-619`).
  - `openFile` may switch to another window that already has the file open (`app/file_open_orchestrators.rs:310-321`).
  - `openMachine({kind:"window", window})` runs a command on a given window's authority (`DTS:8829`). The plugin does not use it (spec, out of scope).
- **Built-ins with per-window state.**
  - `EP/search_replace.ts:2663-2700`: a panel per window, swapped on `active_window_changed`.
  - `EP/live_diff.ts:1478` and `EP/compare_files.ts:712`: work deferred until the window is active.
  - `EP/orchestrator.ts:385,18966-19048`: a map by window id.
  - `EP/markdown_toc.ts` re-scopes its one section per buffer.

### 11.5 Consequences for the plugin

- One section per window, mounted synchronously when its window first becomes active (at load for the launch window), with a panel id from `stable_id`.
- Widget events are routed by panel. Commands, Focus, the timer and the diff's Enter act on the active window's section.
- Git starts only for the active window. `runOnTarget` would use whichever authority is active, so a window's reads and writes stop when another window becomes active.
- Contexts are written only while a section's window is active, and set again on every switch. That also fixes §9.6's contexts item.
- A message about an inactive window waits until it is active again, because `setStatus` would show it in another window.
- Closing an inactive window's diff buffers waits until that window is active again: `closeCompositeBuffer` acts on the active window.
- Windows on one repository share its write queue, so their writes never hold `.git/index.lock` at once.
- `authority_changed` restarts a section only when its own window's label changed: the hook also comes on a plain switch between windows with different authorities.

## 12. Follow-up: row cap, diff navigation, graph, push and pull (2026-11-25)

**Ticket.** "Update git-sidebar: increase the Staged and Changes limits to 1000 items each; when I open a file diff, the next and previous change commands do not work there, fix if possible; add a third dropdown, a git graph, working like VS Code's git graph, functional but not overcomplicated; next to the Commit palette command, add Push and Pull." Later: "if push and pull are already implemented natively or in native plugins, skip it", and "for pull and push you could copy the VS Code implementation too".

Sources: `DTS`, `EP`, `SRC` as above; the user's log `~/.local/state/fresh/logs/fresh-server-216.log`; VS Code at `microsoft/vscode` main `45fca7d` (`VS`), and `mhutchie/vscode-git-graph` (`GG`), read with `gh api` (copies in `/tmp/gg_research/`). Live results are §8 P35–P38.

### 12.1 The row cap (high)

- The cap is one constant, `ROW_CAP = 500` (`git-sidebar/lib/view.ts:12`). Stage all already covers paths past it (R16).
- 1,000 rows per group costs little: a full update of 3,020 nodes takes 23 + 18 ms in the plugin (P36 h).
- Spec text that names 500 or its consequences: R11, R16, A11, A16, A23 (the 1,200-file repository, `… 700 more`).

### 12.2 Next/Previous Change in the diff (root cause, high)

- **What the user ran.** The palette's **Next Change** and **Previous Change** are the bundled diff_nav plugin's (`diff_nav_next`, `diff_nav_prev`; `EP/diff_nav.ts:200-212`). They have no default key, and the user's `config.json` has no `keybindings`. The user's log shows four `handle_action: PluginAction('diff_nav_next')` while the plugin's diffs (mode `git-sidebar-diff`) were open, at lines 412711, 413042, 413699 and 414375, each followed by `status: No changes`. No WARN or ERROR.
- **Why they fail.** diff_nav collects its targets from the active buffer only: view state `git_gutter_hunks` (git_gutter's), view state `live_diff_hunks` (live_diff's) and `getBufferSavedDiff` (`EP/diff_nav.ts:43-77`). In a diff tab the active buffer is the composite, which has none of them and no text; its cursor is a separate row (`SRC/fresh-editor/src/app/composite_buffer_actions.rs:340-362`). The two sources are hidden virtual buffers that are never active (P35 b).
- **Not the plugin's fault alone.** Fresh's own Side-by-Side Diff fails the same way (P35 c). audit_mode's Review Diff moves with its own `n`/`p` handler calling `editor.compositeNextHunk` (`EP/audit_mode.ts:6818-6830`).
- **What works.** `n`/`]` and `p`/`[` (P25), which are the core's `composite_next_hunk`/`composite_prev_hunk` in the `compositeBuffer` keymap context. Those actions are not in the palette (P35 g).
- **Fix options.**
  - a. Palette commands of the plugin's own that call `compositeNextHunk(id)` / `compositePrevHunk(id)` (`DTS:6725,6729`) on the active composite. Works (P35 e). A call at the last hunk does nothing and still returns true, so "no more changes" can only be told by comparing `getCompositeCursorInfo()` before and after, or from the hunks the plugin built.
  - b. The same through `executeAction("composite_next_hunk")` (P35 f). It works, but depends on an action name.
  - c. Feeding diff_nav fails (P35 d), and diff_nav could not move a composite cursor anyway.
  - The plugin cannot rename, hide or override diff_nav's commands, so the palette keeps listing them beside the plugin's.
- **Contexts.** Listing the new commands only while a plugin diff is active needs a third context; git-sidebar's CLAUDE.md allows only `git-sidebar-rows` and `git-sidebar-shown` today.

### 12.3 A git graph group (high unless noted)

**What VS Code does.**
- **The built-in Source Control Graph** (`VS/src/vs/workbench/contrib/scm/browser/scmHistory.ts`, `scmHistoryViewPane.ts`; `VS/extensions/git/src/historyProvider.ts`, `git.ts`) is a third collapsible section of the Source Control view, the closest analogue.
  - A row is graph lanes, the subject, the author (dimmed), then ref badges. Hash, date and stats are in the hover only.
  - Badges, by default, only for refs with a colour: the current branch, its upstream and the base ref (`scm.graph.badges`: `filter` | `all`).
  - Nodes: a circle; a double circle for a merge; a ring with a filled centre for HEAD.
  - Which commits: "Auto" (default) is the current branch, its upstream and its base; also "All" and an explicit list. `git log --topo-order --decorate=full` over those refs, `-n<pageSize>` with `--skip`, page size 50, a "Load More…" row (`git.ts:1514-1570`, `pane.ts:1300-1353`).
  - Two synthetic rows, "Outgoing Changes" and "Incoming Changes", when HEAD and the upstream differ. No uncommitted-changes row.
  - Expanding a commit lists its files; a file opens a diff of `parentIds[0]` against the commit, with an empty left side for a root commit (`pane.ts:1004-1021,1110`).
  - Commit menu: Checkout (detached), Create Branch, Create Tag, Cherry Pick, Compare with…, Copy Commit ID, Copy Commit Message. Title bar: Fetch, Pull, Push, Refresh, Go to Current.
- **The Git Graph extension** (`GG/src/dataSource.ts`, `GG/web/graph.ts`) is a full-tab table: graph, ref badges and subject, date, author, short hash. It shows every branch (`--branches --tags --remotes HEAD`), date order, 300 commits then 100 at a time, an "Uncommitted Changes (N)" row, a commit-details panel with `git diff --name-status --find-renames <c>^ <c>` (root: `diff-tree --root`), and a large menu (checkout, merge, rebase, reset, revert, branch and tag actions, push, pull).

**The data.**
- Log: `git log --topo-order -n <N+1> --format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e <refs>`. Asking for one more than shown tells whether more exist. "Auto" refs are `HEAD` plus `@{upstream}` when there is one. `--all` would include `refs/stash`.
- One commit's files: `git diff-tree -r -z --raw -M <c>^1 <c>`; a root commit `git diff-tree --root -r -z --raw -M <c>`. A merge compares with its first parent; plain `diff-tree <merge>` prints nothing. `--raw` gives modes, so a gitlink (160000) can be refused like a directory row.
- One file's sides: `<c>^1:<orig or path>` and `<c>:<path>`, empty for an added file, a root commit, or a deletion. The plugin's `readSide` already reads any `<rev>:<path>` blob (`lib/git.ts:39-41`, `git_sidebar.ts:747-788`).

**Lanes** (`scmHistory.ts:293-404`). An ordered list of lanes, each waiting for a commit id. For commit `c` in topo order:
- its node is in the first lane waiting for `c`, or a new lane at the end when none is (a branch tip);
- that lane now waits for `c`'s first parent; other lanes waiting for `c` end here (they converge into the node);
- each further parent gets a new lane;
- a root commit ends its lane. VS Code drops every other lane there too, which breaks with several roots; a re-implementation should keep them.
VS Code shifts lanes left as soon as one frees, drawing the shift inside the row. In text that needs two glyphs in one cell, so a text port keeps lanes in fixed slots and reuses the first free slot for a new lane (as GG's next free point does). Then a row needs only `●`/`○`, `│`, `─`, `╮`/`╭` for a lane leaving the node, `╯`/`╰` for a lane converging into it, and `┼` where a horizontal crosses a lane. That port is the research agent's proposal, untested.

**What Fresh allows** (P36).
- One commit per row, lanes aligned when every commit row is at the same depth with `hasChildren: true`; up to six lane colours (`editor.bracket_rainbow_1…6`).
- Nesting group → commit → file, and `expand` events to load a commit's files when it is expanded.
- Rows wider than the section end with `…`; badges and lanes keep their colours up to the cut. No width API.
- Only a full tree update or a tail append (`appendTreeNodes`, `DTS:2942-3005`, rejects duplicate keys and cannot move a "Load more" row). The plugin already does full updates, skipped when the signature is unchanged (`git_sidebar.ts:448-482`).
- The bundled git_log plugin cannot show a given commit: its handlers take no arguments and it exports no API (`EP/git_log.ts:683-704`). A read-only virtual buffer of `git show` output, named `*<id>:show.diff*`, is coloured as a diff (P36 i).
- `editor.setClipboard(text)` (`DTS:5440`; the bundled `EP/asm-lsp.ts:109` uses it) copies to the internal and the system clipboards, so Copy Commit ID and Copy Commit Message are possible (corrected at plan time; live in §8 P39 l).

**What a third group touches** (`git-sidebar/`).
- `lib/view.ts`: `buildTree`, `rowKind`, `groupOf`, `placeOf`, `reconcile` (R10's place: a commit or commit-file row has no group today), the row-cap row, `revealKey`, `signature`, and the `Segment`/`Node` types (no `bg` or `bold` yet).
- `lib/actions.ts`: `rowAction`, `buttonLabel`, `menuItems`/`MenuChoice`, `paletteTarget` (it tests `entries.has(key)`).
- `lib/diff.ts`: `sides`, `rowRefusal`, `COMPARISON`/`paneLabels`/`tabTitle` know only staged, changes and conflicted. `sourceName` labels must not hold a `:` (P26). `diffEnter` (R19) maps to the working file's line, which for a commit is only near.
- `git_sidebar.ts`: the initial `expanded` set, the `expand` handler (lazy loading, with an epoch check after every await), `activate`, `openDiff`, `menuChoose`, and the refresh: a `git log` when HEAD, the upstream or the refs move, inside R11's 25% budget and R28's active-window rule.
- `lib/git.ts`: argv builders and parsers for `log` and `diff-tree`.

### 12.4 Push and pull (high unless noted)

- **Nothing native.** No push or pull action in 0.5.9's core (`SRC/fresh-core/src/action.rs`; the only git action is `FileExplorerToggleGitignored`), and none among the bundled plugins' commands. `EP/pkg.ts:574` runs `pull --ff-only` on the package index only.
- **What VS Code runs** (`VS/extensions/git/src/git.ts` ~2601, `repository.ts:2397-2446,2491`, `commands.ts:4059-4175,4386`):
  - Pull: `git pull --tags <upstream remote> <upstream branch>`, with `--autostash` and `-r` only when their settings are on (both off by default). No `--ff`/`--no-rebase`, so the user's `pull.rebase`/`pull.ff` decide; a diverged branch with neither set gets git's error.
  - Push: `git push <upstream remote> <head>:<upstream branch>`; no `--follow-tags` outside Sync.
  - No upstream: push asks to publish, then runs `push -u <remote> <branch>`. One remote is used directly; several give a pick list. No remote: a warning. Detached HEAD: "Please check out a branch to push to a remote."
  - Credentials: VS Code sets `GIT_ASKPASS` to its own askpass (`askpass.ts:38`); it never relies on a terminal.
- **No env, no stdin.** `runOnTarget`, `spawnHostProcess` and `spawnProcess` take program, args, cwd and an output target only (`DTS:8221,8232,8846`); the child's stdin is null (`SRC/fresh-editor/src/app/plugin_dispatch.rs:3886`, `services/remote/spawner.rs:285`), but it can open `/dev/tty`, the editor's pane.
- **So a credential prompt hangs and draws over the editor** (P37 a), and killing the run leaves a helper behind that keeps the handle from settling (P37 b). `env GIT_TERMINAL_PROMPT=0` as argv[0] turns it into a fast failure with git's reason (P37 d); `-c` config cannot (P37 c). ssh needs `BatchMode=yes` and a `ConnectTimeout` (P37 f), through `GIT_SSH_COMMAND` or `-c core.sshCommand=`, either of which replaces a `core.sshCommand` the user has set.
- **Neither may be killed.** A killed push still lands on the remote, with the local tracking ref left stale (P37 g); a killed pull leaves its fetch running and the merge undone (P37 h), and a kill during the merge risks `index.lock` (P16). Both are writes in R11's sense, and fit `runWrite`/`OpQueue`: never killed, "still running" after 60 s, one at a time with stages and commits. R11 lists only stage, unstage and commit as writes today.
- **The title follows.** `↑A ↓B` comes from `# branch.ab` (`lib/status.ts:94-96`), and every queued write asks for a refresh when it ends (`lib/stage.ts:337`). After a push `↑` drops without a fetch; `↓` moves only after a fetch, which pull does (P37 i).
- **Outcomes that need their own message** (P38): no upstream (offer publish), no remote, detached HEAD or a rebase in progress, upstream name mismatch, push rejected (pull first), credentials or connection failures, diverged branches with no pull config, local changes in the way, unmerged files or an unconcluded merge, conflicts after a pull (rc 1 with `CONFLICT` on stdout, then `UU` rows in Changes), and up to date (`Everything up-to-date` on stderr, `Already up to date.` on stdout). Pull with no upstream exits 1, not 128. `--autostash` can exit 0 with conflicts left, so it is not used.

### 12.5 Open

- ~~Whether the graph shows the current branch and its upstream (VS Code's "Auto"), or every branch.~~ The branch and its upstream (spec, decisions).
- ~~Which commit actions the graph offers.~~ Read-only ones: its files, View Commit, Copy Commit ID and Copy Commit Message (spec R32, R33).
- ~~ssh host-key and passphrase prompts under `BatchMode=yes` (UNCONFIRMED live, P37).~~ Confirmed against a local sshd: both fail fast, and `SSH_ASKPASS_REQUIRE=force` with `SSH_ASKPASS=false` stops them in a wrapper that drops BatchMode too (P39 a, b).
- ~~Whether the user's `core.sshCommand` must survive the plugin's ssh options.~~ It does: the plugin resolves git's ssh command itself (`GIT_SSH_COMMAND`, `core.sshCommand`, `GIT_SSH`, `ssh`) and appends the options to it (P39 b, c). A program that is not OpenSSH is left as it is, a documented limit (spec R36).
- Still open: the plugin cannot learn the section's width, so a long row is cut by the host (P36 f).

## 13. Follow-up: where the diff opens, and change markers (2026-11-25)

**Ticket.** "Update git-sidebar: always open diff in top bar, not in utility dock (e.g. like click on a file in file explorer works); if possible mark changes in the diff view's scroll bar or its area, similar to how VS Code does it, so we do not have to scroll the whole file to see how many changes there are (the whole scroll bar height represents the file; mark the corresponding areas red/green for additions and deletions). Explore Fresh, its official plugins' source and its docs to find the best solution."

Sources: `SRC`, `EP`, `DTS` as above; the docs at `sinelaw/fresh` master (`docs/index.md` and the pages it links, copies in `/tmp/fresh-docs-fetch/`), v0.5.9's `docs/`; the user's log `~/.local/state/fresh/logs/fresh-server-80349.log`. Live results are §8 P41.

### 13.1 The diff opens in the active split, which can be the dock (root cause, high)

- **The utility dock** is an ordinary split leaf tagged `SplitRole::UtilityDock`, at most one per window (`SRC/fresh-editor/src/view/split.rs:68,80`; v0.5.9 `docs/internal/buffers-splits-undo.md:79-84`). Alt+`` ` `` opens a terminal there, splitting the root horizontally at 0.7 and making the new leaf active (`app/action_dispatch.rs:2029-2097`); Alt+J moves the keyboard to and from it (`:579`). Diagnostics, find_references, live_grep, search_replace and code-tour put their panels there through `createVirtualBufferInSplit({role: "utility_dock"})` (`app/plugin_dispatch.rs:4307-4320`). The user's log shows them using it (`Opened terminal TerminalId(1) into new dock leaf LeafId(SplitId(9))`).
- **`showBuffer` uses the active split, whatever it is** (`app/plugin_commands.rs:1761-1802` → `set_active_buffer`, `app/active_focus.rs:111-160`). So when the dock was the split last used, the section's diff opens there as a tab beside the terminal (P41 a). A non-hidden `createVirtualBuffer` adds its tab to the active split itself (`plugin_dispatch.rs:4118-4207`), so View Commit's tab lands there before `showBuffer` runs. Upstream master is the same.
- **A file open steers away from the dock.** `open_file_with_kind` calls `redirect_active_split_away_from_dock_if_needed` (`app/file_open_orchestrators.rs:301-325`), which makes the last-focused leaf that is not the dock active, or else the first such leaf in tree order (`app/window/mod.rs:4116-4143`). The File Explorer's click (preview), Enter and double-click all take that path (`app/chrome/file_explorer.rs:83-150,580`; P41 b), and so do the plugin API's `openFile` and `openFileInSplit` (`file_open_orchestrators.rs:265`, `plugin_commands.rs:1660-1687`). So the plugin's View File and Enter in the diff (R7, R19) already avoid the dock.
- **A plugin cannot ask which leaf is the dock.** `SplitSnapshot` and `PaneDescription` carry no role (`fresh-core/src/api.rs:814-874`; P41 c); the role is write-only, at creation. `PaneDescription.kind` is `"terminal"`, `"file"` or `"virtual"`, and `BufferInfo` has `is_terminal` and `splits` (`DTS:911,964`). While a dock exists the editor leaf survives its last tab being closed (`buffer_close.rs:844-859`), and a sole leaf loses the role (`split.rs:1921-1932`), so some non-dock leaf always exists. The dock is created below the rest, at full width.
- **Placing a buffer in a split that is not active** (P41 d): `moveBufferToSplit(bufferId, splitId)` (`DTS:6572`; `split_actions.rs:679-733`) and `setSplitBuffer(splitId, bufferId)` (`DTS:7316`; `plugin_commands.rs:1146-1176`) show it there, leave the active split and the keyboard where they were, and call `set_active_buffer` only when the target is the active split. `moveBufferToSplit` also removes the buffer's tab from other panes. Both are queued: `await editor.flush()` before reading the layout back. `focusSplit` + `showBuffer` + `focusSplit` back promotes the target's preview tab (P41 e), and `createVirtualBufferInExistingSplit` first adds a tab to the active split (`plugin_dispatch.rs:4546-4580`).
- **No bundled plugin has a helper.** audit_mode, live_grep and merge_conflict call `showBuffer` and share the problem. code-tour alone picks a target: the first `describeWorkspace()` pane of `kind === "file"` that is not its own dock leaf, remembered, with `openFile` as the fallback (`EP/code-tour.ts:953-964`).
- **Windows.** Each window has its own split tree, ids from a per-window counter (`split.rs:1273`), and these calls act on the active window. A remembered split id belongs to its section.

### 13.2 No marks on a composite's scrollbar (high)

- `setScrollbarMarkers`, `setScrollbarMarkersInRange` and `clearScrollbarMarkers` are in 0.5.9 (`DTS:7594-7644`, `ScrollbarMarker` at `DTS:3656`; v0.5.9 `docs/plugins/api/overlays.md:562+`), painted as a coloured `▌` on the track of the split that shows the buffer. git_gutter, live_diff and compare_files use them on file buffers.
- **A composite's bar is built without marks.** For a composite buffer, `scrollbar_facts.rs:63-78` builds the vertical bar with `BarFacts::plain(scroll_row, composite.row_count(), …)`, and `plain` sets `marks: []` (`view/shell/buffer_host.rs:610-620`); only other buffers go through `resolve_scrollbar_marks`. Markers on the composite collapse to byte 0 (it holds no text), and the hidden sources keep theirs, but no split draws them (`plugin_commands.rs:2165-2218`). Live: P41 f. Upstream master is the same (`scrollbar_facts.rs:63-77` at `36f2588`), and no issue or PR asks for it.
- **Nothing else drawn from the sources shows in a composite either.** It renders each side from syntax highlighting and its own inline diff; its gutter is a right-aligned line number (`render_composite.rs:147-236,443-455`). Line indicators, overlays and virtual lines on a source are not drawn (P41 g).
- **What a composite can show.** Each pane's header prints its source's `label` as given (`render_composite.rs` ~130), and the tab its `name`. Counts of added and removed lines, and of changes, could go there, from the hunks the plugin already computes. That tells "how many", not "where".

### 13.3 A diff built as a buffer group (high unless noted)

Fresh's own Compare Files (`EP/compare_files.ts`, v0.5.9, 734 lines; `docs/features/compare-files.md`: "Each difference also gets a mark on the scrollbar") is a VS Code-style two-pane diff with scrollbar marks, built without a composite:
- `createBufferGroup(name, mode, layout)` (`DTS:9473`): one tab, two scrollable panels side by side (`compare_files.ts:413-423`). Each panel is a real split, so it gets its own scrollbar, gutter and decorations. A leaf may carry the `bufferId` of an existing buffer, so the plugin's hidden read-only sources can be the panels (P41 h). R21's syntax colours still come from the buffer names.
- `compareBuffers(left, right)` (`DTS:8374`): hunks with each side's byte ranges, each line's range and the intra-line part that differs. It works on read-only virtual buffers (P41 j).
- Per side: `addOverlay` with `diff_add_bg`/`diff_remove_bg`/`diff_modify_bg` over changed lines and `diff_*_highlight_bg` over the intra-line spans (`compare_files.ts:241-250`); `setLineIndicators` `+`/`-`/`~` (`:302-313`); one `setScrollbarMarkers` mark per hunk, a range over its lines, or a point at the seam on the side that has none (`:291-314`), in `[80,200,120]` added, `[220,160,90]` modified, `[220,90,90]` removed (the same as live_diff's; git_gutter's are `[80,250,123]`, `[255,184,108]`, `[255,85,85]`).
- Alignment: empty `addVirtualLine` fillers on the shorter side of each hunk (`:267-289`), and `createScrollSyncGroup` + `setScrollSyncAnchors` with an anchor at each hunk's end (`:326-343,469`). Line wrap off in both panels (`:467-468`).
- Navigation: its own next/previous difference commands (palette, context `compare-active`; Alt+F5 / Shift+Alt+F5 in the global keymap), which set both cursors (`setBufferCursor`) and centre the change (`scrollToLineCenter`) (`:497-565`). Cleanup: on `buffer_group_closed` and `buffer_closed` (`:487-491,692-729`).

All of it works live with the plugin's own sources (P41 h–o): marks on both tracks, fillers, synced scrolling, intra-line highlights, gutter marks, keys bound through the sources' mode, no focus steal. What the composite gives today and a group would need the plugin to do itself:
- **Alignment** (fillers and anchors) and turning line wrap off (R14 "scroll together").
- **The keys** (R20): `n`, `p`, `]`, `[`, `q` and Esc are Fresh's only in a composite (`compositeBuffer` context). In a group they do nothing until the plugin binds them in its mode (P41 k), which the plugin's CLAUDE.md now forbids, for the composite's sake.
- **Next and Previous Change** (R29) on the plugin's own hunk list instead of `compositeNextHunk`.
- **Enter** (R19) reads the cursor of the panel that has the keyboard (P41 n); a cursor on the left panel must be mapped to the right side through the hunks.
- **No leftovers** (R14): a group's close fires only `buffer_group_closed` and leaves the borrowed sources open (P41 m), so the plugin closes them on that event.
- **Two cursors.** Each panel scrolls and has a cursor of its own; a click moves the keyboard between them, and Tab does nothing unless bound.
- **Placement.** A group's tab goes in the active split too, the dock included (P41 l).

### 13.4 Revealing the file in the File Explorer (high unless noted)

Added to the ticket: "when we press on a changed file and open its diff, focus on it in file explorer".

- **No API reveals or selects a path in the explorer**, in 0.5.9 or on master (`36f2588` adds only `addFileExplorerMenuItem`). `setFileExplorerDecorations` and the slot APIs only decorate. No bundled plugin reveals a file.
- **What reveals.** The explorer follows the active file only when a *file-backed* buffer lands in the focused pane (`Window::set_pane_buffer`, `app/window/mod.rs:5568-5577` → `follow_file_explorer_to_active_file`, `app/file_explorer.rs:2827-2836`), and only while `file_explorer.follow_active_buffer` is on (default off, `DTS:4670`), the explorer column is shown, the explorer tree does not have the keyboard, and the file is under the window's root (`follow_path_in_explorer`, `:2801-2815`). A section with the keyboard does not count as the explorer (`app/sidebar.rs:558-561`). A virtual or composite buffer has no path (`app/types/buffer_meta.rs:89-93`), so the diff never reveals anything by itself (P41 q). Switching splits does not follow (`app/active_focus.rs:326-327`).
- **`focus_file_explorer`** (`app/file_explorer.rs:333-348`) reveals the active file without the setting, but it takes the keyboard, shows a hidden explorer, and is an action name, not an API (P41 r).
- **What works from a plugin** (P41 q): preview the file in the diff's split (`previewFileInSplit`), show the diff, and drop the preview (`dismissPreview`), in one synchronous script, with `follow_active_buffer` on. The keyboard stays in the section and no tab is left. Its costs:
  - the file is loaded for the preview, as an explorer click loads it (whether that starts a language server is UNCONFIRMED); a file already open is switched to and back;
  - the status bar says `Opened <path>`, over the plugin's own message;
  - nothing for a deleted file (and a `WARN` in the log, so skip it), a file outside the window's root, or a hidden explorer column (from code).
- **Turning the setting on for the call** (`setSetting`) works, but in 0.5.9 `setSetting` is no scoped layer (despite `DTS`): it patches the whole running config (`app/editor_init.rs:2065-2101`), reloads key bindings, and re-applies the active window's menu, tab and status bar visibility from config, undoing a runtime toggle of those bars, twice per click. It is not written to disk.

### 13.5 Options

| | Where the diff opens | Change overview | Cost |
|---|---|---|---|
| A | The composite moved off the dock with `moveBufferToSplit` (§13.1) | Counts in the pane labels or the tab title; no marks | Small: a target-split rule, and labels from the hunks already computed |
| B | The same rule; a group goes there through `focusSplit` (P41 p) | VS Code-like marks on both scrollbars, plus gutter `+`/`-`/`~` | Large: §13.3's list, and R14, R19, R20, R29 and the CLAUDE.md diff-view invariants rewritten |

Either way the plugin has to choose the target split itself (§13.1), and put the view there: a composite with `moveBufferToSplit` (the active split stays as it was) or, like a group, by `focusSplit(target)` first (the target becomes active, as after a file open from the dock; P41 p). The target: the split already showing its diff; else the last split it saw active while that split showed a file (files never open in the dock, so that is close to the host's last-focused non-dock leaf); else the first `describeWorkspace()` pane of kind `"file"`; else the active split.

### 13.6 Open

- ~~**Placing a buffer group in a split that is not active.**~~ Not possible; `focusSplit(target)` before `createBufferGroup` puts it there and leaves the target active, as a file open from the dock does, with the keyboard still in the section and no preview promoted (P41 p). ~~Not probed: replacing a group already in the target~~: `focusBufferGroupPanel(old, "left")` or `focusSplit(<its split>)`, then the new group, then the old sources closed, both work; the first fires one `active_buffer_changed`, the second also one for the old group (P42 d). With no `flush` between `focusSplit` and the creation, the target's own tab is not announced (P42 k). Not probed: a preview tab in a third split (by the code, `focusSplit` promotes a preview in any split it leaves).
- ~~**An empty side (P42 b).**~~ Fillers do not render in a zero-byte buffer, and an anchor `[0, N]` for an empty left side opens the right pane scrolled past its end, blank, even after the cursors are set and centred. Decided at GATE C: a diff with an empty side is one plain pane of the other side (spec R38 "One side"), a one-panel group with no sync group, which works (P42 l).
- **Which sources a group's close left open** (P42 j): when `buffer_group_closed` comes from a source's close, `getBufferInfo` is already null for that source and not for the other.
- **Events after a placement that is not active (UNCONFIRMED).** `moveBufferToSplit` into a split that is not active fires no `active_buffer_changed` (only `set_active_buffer` announces one, by code). The diff's key hint (`hintFor`), auto-reveal (R23) and the `DIFF_MODE` commands' listing (R29) rely on the active buffer; they may act only once the user clicks into the diff.
- **The target rule is a guess at the host's** (UNCONFIRMED in odd layouts): with no file shown anywhere, or a user's own horizontal split under a single pane, it cannot tell such a split from the dock.

### 13.7 Host behaviour the two-pane diff relies on

Gathered while planning the diff follow-up, from Fresh v0.5.9's source (`SRC`; a bare file name is under `fresh-editor/src/`), the type file (`DTS`) and §8's probes. The plugin's code and tests cite them as H1–H17.

| # | Behaviour | Evidence |
|---|---|---|
| H1 | `createBufferGroup(name, mode, layoutJson)` shows one tab in the **active** split; scrollable leaves with `bufferId` borrow hidden read-only virtual buffers, which keep their own mode; returns `{groupId, panels, panelSplits}` (nested leaves included) | P41 h, l, p; `buffer_groups.rs:186-205,265-281` |
| H2 | `focusSplit(target)` then create (no focus back) puts the group in `target`, keeps the keyboard in the section, promotes no preview in `target`, fires one `active_buffer_changed` | P41 p |
| H3 | `getActiveSplitId()` gives the host split while a panel is focused; `listSplits`/`describeWorkspace` omit a split showing a group tab | P41 n, p; `plugin_dispatch.rs:7293,7546` |
| H4 | Closing a borrowed source closes its group: `buffer_closed` (owned headers) → `buffer_group_closed` → `buffer_closed` (source). User close (× / Close Tab) or `closeBufferGroup` fires only `buffer_group_closed` and leaves sources open. A window close fires only `buffer_closed`s. `closeBufferGroup` acts on the active window's per-window ids | P41 m; `buffer_close.rs:202,340`; `buffer_groups.rs:598,716`; `window_actions.rs:1494-1503` |
| H5 | `compareBuffers(l, r)` → `CompareResult` (`hunks[{left,right,eolOnly}]`, side `{start,count,from,to,jump,lines,spans}`), byte offsets; empty side = `count:0`; equal → `hunks:[]`; rejects if a buffer is binary, too large, or not in the active window | P41 j; `plugin_commands.rs:3072-3150`; `fresh-core/src/diff.rs:229,443,622` |
| H6 | Overlays, `addVirtualLine` fillers, `setLineIndicators`, `setScrollbarMarkers` (RGB; `position`/`end`) draw in panels; `createScrollSyncGroup(id, leftSplit, rightSplit)` + `setScrollSyncAnchors(id, [[lEnd, rEnd]…])` keep them aligned (anchors in 0-based buffer lines, one per hunk end) | P41 i, j; INV §13.3 |
| H7 | Borrowed panels inherit `editor.line_wrap` (on by default) → `setLineWrap(buf, panelSplit, false)` each | `buffer_groups.rs:535-546` |
| H8 | A panel's scrollbar track counts buffer lines only (fillers not counted), so each pane scales marks to its own length | `split_rendering/scrollbar.rs:85-97,202-220` |
| H9 | `defineMode` bindings beat Fresh defaults; key names `Escape`, `BackTab`; a binding may name a built-in action (`scroll_down`/`scroll_up` scroll the focused pane and its sync partner without moving the cursor) | P41 k; `input/keybindings.rs:2368-2379`; `plugin_commands.rs:2552`; `window/mod.rs:5419-5478` |
| H10 | Fixed leaf `{type:"fixed", id, height:1}` inside a vertical split gets an owned, unfocusable, non-scrolling buffer, written with `setPanelContent(groupId, id, entries)` | `buffer_groups.rs:404-431,565-585`; `audit_mode.ts:7436-7441`, `git_log.ts:175-189` |
| H11 | `getPrimaryCursor()`/`getCursorLine()` read the focused panel; `setBufferCursor(buf, byte)` and `scrollToLineCenter(split, buf, line)` move/centre | P41 k, n |
| H12 | A terminal buffer has a path (its scrollback file), so `getBufferPath` ≠ `""` does not mean a file. `getBufferInfo(id).is_virtual` is true for terminals and plugin buffers, false for files | `app/terminal.rs:563-567`; `DTS:900-912` |
| H13 | A scroll sync group is removed automatically when either pane closes; its id must be unique **per plugin** (split ids repeat across windows) | `DTS:7795-7801`; `view/scroll_sync.rs:310-323` |
| H14 | `closeBuffer` on an id already closed logs `ERROR Failed to close buffer` (bumps the warning count, §8 P29) | `app/plugin_commands.rs:1815-1821` |
| H15 | `BufferInfo.splits` lists only splits where the buffer is the visible tab | `view/split.rs:1749-1756` |
| H16 | Hooks such as `active_buffer_changed` come from a once-per-frame focus announcement, only when the (window, buffer) changes; `focusSplit` fires none itself. A frame between `focusSplit` and the group's creation announces the target's own tab | `app/active_focus.rs:288-322`; `focus_announcer.rs:107-185` |
| H17 | `compareBuffers` splits lines keeping their `\n` (`split_inclusive`), so the texts compared must be the exact file texts, not ones with the final newline dropped | `fresh-core/src/diff.rs:443-445` |
