// git-sidebar: a "Git" section under the file explorer with the current
// branch and two groups, Staged Changes and Changes, kept current.
//
// This file only wires the editor to the pure pieces in lib/: status parsing
// (status.ts), the tree (view.ts), refresh timing (scheduler.ts) and where
// git runs (git.ts). Collapsing the whole section, its height and its
// position belong to the host; the plugin keeps the section mounted and
// updates it in place.

import { parseStatus, title as statusTitle } from "./lib/status.ts";
import {
  buildTree,
  CHANGES_KEY,
  directoryKeys,
  noticeTree,
  rowKind,
  signature,
  STAGED_KEY,
  TREE_KEY,
  UNKNOWN_NOTICE,
  VOLUME_NOTICE,
  type TreeSpec,
} from "./lib/view.ts";
import { Scheduler, SingleTimer } from "./lib/scheduler.ts";
import {
  containerId,
  detectMode,
  isDefinitiveFailure,
  run,
  runOn,
  STATUS_ARGS,
  TOPLEVEL_ARGS,
  trimSlash,
  type Detected,
  type GitResult,
  type Mode,
  type Runner,
} from "./lib/git.ts";

const editor = getEditor();

const PANEL = 1;
const TICK = "gitSidebarTick";
/** Title before the first status, and in volume mode. */
const BARE_TITLE = "Git";

/** The section belongs to the window active at load (spec, out of scope:
 *  multiple windows), and so does the workspace it shows. Both are read once:
 *  the host re-scopes a section on every mount, and `getCwd()` follows the
 *  active window. */
const homeWindow = editor.activeWindow();
const workspace = editor.getCwd();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Where git runs; null while it must be (re)detected before the next run:
 *  at load, after every authority or trust change, and while detection keeps
 *  failing. */
let mode: Mode | null = null;
/** Repository top level, as a host path; null until resolved. Attaching or
 *  detaching does not move host paths (INV §7), so it survives both. */
let root: string | null = null;
/** Where the section is in its life:
 *  - pending: nothing shown since load or the last authority change, so a
 *    definitive failure takes the section down (R1);
 *  - shown: rows or the volume notice were shown, and a failure keeps them (R10);
 *  - gaveUp: git failed for good while pending; quiet until the authority or
 *    the workspace trust changes (R1);
 *  - ended: the host removed the section (its window closed); nothing more, ever. */
let phase: "pending" | "shown" | "gaveUp" | "ended" = "pending";
/** Bumped on every authority or trust change and at the end, so a run
 *  started before it is ignored. */
let epoch = 0;

/** What the section draws now, or null when it is not mounted. The title is
 *  fixed per mount; an equal signature means no widget calls. */
let shown: { title: string; sig: string } | null = null;
/** The status output `shown` and `dirKeys` were built from; null when the
 *  section shows anything else. */
let shownFrom: string | null = null;
/** Group expansion, owned here because a remount resets the host's. */
const expanded = new Set<string>([STAGED_KEY, CHANGES_KEY]);
/** The selected row by key, and the host's index for it. The host keeps a
 *  selection by index, so rows inserted above it would move it (R10). */
let selectedKey: string | null = null;
let selectedIndex = -1;
/** File-group keys of the rows shown now that are directories. */
let dirKeys = new Set<string>();

const sched = new Scheduler();
const timer = new SingleTimer(
  (ms) => editor.setTimeout(ms, TICK),
  (id) => {
    editor.clearInterval(id);
  },
);

const runner: Runner = editor;

function log(msg: string): void {
  editor.debug(`git-sidebar: ${msg}`);
}

/** `fn` with anything it throws logged: nothing may throw into the host. */
function guarded<A extends unknown[]>(name: string, fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args);
    } catch (e) {
      log(`${name} threw: ${String(e)}`);
    }
  };
}

/** `guarded` for async work: the promise it returns never rejects. */
function guardedAsync(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      log(`${name} threw: ${String(e)}`);
    }
  };
}

/** Whether the workspace looks like a repository: a `.git` in it or in a
 *  folder above it, on the host. */
function looksLikeRepo(): boolean {
  for (let d = workspace, prev = ""; d !== "" && d !== prev; prev = d, d = editor.pathDirname(d)) {
    if (editor.fileExists(editor.pathJoin(d, ".git"))) return true;
  }
  return false;
}

/** Whether git may run: not ended, not given up, and not a volume. */
function active(): boolean {
  return phase !== "ended" && phase !== "gaveUp" && mode !== "volume";
}

function arm(): void {
  timer.arm(phase === "ended" ? null : sched.nextDue(), Date.now());
}

function requestRefresh(): void {
  if (!active()) return;
  sched.requestUrgent(Date.now());
  arm();
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

function mutate(m: WidgetMutation): void {
  editor.widgetMutate(PANEL, m);
}

/** Where the selection belongs in `keys`: its key's row, or — when that row
 *  is gone — whatever row the host's index now points at, clamped to the
 *  rows there are. */
function reconcileSelection(keys: string[]): { key: string | null; index: number } {
  if (selectedKey === null) return { key: null, index: -1 };
  const idx = keys.indexOf(selectedKey);
  if (idx >= 0) return { key: selectedKey, index: idx };
  const kept = Math.min(selectedIndex, keys.length - 1);
  return kept >= 0 ? { key: keys[kept], index: kept } : { key: null, index: -1 };
}

function pushSelection(index: number): void {
  mutate({ kind: "setSelectedIndex", widgetKey: TREE_KEY, index });
}

function pushExpanded(): void {
  mutate({ kind: "setExpandedKeys", widgetKey: TREE_KEY, keys: [...expanded] });
}

/**
 * Draw `spec` under `title`; whether the section now shows it (false: the
 * host refused, and the next refresh tries again).
 *
 * A first mount or a new title (the title is fixed per mount) remounts. The
 * host keeps a same-id section's place, height and collapsed state, but
 * resets its tree to the spec's seeds — so seed them, then push them. Every
 * mount passes all three options: a remount without them reverts to a
 * closable section that takes focus, scoped to whatever window is active
 * then. No focus is ever asked for: the host's "focus" reveals a hidden
 * explorer column and a collapsed section.
 */
function show(title: string, spec: TreeSpec, notice = false): boolean {
  const sig = signature(title, spec);
  if (shown?.sig === sig) return true;
  const sel = reconcileSelection(spec.itemKeys);
  // Seeds that agree with what the plugin believes, on every spec sent.
  spec.selectedIndex = sel.index;
  spec.expandedKeys = [...expanded];
  const remount = shown?.title !== title;
  const ok = remount
    ? editor.mountSidebarSection(PANEL, spec, title, 0, {
        closable: false,
        startBlurred: true,
        scope: { window: homeWindow },
      })
    : editor.updateFloatingWidget(PANEL, spec);
  if (ok === false) {
    log(`${remount ? "mountSidebarSection" : "updateFloatingWidget"} returned false; retrying on the next refresh`);
    return false;
  }
  const prevIndex = selectedIndex;
  shown = { title, sig };
  // A notice row stands in for the rows, not for the selected file: keep
  // the file's key, so it is selected again when the rows come back (R10).
  if (!notice) selectedKey = sel.key;
  selectedIndex = sel.index;
  if (remount) pushExpanded();
  // The host carries its index across updates unclamped: push any move.
  if (sel.index >= 0 && (remount || sel.index !== prevIndex)) pushSelection(sel.index);
  return true;
}

function showStatus(stdout: string): void {
  const status = parseStatus(stdout);
  dirKeys = directoryKeys(status);
  // `dirKeys` follows this output even when the host refuses it, so only an
  // output that is on screen may be skipped next time.
  shownFrom = show(statusTitle(status), buildTree(status)) ? stdout : null;
}

function showNotice(text: string): void {
  dirKeys = new Set();
  shownFrom = null;
  show(BARE_TITLE, noticeTree(text), true);
}

// ---------------------------------------------------------------------------
// Refreshing
// ---------------------------------------------------------------------------

/** Drop pending work and forget what is shown, taking the section down
 *  first when `unmount` (the host has not already removed it) — even one
 *  this instance never mounted: the host keeps a section across a plugin
 *  reload (INV §2), and unmounting an id that is not mounted is a no-op. */
function stop(unmount: boolean): void {
  sched.cancel();
  if (unmount) editor.unmountFloatingWidget(PANEL);
  shown = null;
  shownFrom = null;
}

function failed(what: string, r: GitResult): void {
  log(`${what} failed (code ${r.code}${r.timedOut ? ", timed out" : ""}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  // Once something is shown, keep the last good result (R10). A slow or
  // flaky git keeps the placeholder and is asked again; the scheduler's gap
  // spaces the retries.
  if (phase !== "pending" || !isDefinitiveFailure(r)) return;
  // Not a repository, or git cannot run, and nothing shown yet: no section
  // and no error (R1). The placeholder mounted at load goes away; retry when
  // the authority or the trust changes.
  phase = "gaveUp";
  stop(true);
}

/** Where git runs now, or null when a restart or the end overtook the
 *  detection. */
async function detect(myEpoch: number): Promise<Detected | null> {
  const label = editor.getAuthorityLabel();
  const id = containerId(label);
  let pwd: GitResult | null = null;
  let inspect: GitResult | null = null;
  if (id !== null) {
    // The container's workspace folder: with no cwd the docker spawner runs
    // in `-w <remoteWorkspaceFolder>`.
    pwd = await runOn(runner, "target", "pwd", [], "");
    if (myEpoch !== epoch) return null;
    if (pwd.code === 0) {
      inspect = await runOn(runner, "host", "docker", ["inspect", id, "--format", "{{json .Mounts}}"], workspace);
      if (myEpoch !== epoch) return null;
    }
  }
  const d = detectMode(label, workspace, pwd, inspect);
  log(`mode ${d.mode}: ${d.reason}`);
  return d.mode;
}

async function refresh(myEpoch: number): Promise<void> {
  let m = mode;
  if (m === null) {
    const d = await detect(myEpoch);
    if (d === null || myEpoch !== epoch) return;
    if (d === "unknown") {
      // Never the host's rows while that may be the wrong folder (R13). With
      // no section up and no repository on the host there are no rows to
      // hide, and a notice would be a section outside a repository (R1):
      // stay quiet. The mode stays unknown, to be asked again on the next tick.
      if (shown !== null || looksLikeRepo()) showNotice(UNKNOWN_NOTICE);
      return;
    }
    m = mode = d;
  }
  if (m === "volume") {
    // The host folder's status is not the container's, and Fresh cannot
    // open the volume's files (INV §8): no git, one notice row (R13).
    phase = "shown";
    showNotice(VOLUME_NOTICE);
    return;
  }
  if (root === null) {
    const r = await run(runner, m, "git", TOPLEVEL_ARGS, workspace);
    if (myEpoch !== epoch) return;
    if (r.code !== 0 || !r.stdout.trim()) return failed("rev-parse", r);
    root = r.stdout.trim();
  }
  const r = await run(runner, m, "git", STATUS_ARGS, root);
  if (myEpoch !== epoch) return;
  if (r.code !== 0) return failed("status", r);
  phase = "shown";
  // The output on screen already: nothing to parse or build (R10).
  if (r.stdout === shownFrom) return;
  showStatus(r.stdout);
}

const refreshNow = guardedAsync("refresh", () => refresh(epoch));

const reArm = guarded("re-arm", (started: number) => {
  const end = Date.now();
  sched.finish(end, end - started);
  // The scheduler reads polling only when the next run is due, from here on.
  sched.setPolling(active());
  arm();
});

registerHandler(
  TICK,
  guarded("tick", () => {
    if (phase === "ended") return;
    timer.fired();
    const started = Date.now();
    if (!sched.tryStart(started)) {
      arm();
      return;
    }
    void refreshNow().then(() => reArm(started));
  }),
);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function end(): void {
  phase = "ended";
  epoch++;
  stop(false);
  arm();
}

function toggleGroup(key: string): void {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  pushExpanded();
}

function activate(key: string): void {
  const row = rowKind(key);
  if (row.kind === "group") {
    // The host does not toggle a group on Enter; activation does (R7).
    toggleGroup(key);
    return;
  }
  if (row.kind !== "file" || root === null) return;
  if (dirKeys.has(key)) {
    editor.setStatus(`git-sidebar: ${trimSlash(row.path)} is a directory (submodule or nested repository)`);
    return;
  }
  const path = editor.pathJoin(root, row.path);
  // openFile on a missing path would create a new buffer, and `fileExists`
  // is true for a directory too (a deleted file's path reused by one, a
  // symlink to one).
  const stat = editor.fileStat(path) as { isFile?: unknown; isDir?: unknown } | null;
  if (stat?.isFile === true) editor.openFile(path);
  else if (stat?.isDir === true) editor.setStatus(`git-sidebar: ${row.path} is a directory`);
  else editor.setStatus(`git-sidebar: ${row.path} is deleted`);
}

editor.on(
  "widget_event",
  guarded("widget_event", (e: HookEventMap["widget_event"]) => {
    if (e.panel_id !== PANEL) return;
    const p = (e.payload ?? {}) as { index?: unknown; key?: unknown; expanded?: unknown };
    const key = typeof p.key === "string" ? p.key : null;
    const index = typeof p.index === "number" ? p.index : null;
    const select = () => {
      if (key === null || index === null) return;
      selectedKey = key;
      selectedIndex = index;
    };
    switch (e.event_type) {
      case "cancel":
        // The host removed the section: with `closable: false` that happens
        // only when its window closed. Stop for good.
        end();
        return;
      case "select":
        select();
        return;
      case "expand":
        if (key !== null && p.expanded === true) expanded.add(key);
        if (key !== null && p.expanded === false) expanded.delete(key);
        select();
        return;
      case "activate":
        select();
        if (key !== null) activate(key);
        return;
    }
  }),
);

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** The authority or the workspace trust changed. A run in flight belongs to
 *  the old one. Attach or detach (`forget`) keeps the window and the
 *  section, but what was known is about the other side: where git runs must
 *  be found out again (R13), and a definitive failure now takes the section
 *  down (R1). A trust change moves no mount, so a mode already found stands
 *  (one that trust blocked was never found); it only lifts a give-up: a run
 *  it blocked may now be allowed. */
function restart(forget: boolean): void {
  if (phase === "ended") return;
  epoch++;
  if (forget) mode = null;
  if (forget || phase === "gaveUp") phase = "pending";
  requestRefresh();
}

const onChange = guarded("trigger", requestRefresh);
editor.on("after_file_save", onChange);
editor.on("after_file_revert", onChange);
editor.on("focus_gained", onChange);
editor.on("after_file_explorer_change", onChange);
editor.on("authority_changed", guarded("authority_changed", () => restart(true)));
editor.on("trust_changed", guarded("trust_changed", () => restart(false)));

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

// Mount now when the workspace looks like a repository: a section mounted
// later than a few frames after startup loses the divider the user dragged
// (INV §8, P2). Rows follow from the first status; if git then fails, the
// section goes away again.
guarded("load", () => {
  if (looksLikeRepo()) show(BARE_TITLE, buildTree(null));
  requestRefresh();
})();
