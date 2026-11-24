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

## 9. Follow-up: opening, diffs, staging and the title (2026-11-24)

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
- **Windows and the rows context (not fixable in 0.5.9).** `setContext` acts on the active window, so with several windows the palette commands follow whichever window was active when the context last changed. The reload half is fixed: load clears a context a previous load left set.
- **Status that is not UTF-8 in a bind-mounted dev container (found, not fixed).** Through `spawnHostProcess`, a status whose output holds one path that is not UTF-8 comes back as `""` with rc 0 (§8 P17). The section then shows empty groups and the title `Git · HEAD`. `runOnTarget` (local) is lossy instead, and the rows show U+FFFD.
- **Lossy text of the same length (low).** A blob refusal compares UTF-8 lengths. A blob in which three bad bytes become one U+FFFD (3 bytes), such as a truncated 4-byte sequence, keeps its length and is shown with U+FFFD in it.
- **Untracked symbolic links.** `?` records carry no mode, so an untracked link's diff shows its target's contents (README Limits).
