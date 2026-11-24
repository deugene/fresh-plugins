// git-sidebar: a "Git" section under the file explorer with the current
// branch and two groups, Staged Changes and Changes, kept current. A click
// or Enter on a file opens its side-by-side diff (R14); `+`/`−` and Space
// stage and unstage (R15, R16); a right-click opens the row's menu (R17);
// the palette has the same commands (R18).
//
// This file only wires the editor to the pure pieces in lib/: status parsing
// (status.ts), the tree (view.ts), what each row offers (actions.ts), the
// diff view (diff.ts), staging (stage.ts), refresh timing (scheduler.ts) and
// where git runs (git.ts). Collapsing the whole section, its height and its
// position belong to the host; the plugin keeps the section mounted and
// updates it in place.

import { parseStatus, title as statusTitle, unpassable, type Status } from "./lib/status.ts";
import {
  anchorArg,
  badName,
  buttonLabel,
  dirReason,
  menuChoice,
  menuItems,
  menuSpec,
  nameReason,
  NO_ROWS,
  paletteTarget,
  rowAction,
  type PaletteCommand,
} from "./lib/actions.ts";
import {
  classifyWrite,
  OpQueue,
  skippedMessage,
  stageAllPlan,
  stageArgs,
  unstageAllPlan,
  unstageArgs,
  type GroupPlan,
} from "./lib/stage.ts";
import {
  blobRefusal,
  compositeHunks,
  contentToEntries,
  DiffSlot,
  paneLabels,
  refusal,
  refusalMessage,
  rowRefusal,
  sides,
  sizeRefusal,
  tabTitle,
  type Refusal,
  type Side,
  type View,
} from "./lib/diff.ts";
import {
  buildTree,
  CHANGES_KEY,
  entryMap,
  noticeTree,
  placeOf,
  reconcile,
  rowKind,
  signature,
  STAGED_KEY,
  TREE_KEY,
  UNKNOWN_NOTICE,
  VOLUME_NOTICE,
  type EntryMap,
  type Place,
  type TreeSpec,
} from "./lib/view.ts";
import { Scheduler, SingleTimer } from "./lib/scheduler.ts";
import {
  blobArgs,
  blobIdArgs,
  blobSizeArgs,
  containerId,
  detectMode,
  gitReason,
  isDefinitiveFailure,
  objectId,
  run,
  runOn,
  runWrite,
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
/** The right-click menu (R17): a floating panel of its own. Its `cancel`
 *  (Esc, a click outside) closes only the menu, never the section. */
const MENU = 2;
const TICK = "gitSidebarTick";
/** The diff view's keymap: none of its own, read-only (R14). */
const DIFF_MODE = "git-sidebar-diff";
/** Set while the section shows status rows: the palette commands are
 *  listed only then (R18, INV §8 P11). */
const ROWS_CONTEXT = "git-sidebar-rows";
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
/** Group expansion, owned here because a remount resets the host's. */
const expanded = new Set<string>([STAGED_KEY, CHANGES_KEY]);
/** The selected row by key, the host's index for it, and its place in its
 *  group. The host keeps a selection by index, so rows inserted above it
 *  would move it (R10); when the row goes, the selection stays at its place
 *  in its group (`reconcile`). */
let selectedKey: string | null = null;
let selectedIndex = -1;
let selectedPlace: Place | null = null;
/** The item keys drawn now, which the host's indexes refer to. */
let shownKeys: string[] = [];
/** The status rows shown now: the status they were built from, its file
 *  rows by key with their entry and group, and the status output itself
 *  (`raw`), so a refresh with the same output builds nothing (R10). Null
 *  under a notice, the placeholder, or no section. Every row action and
 *  palette command reads this, so none acts on rows that are not on screen
 *  (R13, R18). ROWS_CONTEXT is set exactly while it is not null. */
let rows: { status: Status; entries: EntryMap; raw: string } | null = null;
/** No rows: what a lookup in the rows sees under a notice. */
const NO_ENTRIES: EntryMap = new Map();
/** The one diff view (R14). */
const slot = new DiffSlot();
/** The row the open menu is for, or null when no menu is open. */
let menuFor: string | null = null;

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

/** A status message for the user. No `git-sidebar:` prefix, as in Fresh's
 *  own plugins: the status bar cuts a long message at its width, and
 *  git's reason, which matters most, comes last. Debug lines keep it. */
function say(msg: string): void {
  editor.setStatus(msg);
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

/** Record the row the host says is selected now. */
function recordSelection(key: string, index: number): void {
  selectedKey = key;
  selectedIndex = index;
  selectedPlace = placeOf(shownKeys, key);
}

/** Replace the rows shown, setting ROWS_CONTEXT when they come or go. */
function setRows(next: typeof rows): void {
  if ((rows === null) !== (next === null)) editor.setContext(ROWS_CONTEXT, next !== null);
  rows = next;
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
  const sel = reconcile(selectedKey, selectedPlace, selectedIndex, spec.itemKeys);
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
  shownKeys = spec.itemKeys;
  // A notice row stands in for the rows, not for the selected file: keep
  // the file's key and place, so it is selected again when the rows come
  // back (R10).
  if (!notice) {
    selectedKey = sel.key;
    selectedPlace = sel.key === null ? null : placeOf(spec.itemKeys, sel.key);
  }
  selectedIndex = sel.index;
  if (remount) pushExpanded();
  // The host carries its index across updates unclamped: push any move.
  if (sel.index >= 0 && (remount || sel.index !== prevIndex)) pushSelection(sel.index);
  return true;
}

/** Draw a status; whether the section now shows it. */
function showStatus(stdout: string): boolean {
  const status = parseStatus(stdout);
  const entries = entryMap(status);
  // The host refused it: the rows, their entries and the palette context
  // stay those of the status still on screen (R13, R18), and the next
  // refresh, whose output differs from theirs, draws this one again.
  if (!show(statusTitle(status), buildTree(status, (key) => buttonLabel(key, status, entries)))) return false;
  setRows({ status, entries, raw: stdout });
  return true;
}

function showNotice(text: string): void {
  // No row action may run against rows that are not shown: in volume mode
  // that would be host git on the wrong folder (R13).
  setRows(null);
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
  setRows(null);
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
  const seq = ops.writeSeq;
  const r = await run(runner, m, "git", STATUS_ARGS, root);
  if (myEpoch !== epoch) return;
  // A stage or unstage finished while this status ran: it may predate the
  // write, so it is not drawn. The write asked for the refresh that is.
  if (ops.writeSeq !== seq) return;
  if (r.code !== 0) {
    // The rows on screen stay (R10), perhaps through many failed statuses:
    // a press on them acts again rather than being dropped in silence.
    ops.release(seq);
    return failed("status", r);
  }
  phase = "shown";
  // The output on screen already: nothing to parse or build (R10). A status
  // the host refused to draw releases nothing: its rows are not on screen,
  // and the next refresh draws it again.
  if (r.stdout === rows?.raw || showStatus(r.stdout)) ops.release(seq);
}

const refreshNow = guardedAsync("refresh", () => refresh(epoch));

/** One user-requested write at a time; each asks for a refresh when done
 *  (R15). Writes run outside the scheduler, so they are not part of its
 *  25% budget (R11). */
const ops = new OpQueue(guarded("write done", requestRefresh));

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
  menuFor = null;
  epoch++;
  slot.invalidate();
  stop(false);
  arm();
}

function toggleGroup(key: string): void {
  if (expanded.has(key)) expanded.delete(key);
  else expanded.add(key);
  pushExpanded();
}

/** While the mode is being found again (after an attach or detach) git
 *  would run in the wrong place (R13). */
const FINDING_MODE = "finding out where git runs; try again in a moment";

/** What a row action runs against: the rows shown, the root and where git
 *  runs; or why none can run now. Under a notice or the placeholder there
 *  are no rows to act on. */
type Readiness = { why: string } | { status: Status; entries: EntryMap; root: string; mode: Exclude<Mode, "volume"> };

function readiness(): Readiness {
  if (rows === null || root === null) return { why: NO_ROWS };
  if (mode === null) return { why: FINDING_MODE };
  if (mode === "volume") return { why: "the sources are in a container volume" };
  return { status: rows.status, entries: rows.entries, root, mode };
}

/** View File (R7): open the row's file as a tab. Reached from the menu
 *  (R17) and the palette (R18) only; no gesture on a row opens the file
 *  itself. */
function viewFile(key: string): void {
  const row = rowKind(key);
  if (row.kind !== "file" || root === null) return;
  if (rows?.entries.get(key)?.entry.dir === true) {
    say(dirReason(trimSlash(row.path)));
    return;
  }
  // Status names it lossily (F6): the path names no file, so the stat below
  // would call it deleted.
  if (unpassable(row.path)) {
    say(nameReason(row.path));
    return;
  }
  const path = editor.pathJoin(root, row.path);
  // openFile on a missing path would create a new buffer, and `fileExists`
  // is true for a directory too (a deleted file's path reused by one, a
  // symlink to one).
  const stat = editor.fileStat(path) as { isFile?: unknown; isDir?: unknown } | null;
  if (stat?.isFile === true) editor.openFile(path);
  else if (stat?.isDir === true) say(`${row.path} is a directory`);
  else say(`${row.path} is deleted`);
}

/** One side's text, why it is refused, or why it could not be read; null
 *  when the build went stale while reading. */
type SideRead = { text: string } | { refused: Refusal } | { failed: string } | null;

async function readSide(side: Side, m: Mode, r: string, stale: () => boolean): Promise<SideRead> {
  if (side.kind === "empty") return { text: "" };
  if (side.kind === "worktree") {
    const abs = editor.pathJoin(r, side.path);
    // Only a regular file has a side: a deleted path, or one that is now a
    // directory, diffs against an empty side rather than being refused.
    const stat = editor.fileStat(abs) as { isFile?: unknown; size?: unknown } | null;
    if (stat?.isFile !== true) return { text: "" };
    const tooLarge = sizeRefusal(typeof stat.size === "number" ? stat.size : 0);
    if (tooLarge !== null) return { refused: tooLarge };
    // Not valid UTF-8 reads as `undefined` in 0.5.9, not the declared null
    // (seen live on a PNG; INV §8 P8 saw the same for a missing file). Any
    // other read error does too, and gives no reason.
    const read: unknown = editor.readFile(abs);
    if (typeof read !== "string") {
      // Gone since the stat: an empty side, as for a file gone before it.
      const again = editor.fileStat(abs) as { isFile?: unknown } | null;
      return again?.isFile === true ? { refused: "unreadable" } : { text: "" };
    }
    const why = refusal(read);
    return why !== null ? { refused: why } : { text: read };
  }
  // A git object, read through the runner like every git run, so a
  // bind-mounted dev container reads it on the host (R13). By its id, so
  // the size and the text are the same blob's (`blobIdArgs`).
  const named = await run(runner, m, "git", blobIdArgs(side.spec), r);
  if (stale()) return null;
  const oid = named.code === 0 ? objectId(named.stdout) : null;
  if (oid === null) return { failed: gitReason(named, r) };
  const sized = await run(runner, m, "git", blobSizeArgs(oid), r);
  if (stale()) return null;
  if (sized.code !== 0) return { failed: gitReason(sized, r) };
  const size = Number(sized.stdout.trim());
  // The size guards the read: a side too large is never read.
  const tooLarge = sizeRefusal(size);
  if (tooLarge !== null) return { refused: tooLarge };
  const blob = await run(runner, m, "git", blobArgs(oid), r);
  if (stale()) return null;
  if (blob.code !== 0) return { failed: gitReason(blob, r) };
  // Not UTF-8 comes back as other text, not null (R14).
  const why = blobRefusal(blob.stdout, size);
  return why !== null ? { refused: why } : { text: blob.stdout };
}

/** Drop a diff view's buffers: the composite's state first, when there is
 *  a composite, then each of `ids`. `closeCompositeBuffer` only drops the
 *  composite's state, and the buffer stays as an empty tab until
 *  `closeBuffer` closes it (INV §9.4, P9 c). Nothing else drops that state,
 *  so a user's close calls it too (P19). */
function dropView(composite: number | null, ids: number[]): void {
  if (composite !== null) editor.closeCompositeBuffer(composite);
  for (const id of ids) editor.closeBuffer(id, true);
}

/** Close a diff view the plugin made: the composite and both sources. */
function closeView(v: View): void {
  dropView(v.composite, [v.composite, v.left, v.right]);
}

/**
 * Open the row's side-by-side diff in the active split, replacing the one
 * shown (R14). The tab opens in the split that was active before the click,
 * and focus stays in the section (INV §8, P9 a, b). Every await re-checks
 * the epoch and the slot's generation; a stale build closes what it made.
 */
async function openDiff(key: string): Promise<void> {
  const ready = readiness();
  if ("why" in ready) {
    say(ready.why);
    return;
  }
  const { status, entries, root: r, mode: m } = ready;
  const listed = entries.get(key);
  if (listed === undefined) return;
  const path = trimSlash(listed.entry.path);
  // A directory, a name that is not UTF-8 (F6), or a symbolic link.
  const refused = rowRefusal(listed.entry, listed.group);
  if (refused !== null) {
    // This click is the latest: a slower build for an earlier click must
    // not open its diff after this message (R14 "each later click").
    slot.invalidate();
    say(refusalMessage(refused === "unpassable name" ? badName(listed.entry) : path, refused));
    return;
  }
  const gen = slot.begin(key);
  // The same row's build is pending: a double-click (INV §9.1) joins it.
  if (gen === null) return;
  const myEpoch = epoch;
  const stale = () => myEpoch !== epoch || !slot.isCurrent(gen);
  try {
    const { left, right } = sides(listed.entry, listed.group, status.oid === null);
    // Both sides at once; a git object's side reads its id, its size, then
    // its content.
    const got = await Promise.all([readSide(left, m, r, stale), readSide(right, m, r, stale)]);
    if (stale()) return;
    // Judged left, then right.
    const reads: { text: string }[] = [];
    for (const side of got) {
      if (side === null) return;
      if ("refused" in side) {
        say(refusalMessage(path, side.refused));
        return;
      }
      if ("failed" in side) {
        say(`could not read ${path}: ${side.failed}`);
        return;
      }
      reads.push(side);
    }
    // One text per side feeds both its buffer and the line diff, as in
    // git-review and audit_mode; the buffer drops the final newline once,
    // in `contentToEntries` (R14).
    const [leftText, rightText] = reads.map((x) => x.text);
    const [leftLabel, rightLabel] = paneLabels(listed.group, listed.entry);
    // Hidden, read-only sources: the diff is a snapshot, not an editor (R14).
    const source = (label: string, text: string) =>
      editor.createVirtualBuffer({
        name: `*${label}: ${path}*`,
        mode: DIFF_MODE,
        readOnly: true,
        editingDisabled: true,
        hiddenFromTabs: true,
        showLineNumbers: true,
        entries: contentToEntries(text),
      });
    // One at a time, each id kept as it comes: until the slot has the view,
    // nothing else knows these buffers, so a call that throws or rejects
    // part-way closes what was made (R14 "no leftovers").
    const made: number[] = [];
    let view: View;
    try {
      const a = (await source(leftLabel, leftText)).bufferId;
      made.push(a);
      if (stale()) {
        dropView(null, made);
        return;
      }
      const b = (await source(rightLabel, rightText)).bufferId;
      made.push(b);
      if (stale()) {
        dropView(null, made);
        return;
      }
      // An empty side gets hunks that cover its phantom line (INV §8 P22).
      const hunks = compositeHunks(leftText, rightText, () => editor.computeLineDiff(leftText, rightText));
      const pane = (bufferId: number, label: string) => ({ bufferId, label, editable: false, style: { gutterStyle: "both" } });
      const opts: TsCreateCompositeBufferOptions = {
        name: tabTitle(path, listed.group, listed.entry),
        mode: DIFF_MODE,
        layout: { type: "side-by-side", ratios: [0.5, 0.5], showSeparator: true },
        sources: [pane(a, leftLabel), pane(b, rightLabel)],
        // Always the list, even empty: with null the host builds no line
        // alignment and draws neither pane (Fresh 0.5.9,
        // composite_buffer_actions.rs:1190-1231; seen live on an R100 rename).
        hunks,
      };
      if (hunks.length > 0) opts.initialFocusHunk = 0;
      view = { composite: await editor.createCompositeBuffer(opts), left: a, right: b };
    } catch (e) {
      dropView(null, made);
      throw e;
    }
    const { composite } = view;
    if (stale()) {
      closeView(view);
      return;
    }
    // Show the new view, then close the one it replaces: one tab (R14).
    const prev = slot.install(view);
    editor.showBuffer(composite);
    if (prev !== null) closeView(prev);
  } finally {
    slot.done(gen);
  }
}

/** Stage or unstage the row `key`, as its button or Space asks (R15). */
function rowOp(key: string): void {
  const action = rowAction(key, rows?.status ?? null, rows?.entries ?? NO_ENTRIES);
  // An empty group, or any group before the first status: nothing to do,
  // and nothing to say (R16).
  if (action.kind === "none" && rowKind(key).kind === "group") return;
  const ready = readiness();
  if ("why" in ready) {
    say(ready.why);
    return;
  }
  if (action.kind === "none") {
    // A conflicted or directory row says why; an empty group or the
    // `… N more` row does nothing.
    if (action.reason !== null) say(action.reason);
    return;
  }
  // The epoch the request was made in: a write that waited in the queue
  // across a restart does not run (`stillAsked`).
  const asked = epoch;
  if (action.kind === "stageAll" || action.kind === "unstageAll") {
    const all = action.kind;
    if (ops.enqueue(key, guardedAsync(all, () => groupWrite(all, asked))) === null) log(`${all}: already asked for`);
    return;
  }
  const { entries } = ready;
  const listed = entries.get(key);
  if (listed === undefined) return;
  // Built from the rows on screen, which a queued write or the user may
  // have overtaken by the time it runs; each command takes the working
  // tree's state of its paths when it runs, so it still does what R15 says
  // (`stageArgs`, INV §8 P23).
  const commands = action.kind === "stage" ? stageArgs(listed.entry) : unstageArgs(listed.entry);
  const verb = action.kind;
  const path = trimSlash(listed.entry.path);
  const queued = ops.enqueue(key, guardedAsync(verb, () => write(commands, `${verb} ${path}`, asked)));
  if (queued === null) log(`${verb} ${path}: already asked for`);
}

/** Where a queued write may run now, or null when it must not: the section
 *  has ended, the mode is being found again, or a restart (an attach,
 *  detach or trust change) came after it was asked for in epoch `asked`.
 *  Then the user hears it, rather than the write vanishing (R13, R15); after
 *  the end there is no one to tell. */
function stillAsked(what: string, asked: number): { m: Mode; r0: string } | null {
  const m = mode;
  const r0 = root;
  if (phase === "ended") {
    log(`${what}: not run, the section has ended`);
    return null;
  }
  if (m === null) {
    log(`${what}: not run, the mode is being found again`);
    say(FINDING_MODE);
    return null;
  }
  if (asked !== epoch) {
    log(`${what}: not run, a restart came after it was asked for`);
    say(`${what}: not run; the workspace's authority or trust changed after it was asked for`);
    return null;
  }
  if (m === "volume" || r0 === null) {
    log(`${what}: not run, ${m === "volume" ? "volume mode" : "no root"}`);
    return null;
  }
  return { m, r0 };
}

/**
 * Stage all or unstage all (R16). The plan comes from a fresh status, not
 * the rows on screen: it covers paths past the 500-row cap, and none that
 * have gone since (one vanished path fails a whole `git add`, P13 iii). The
 * commands run in order, re-checking the epoch before each; the first
 * failure stops the rest. Not atomic: a failure reports how far it got.
 */
async function groupWrite(kind: "stageAll" | "unstageAll", asked: number): Promise<void> {
  // Its message names it as the user does, not by its identifier.
  const where = stillAsked(kind === "stageAll" ? "stage all" : "unstage all", asked);
  if (where === null) return;
  const { m, r0 } = where;
  const myEpoch = epoch;
  const st = await run(runner, m, "git", STATUS_ARGS, r0);
  if (myEpoch !== epoch) return;
  if (st.code !== 0) {
    say(`could not read the status: ${st.timedOut ? "git timed out" : gitReason(st, r0)}`);
    return;
  }
  const plan: GroupPlan = kind === "stageAll" ? stageAllPlan(parseStatus(st.stdout)) : unstageAllPlan(parseStatus(st.stdout));
  const verb = kind === "stageAll" ? "staged" : "unstaged";
  let done = 0;
  let slow = false;
  for (const { args, paths } of plan.commands) {
    if (myEpoch !== epoch) {
      log(`${kind} stopped by a restart after ${done} of ${plan.paths} paths`);
      return;
    }
    // Never killed (F0): a write killed at its timeout leaves `index.lock`.
    // A slow chunk is waited for, and the rest still run after it.
    const r = await runWrite(runner, m, args, r0, (left) => {
      slow = true;
      if (myEpoch === epoch) say(`${verb} ${done} of ${plan.paths}: git is ${left.stderr}`);
    });
    const outcome = classifyWrite(r, r0);
    if (myEpoch !== epoch) {
      log(`${kind} finished after a restart: ${outcome.ok ? "ok" : outcome.reason}`);
      return;
    }
    if (!outcome.ok) {
      say(`${verb} ${done} of ${plan.paths}: ${outcome.reason}`);
      return;
    }
    done += paths;
  }
  const skipped = skippedMessage(plan.skipped);
  // After "still running", say how it ended.
  if (skipped !== null) say(`${verb} ${done}; ${skipped}`);
  else if (slow) say(`${verb} ${done}`);
}

/**
 * Run one row's write commands in order, in the root through the runner, so
 * a bind-mounted dev container writes on the host (R13). On failure, git's
 * reason goes to the status bar (R15) and the rest do not run; either way
 * the queue asks for a refresh, which shows the repository's actual status.
 * A write that finishes across an epoch change (an attach, detach or trust
 * change) only logs.
 *
 * Never killed (F0): in 0.5.9 a kill is a SIGKILL, and a killed `git add`
 * leaves `.git/index.lock` behind for good. After `WRITE_TIMEOUT_MS` the
 * user is told git is still running; it is waited for, holding the queue,
 * and how it ended is reported too.
 */
async function write(commands: string[][], what: string, asked: number): Promise<void> {
  const where = stillAsked(what, asked);
  if (where === null) return;
  const myEpoch = epoch;
  let slow = false;
  for (const args of commands) {
    const r = await runWrite(runner, where.m, args, where.r0, (left) => {
      slow = true;
      if (myEpoch === epoch) say(`${what}: git is ${left.stderr}`);
    });
    const outcome = classifyWrite(r, where.r0);
    if (myEpoch !== epoch) {
      log(`${what} finished after a restart: ${outcome.ok ? "ok" : outcome.reason}`);
      return;
    }
    if (!outcome.ok) {
      say(`could not ${what}: ${outcome.reason}`);
      return;
    }
  }
  // After "still running", say how it ended.
  if (slow) say(`${what}: done`);
}

function openDiffSoon(key: string): void {
  void guardedAsync("openDiff", () => openDiff(key))();
}

function activate(key: string, space: boolean): void {
  const row = rowKind(key);
  if (row.kind === "group") {
    // Space does what the group's button does (R16); the host does not
    // toggle a group on Enter, so Enter does (R7).
    if (space) rowOp(key);
    else toggleGroup(key);
    return;
  }
  if (row.kind !== "file") return;
  if (space) {
    // Space does what the row's button does (R15); it never opens anything (R7).
    rowOp(key);
    return;
  }
  // Enter is the keyboard twin of a click (R14).
  openDiffSoon(key);
}

/** Open the row's menu at the pointer (R17), replacing one already open. A
 *  row with no items (the `… N more` row, a notice, an empty group) opens
 *  none. */
function openMenu(key: string, col: number, row: number): void {
  const items = menuItems(key, rows?.status ?? null, rows?.entries ?? NO_ENTRIES);
  if (items.length === 0) return;
  // The anchor op is in 0.5.9's host but not in its type file; it works
  // from a sidebar section (INV §9.3, §8 P10). The menu takes the keyboard,
  // and the section gets it back when the menu closes.
  if (editor.mountFloatingWidget(MENU, menuSpec(items), 30, 20, false, false, "", false, false, "", "left") === false) {
    log("mountFloatingWidget returned false: no menu");
    return;
  }
  editor.floatingPanelControl(MENU, "anchor", anchorArg(col, row));
  menuFor = key;
}

/** An event on the menu panel. A choice closes the menu and does what the
 *  same action does elsewhere (R17); Esc or a click outside closes it and
 *  changes nothing. Neither ends the section. */
function onMenuEvent(e: HookEventMap["widget_event"]): void {
  if (e.event_type === "cancel") {
    // The host has already closed the menu.
    menuFor = null;
    return;
  }
  if (e.event_type !== "activate") return;
  const key = menuFor;
  menuFor = null;
  editor.unmountFloatingWidget(MENU);
  const choice = menuChoice(e.widget_key);
  if (key === null || choice === null) return;
  // The rows may have changed while the menu was open.
  const row = rowKind(key);
  if (row.kind === "file" && !rows?.entries.has(key)) {
    say(`${trimSlash(row.path)} is no longer listed`);
    return;
  }
  if (choice === "diff") openDiffSoon(key);
  else if (choice === "file") viewFile(key);
  else rowOp(key);
}

editor.on(
  "widget_event",
  guarded("widget_event", (e: HookEventMap["widget_event"]) => {
    // The menu first: its events would otherwise be dropped as another panel's.
    if (e.panel_id === MENU) {
      onMenuEvent(e);
      return;
    }
    if (e.panel_id !== PANEL) return;
    const p = (e.payload ?? {}) as { index?: unknown; key?: unknown; expanded?: unknown; via?: unknown; col?: unknown; row?: unknown };
    const key = typeof p.key === "string" ? p.key : null;
    const index = typeof p.index === "number" ? p.index : null;
    const select = () => {
      if (key === null || index === null) return;
      recordSelection(key, index);
    };
    switch (e.event_type) {
      case "cancel":
        // The host removed the section: with `closable: false` that happens
        // only when its window closed. Stop for good.
        end();
        return;
      case "select":
        select();
        // A click on a file row opens its diff (R14); keyboard moves carry
        // no `via` (INV §9.1). A click on the row already selected re-opens
        // it: the tree's `cardBorders` lets that press through (INV §8 P21).
        if (p.via === "click" && key !== null && rowKind(key).kind === "file") openDiffSoon(key);
        return;
      case "expand":
        if (key !== null && p.expanded === true) expanded.add(key);
        if (key !== null && p.expanded === false) expanded.delete(key);
        select();
        return;
      case "activate":
        select();
        if (key !== null) activate(key, p.via === "space");
        return;
      case "context":
        // A right-click: absolute screen cells, and the host does not move
        // the selection, so none is recorded (INV §9.3).
        if (key !== null && typeof p.col === "number" && typeof p.row === "number") openMenu(key, p.col, p.row);
        return;
      case "action":
        // The row's button. The host moves the highlight to the row but
        // sends no `select`, so record it from this (INV §9.3).
        select();
        if (key !== null) rowOp(key);
        return;
    }
  }),
);

editor.on(
  "buffer_closed",
  guarded("buffer_closed", (e: HookEventMap["buffer_closed"]) => {
    // The user closed the diff tab (or something closed a source): drop the
    // composite's state, which closing its buffer leaves in the host, then
    // close the rest of the view, so nothing is left behind (R14; `dropView`,
    // as git-review's `buffer_closed` → `closeDiff`).
    const closed = slot.onClosed(e.buffer_id);
    if (closed !== null) dropView(closed.composite, closed.rest);
  }),
);

// ---------------------------------------------------------------------------
// Palette (R18)
// ---------------------------------------------------------------------------

function paletteCommand(cmd: PaletteCommand): void {
  const t = paletteTarget(cmd, selectedKey, rows?.status ?? null, rows?.entries ?? NO_ENTRIES);
  if (!t.ok) {
    say(t.message);
    return;
  }
  if (cmd === "viewFile") viewFile(t.key);
  else if (cmd === "viewDiff") openDiffSoon(t.key);
  // The selected file, or the group itself for Stage All and Unstage All:
  // the same path as its button (R15, R16).
  else rowOp(t.key);
}

/** `Git Sidebar:` prefix: the host keys plugin commands by display name,
 *  and a later registration of the same name replaces an earlier one. */
const COMMANDS: { name: string; description: string; cmd: PaletteCommand }[] = [
  { name: "Git Sidebar: View Diff", description: "Side-by-side diff of the file selected in the Git section", cmd: "viewDiff" },
  { name: "Git Sidebar: View File", description: "Open the file selected in the Git section", cmd: "viewFile" },
  { name: "Git Sidebar: Stage or Unstage", description: "Stage or unstage the file selected in the Git section", cmd: "toggle" },
  { name: "Git Sidebar: Stage All", description: "Stage every file under Changes", cmd: "stageAll" },
  { name: "Git Sidebar: Unstage All", description: "Unstage every file under Staged Changes", cmd: "unstageAll" },
];

guarded("palette", () => {
  for (const c of COMMANDS) {
    const handler = `gitSidebar_${c.cmd}`;
    registerHandler(handler, guarded(handler, () => paletteCommand(c.cmd)));
    // Listed only while the section shows rows (INV §8, P11).
    editor.registerCommand(c.name, c.description, handler, ROWS_CONTEXT);
  }
})();

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
  slot.invalidate();
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
  // The host keeps a context across a plugin reload: clear one a previous
  // load left set, so the palette lists nothing before rows are shown
  // (R18, INV §9.6). `rows` starts null, in step with it.
  editor.setContext(ROWS_CONTEXT, false);
  editor.defineMode(DIFF_MODE, [], true);
  if (looksLikeRepo()) show(BARE_TITLE, buildTree(null));
  requestRefresh();
})();
