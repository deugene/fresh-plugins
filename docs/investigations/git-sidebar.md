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

- **A click on the already-selected group row does nothing.** With `toggleOnClick:true`, a row-body click toggles a group only when that click also moves the selection onto it. Clicking the selected group row again emits no `widget_event` at all and does not toggle (probe log: `expand {"index":2,"key":"g:c","expanded":false}` for the first click on `Changes`, nothing for the second; `focus` only, for a first click that lands on the selected row while the section is blurred). The disclosure column of a selected row draws the selection bar `▌`, so there is no glyph to click either. Keyboard Left/Right/Enter/Space always work. Host behaviour in 0.5.9; the plugin receives nothing to act on.
