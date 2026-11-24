// git-sidebar: a "Git" section under the file explorer with the current
// branch and two groups, Staged Changes and Changes, kept current. A click
// or Enter on a file opens its side-by-side diff (R14), and Enter in the
// diff opens the file at its line (R19, R20); `+`/`−` and Space stage and
// unstage (R15, R16); a right-click opens the row's menu (R17), with
// Resolve Conflict (R25) and Commit… (R26); the palette has the same
// commands, and Focus (R18, R22). Switching to a listed file selects its
// row (R23). Each window has a section of its own, for its own folder (R28).
//
// This file only wires the editor to the pure pieces in lib/: status parsing
// (status.ts), the tree (view.ts), what each row offers (actions.ts), the
// diff view (diff.ts), staging (stage.ts), refresh timing (scheduler.ts),
// where git runs (git.ts) and each window's panel id (windows.ts).
// Collapsing the whole section, its height and its position belong to the
// host; the plugin keeps the section mounted and updates it in place.
//
// `makeSection` holds one window's section: everything that was the whole
// plugin before R28. The rest of the file routes the editor's events to the
// section they are about, and keeps what is the editor's alone: the timer,
// the right-click menu, the keyboard's region and the palette.

import { parseStatus, title as statusTitle, unpassable, type Status } from "./lib/status.ts";
import {
  anchorArg,
  badName,
  buttonLabel,
  conflicted,
  dirReason,
  menuChoice,
  menuItems,
  menuSpec,
  nameReason,
  NO_ROWS,
  NOT_SHOWN,
  paletteTarget,
  rowAction,
  type PaletteCommand,
} from "./lib/actions.ts";
import {
  classifyCommit,
  classifyWrite,
  COMMIT_BUSY,
  commitArgs,
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
  DIFF_HINT,
  DiffSlot,
  lineCount,
  openLine,
  paneLabels,
  refusal,
  refusalMessage,
  rowRefusal,
  sides,
  sizeRefusal,
  sourceName,
  tabTitle,
  targetLine,
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
  revealKey,
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
  commitMessage,
  HEAD_SUMMARY_ARGS,
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
import { LEGACY_PANEL, panelIdFor, windowKey } from "./lib/windows.ts";

const editor = getEditor();

/** The plugin's name as the host gives it: the entry file's stem (INV §4).
 *  `chrome_focus_changed` names a section by it (INV §8 P28 c). */
const PLUGIN_NAME = "git_sidebar";
/** The right-click menu (R17): a floating panel of its own. Its `cancel`
 *  (Esc, a click outside) closes only the menu, never the section. Each
 *  window's section has its own panel id (`panelIdFor`, never 0 to 2). */
const MENU = 2;
const TICK = "gitSidebarTick";
/** The diff view's keymap, read-only (R14): Enter opens the file (R19).
 *  Keys it does not bind fall through to Fresh's side-by-side keys, `n`,
 *  `p`, `]`, `[`, `q` and Esc (R20, INV §8 P25). */
const DIFF_MODE = "git-sidebar-diff";
/** Set while the active window's section shows status rows: the palette
 *  commands are listed only then (R18, INV §8 P11). Contexts are stored per
 *  window, and written to the active one (INV §8 P33). */
const ROWS_CONTEXT = "git-sidebar-rows";
/** Set while the active window's section is shown at all, rows, placeholder
 *  or notice: Focus is listed only then (R22, R18). */
const SHOWN_CONTEXT = "git-sidebar-shown";
/** Title before the first status, and in volume mode. */
const BARE_TITLE = "Git";
/** No rows: what a lookup in the rows sees under a notice. */
const NO_ENTRIES: EntryMap = new Map();
/** While the mode is being found again (after an attach or detach) git
 *  would run in the wrong place (R13). */
const FINDING_MODE = "finding out where git runs; try again in a moment";
/** Why a write was cut short or a prompt's answer dropped: git for a window
 *  starts only while it is active (R28). */
const OTHER_WINDOW = "another window became active";
/** Between messages that waited for a window, shown together (R28). */
const WAITING_JOIN = " · ";
/** The write queue's key for a commit: no row key looks like it. */
const COMMIT_KEY = "commit";
/** The bundled plugin whose action starts conflict resolution (R25). */
const MERGE_PLUGIN = "merge_conflict";
/** Its "Merge: Start Resolution", which acts on the active buffer
 *  (`merge_conflict.ts:1215-1227,1352`; INV §10.3 e). An action name, not
 *  an API: recheck it after a Fresh upgrade. */
const MERGE_ACTION = "start_merge_conflict";

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

/** Whether `dir` looks like a repository: a `.git` in it or in a folder
 *  above it, on the host. */
function looksLikeRepo(dir: string): boolean {
  for (let d = dir, prev = ""; d !== "" && d !== prev; prev = d, d = editor.pathDirname(d)) {
    if (editor.fileExists(editor.pathJoin(d, ".git"))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The editor's own state
// ---------------------------------------------------------------------------

/** Each window's section, by window id (R28). A window gets one when it
 *  first becomes active, or at load for the active window. */
const sections = new Map<number, Section>();
/** The open right-click menu: the section it is for and the row's key. A
 *  window switch closes it, so it always belongs to the active window. */
let menu: { owner: Section; key: string } | null = null;
/** The region that last took the keyboard: the region `chrome_focus_changed`
 *  names, or "section" on a section's `focus` (INV §8 P28 c). Fresh
 *  announces it editor-wide and skips a repeat, so no event comes on a
 *  return to a window (INV §11.4). Fresh starts with the keyboard in the
 *  editor, and sections mount blurred. */
let keyboardRegion = "editor";
/** The one host timer, for the active window's section: only it refreshes
 *  (R28, R11). Only `armActive` arms it. */
const timer = new SingleTimer(
  (ms) => editor.setTimeout(ms, TICK),
  (id) => {
    editor.clearInterval(id);
  },
);

/** One write queue per repository, by its top level, shared by every window
 *  on it: two windows on one folder, or on folders in one repository (R28).
 *  Writes one at a time per repository, so none starts while another holds
 *  `.git/index.lock` (R15, INV §8 P16). Each write done asks every section on
 *  that repository for a refresh; a window not active refreshes when it is. */
const queues = new Map<string, OpQueue>();

function queueFor(root: string): OpQueue {
  let q = queues.get(root);
  if (q === undefined) {
    q = new OpQueue(
      guarded("write done", () => {
        for (const s of sections.values()) if (s.repo() === root) s.requestRefresh();
      }),
    );
    queues.set(root, q);
  }
  return q;
}

function activeSection(): Section | undefined {
  return sections.get(editor.activeWindow());
}

/** Arm the timer for the active window's section, or disarm it when there
 *  is none or nothing is due. */
function armActive(): void {
  timer.arm(activeSection()?.nextDue() ?? null, Date.now());
}

// ---------------------------------------------------------------------------
// One window's section
// ---------------------------------------------------------------------------

type Section = ReturnType<typeof makeSection>;

/**
 * The section of window `win`, whose folder is `workspace`, as panel
 * `panel`. Both are read once, when the section is made (R28): `getCwd()`
 * follows the active window, and the host re-scopes a section on every
 * mount. Every editor call here that acts on the active window (INV §11.4)
 * runs only while `win` is active: git, contexts, status messages, prompts
 * and buffers.
 */
function makeSection(win: number, workspace: string, panel: number) {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Where git runs; null while it must be (re)detected before the next run:
   *  at load, after every authority or trust change, and while detection keeps
   *  failing. */
  let mode: Mode | null = null;
  /** Repository top level, as a host path; null until resolved. Attaching or
   *  detaching does not move host paths (INV §7), so it survives both. */
  let root: string | null = null;
  /** Where the section is in its life:
   *  - pending: nothing shown since it was made or the last authority change,
   *    so a definitive failure takes the section down (R1);
   *  - shown: rows or the volume notice were shown, and a failure keeps them (R10);
   *  - gaveUp: git failed for good while pending; quiet until the authority or
   *    the workspace trust changes, or the window becomes active again (R1, R28);
   *  - ended: the host removed the section (its window closed); nothing more, ever. */
  let phase: "pending" | "shown" | "gaveUp" | "ended" = "pending";
  /** Bumped on every authority or trust change and at the end, so a run
   *  started before it is ignored. */
  let epoch = 0;
  /** The authority label the mode was last found for (R13). Authority is per
   *  window (INV §11.4): a different label when the window becomes active
   *  again means it was attached or detached meanwhile. */
  let authorityLabel = editor.getAuthorityLabel();

  /** What the section draws now, or null when it is not mounted. The title is
   *  fixed per mount; an equal signature means no widget calls.
   *  SHOWN_CONTEXT is set exactly while it is not null, while `win` is
   *  active (`setShown`, `syncContexts`). */
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
   *  (R13, R18). ROWS_CONTEXT is set exactly while it is not null, while
   *  `win` is active. */
  let rows: { status: Status; entries: EntryMap; raw: string } | null = null;
  /** The window's one diff view (R14). */
  const slot = new DiffSlot();
  /** Whether the keyboard is in the section, so auto-reveal leaves the row
   *  Space acts on alone (R23). From the panel's `focus` and `blur` and from
   *  `chrome_focus_changed`: a tab click sends `blur` before the buffer
   *  change and the chrome event after it, and a remount sends the chrome
   *  event and no `blur` (INV §8 P28 c, d). A remount clears it too (INV §2),
   *  and parking the section sends `blur` (INV §11.1). */
  let sectionFocused = false;
  /** The diff view whose key hint waits for the keyboard to be in it (R20),
   *  by its composite id, or null. */
  let hintFor: number | null = null;

  const sched = new Scheduler();

  /** How many status messages this section has said: a later one can tell
   *  whether it would replace one said meanwhile. */
  let said = 0;
  /** Messages said while `win` was not active, oldest first, shown together
   *  when it is active again (R28): `setStatus` writes to the active window. */
  const deferred: string[] = [];
  /** Diff views to close once `win` is active again: the calls that close
   *  them act on the active window (INV §11.4). If the window closes first,
   *  the host purges them with it. */
  const leftovers: { composite: number | null; ids: number[] }[] = [];

  /** Whether `win` is the active window now. Read when it matters, never
   *  remembered: an event's window may already be stale (INV §11.4). */
  function isActive(): boolean {
    return editor.activeWindow() === win;
  }

  /** Whether a step begun in epoch `myEpoch` may go on to something that
   *  acts on the active window (git, buffers, opening a file): no restart
   *  since, and `win` still active (R28). A bare epoch check is kept where a
   *  result should still land in a parked section. */
  function live(myEpoch: number): boolean {
    return myEpoch === epoch && isActive();
  }

  /** A status message for the user. No `git-sidebar:` prefix, as in Fresh's
   *  own plugins: the status bar cuts a long message at its width, and
   *  git's reason, which matters most, comes last. Debug lines keep it.
   *  While another window is active it waits for this one (R28). In this
   *  window, messages still waiting come first, so none is lost under it. */
  function say(msg: string): void {
    said++;
    if (isActive()) {
      // Messages that waited: a diff hint still waiting would replace them
      // at once, as in `sayDeferred` (R20).
      if (deferred.length > 0) hintFor = null;
      editor.setStatus([...deferred.splice(0), msg].join(WAITING_JOIN));
      return;
    }
    if (deferred.at(-1) !== msg) deferred.push(msg);
    log(`for window ${win} once it is active: ${msg}`);
  }

  /** Show the messages that waited for this window (R28). A diff hint still
   *  waiting would replace them at once, on the tab or focus event the
   *  switch brings, so it is dropped (R20). */
  function sayDeferred(): void {
    if (deferred.length === 0) return;
    hintFor = null;
    editor.setStatus(deferred.splice(0).join(WAITING_JOIN));
  }

  /** Whether git may run: not ended, not given up, and not a volume. */
  function mayRun(): boolean {
    return phase !== "ended" && phase !== "gaveUp" && mode !== "volume";
  }

  /** Ask for a refresh soon. For an inactive window it waits until the
   *  window is active again (R28). */
  function requestRefresh(): void {
    if (!mayRun()) return;
    sched.requestUrgent(Date.now());
    armActive();
  }

  // -------------------------------------------------------------------------
  // The section
  // -------------------------------------------------------------------------

  function mutate(m: WidgetMutation): void {
    editor.widgetMutate(panel, m);
  }

  /** Record the row the host says is selected now. */
  function recordSelection(key: string, index: number): void {
    selectedKey = key;
    selectedIndex = index;
    selectedPlace = placeOf(shownKeys, key);
  }

  /** Replace the rows shown, setting ROWS_CONTEXT when they come or go while
   *  `win` is active; `syncContexts` sets it on every switch. */
  function setRows(next: typeof rows): void {
    if ((rows === null) !== (next === null) && isActive()) editor.setContext(ROWS_CONTEXT, next !== null);
    rows = next;
  }

  /** Replace what is shown, setting SHOWN_CONTEXT when the section comes or
   *  goes while `win` is active (R22, `syncContexts`). */
  function setShown(next: typeof shown): void {
    if ((shown === null) !== (next === null) && isActive()) editor.setContext(SHOWN_CONTEXT, next !== null);
    shown = next;
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
   * then. A mount scoped to an inactive window parks at once (INV §11.1), so
   * a refresh that ends after a switch draws into the parked section. No
   * mount or update asks for focus: the host's "focus" shows a hidden
   * explorer column and expands a collapsed section (INV §8 P27), so only
   * the Focus command sends it (R22, R1).
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
      ? editor.mountSidebarSection(panel, spec, title, 0, {
          closable: false,
          startBlurred: true,
          scope: { window: win },
        })
      : editor.updateFloatingWidget(panel, spec);
    if (ok === false) {
      log(`${remount ? "mountSidebarSection" : "updateFloatingWidget"} returned false; retrying on the next refresh`);
      return false;
    }
    // A remount clears the host's focus (INV §2). A refused one changed
    // nothing, and the old section may still hold the keyboard.
    if (remount) sectionFocused = false;
    const prevIndex = selectedIndex;
    setShown({ title, sig });
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

  // -------------------------------------------------------------------------
  // Refreshing
  // -------------------------------------------------------------------------

  /** Drop pending work and forget what is shown, taking the section down
   *  first when `unmount` (the host has not already removed it) — even one
   *  this instance never mounted: the host keeps a section across a plugin
   *  reload (INV §2), and unmounting an id that is not mounted is a no-op. */
  function stop(unmount: boolean): void {
    sched.cancel();
    if (unmount) editor.unmountFloatingWidget(panel);
    setShown(null);
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
    // the authority or the trust changes, or the window becomes active again.
    phase = "gaveUp";
    stop(true);
  }

  /** Where git runs now, or null when a restart, the end or a window switch
   *  overtook the detection: the next run would use the active window's
   *  authority, not this one's (R28). */
  async function detect(myEpoch: number): Promise<Detected | null> {
    const label = editor.getAuthorityLabel();
    const id = containerId(label);
    let pwd: GitResult | null = null;
    let inspect: GitResult | null = null;
    if (id !== null) {
      // The container's workspace folder: with no cwd the docker spawner runs
      // in `-w <remoteWorkspaceFolder>`.
      pwd = await runOn(runner, "target", "pwd", [], "");
      if (!live(myEpoch)) return null;
      if (pwd.code === 0) {
        inspect = await runOn(runner, "host", "docker", ["inspect", id, "--format", "{{json .Mounts}}"], workspace);
        if (!live(myEpoch)) return null;
      }
    }
    const d = detectMode(label, workspace, pwd, inspect);
    log(`mode ${d.mode}: ${d.reason}`);
    return d.mode;
  }

  /** One refresh. It starts only while `win` is active (`tick`), and starts
   *  nothing more once another window is (R28): a run already going finishes
   *  and draws into the parked section. */
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
        if (shown !== null || looksLikeRepo(workspace)) showNotice(UNKNOWN_NOTICE);
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
      // Another window is active now: the status would run on its authority.
      // Nothing failed; the next activation refreshes (R28).
      if (!isActive()) return;
    }
    const ops = queueFor(root);
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

  // Writes go through the repository's queue (`queueFor`): one at a time,
  // each asking for a refresh when done (R15). They run outside the
  // scheduler, so they are not part of its 25% budget (R11).

  const reArm = guarded("re-arm", (started: number) => {
    const end = Date.now();
    sched.finish(end, end - started);
    // The scheduler reads polling only when the next run is due, from here on.
    sched.setPolling(mayRun());
    armActive();
  });

  /** The timer fired while `win` is active: run the refresh if one is due. */
  function tick(): void {
    const started = Date.now();
    if (!sched.tryStart(started)) {
      armActive();
      return;
    }
    void refreshNow().then(() => reArm(started));
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  /** The host removed the section (its window closed): nothing more, ever.
   *  Its buffers went with the window, so none is closed here. */
  function end(): void {
    phase = "ended";
    epoch++;
    slot.invalidate();
    stop(false);
    armActive();
  }

  function toggleGroup(key: string): void {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    pushExpanded();
  }

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

  /** The row's file as an absolute path, when it is a regular file that
   *  View File may open; otherwise null, after saying why. */
  function fileToOpen(key: string): string | null {
    const row = rowKind(key);
    if (row.kind !== "file" || root === null) return null;
    if (rows?.entries.get(key)?.entry.dir === true) {
      say(dirReason(trimSlash(row.path)));
      return null;
    }
    // Status names it lossily (F6): the path names no file, so the stat below
    // would call it deleted.
    if (unpassable(row.path)) {
      say(nameReason(row.path));
      return null;
    }
    const path = editor.pathJoin(root, row.path);
    // openFile on a missing path would create a new buffer, and `fileExists`
    // is true for a directory too (a deleted file's path reused by one, a
    // symlink to one).
    const stat = editor.fileStat(path) as { isFile?: unknown; isDir?: unknown } | null;
    if (stat?.isFile === true) return path;
    say(stat?.isDir === true ? `${row.path} is a directory` : `${row.path} is deleted`);
    return null;
  }

  /** View File (R7): open the row's file as a tab; whether it opened.
   *  Reached from the menu (R17), the palette (R18), Resolve Conflict (R25)
   *  and Enter in the diff (R19) only; no gesture on a row opens the file
   *  itself. */
  function viewFile(key: string): boolean {
    // It would open in the active window, another window's (R28).
    if (!isActive()) return false;
    const path = fileToOpen(key);
    if (path === null) return false;
    // Not sent: nothing opened, so nothing may act on the active buffer as
    // if it were this file (Resolve Conflict).
    if (editor.openFile(path)) return true;
    log(`openFile returned false for ${path}`);
    return false;
  }

  /** How many lines the tab for `path`, a regular file, will show: `openFile`
   *  switches to a buffer already open on it
   *  (`file_open_orchestrators.rs:271-275`), whose text may hold unsaved
   *  edits; otherwise the file on disk. Either is read only when a diff would
   *  read it too (`sizeRefusal`). Null when that is not known: too large to read, or
   *  no text (not UTF-8: `readFile` gives `undefined`). */
  async function linesShown(path: string): Promise<number | null> {
    const open = editor.findBufferByPath(path);
    if (open !== 0) {
      // The same size cap as a file on disk: the whole text crosses the bridge.
      const info = editor.getBufferInfo(open);
      if (info !== null && sizeRefusal(info.length) !== null) return null;
      return lineCount(await editor.getBufferText(open));
    }
    const stat = editor.fileStat(path) as { size?: unknown } | null;
    if (sizeRefusal(typeof stat?.size === "number" ? stat.size : 0) !== null) return null;
    const text: unknown = editor.readFile(path);
    return typeof text === "string" ? lineCount(text) : null;
  }

  /** Enter in the diff (R19): open the row's file at the 0-based `target`
   *  (null: its last line), clamped to the lines its tab will show, since the
   *  host jumps to line 1 past the end (`openLine`). The keyboard moves to the
   *  file and the diff tab stays (INV §8 P25 d). View File's checks come
   *  first, so only a regular file is read to count its lines. A switch to
   *  another window meanwhile opens nothing: it would open there (R28). */
  async function openAt(key: string, target: number | null, myEpoch: number): Promise<void> {
    const path = fileToOpen(key);
    if (path === null) return;
    const count = await linesShown(path);
    if (!live(myEpoch)) return;
    const line = openLine(target, count);
    if (!(line === null ? editor.openFile(path) : editor.openFile(path, line))) log(`openFile returned false for ${path}`);
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
   *  so a user's close calls it too (P19). Both act on the active window
   *  (INV §11.4), so another window's view waits until it is active again
   *  (`leftovers`). */
  function dropView(composite: number | null, ids: number[]): void {
    if (!isActive()) {
      leftovers.push({ composite, ids });
      log(`window ${win}'s diff closes once it is active`);
      return;
    }
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
   * the epoch, the slot's generation and the window: buffers open in the
   * active window, so a build overtaken by a switch stops (R28). A stale
   * build closes what it made.
   */
  async function openDiff(key: string): Promise<void> {
    // Its reads would run on the active window's authority, and its buffers
    // open there (R28).
    if (!isActive()) return;
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
    const stale = () => !live(myEpoch) || !slot.isCurrent(gen);
    const saidBefore = said;
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
          name: sourceName(label, path),
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
        view = { composite: await editor.createCompositeBuffer(opts), left: a, right: b, key, hunks, rightLines: lineCount(rightText) };
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
      // The diff's keys are Fresh's and Enter is ours; nothing else shows them
      // (R20). They work only once the keyboard is in the diff, and a click or
      // Enter on a row leaves it in the section (R14), so then the hint waits
      // for it to move in (`hintIfInDiff`). Not over a message sent during the
      // build, such as a write's outcome (R15, R26), which nothing would say
      // again.
      hintFor = sectionFocused ? composite : null;
      if (!sectionFocused && said === saidBefore) say(DIFF_HINT);
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
    const ops = queueFor(ready.root);
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
   *  has ended, the mode is being found again, a restart (an attach, detach
   *  or trust change) came after it was asked for in epoch `asked`, or
   *  another window is active, whose authority git would run on (R28).
   *  Then the user hears it, rather than the write vanishing (R13, R15);
   *  after the end there is no one to tell. */
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
    if (!isActive()) {
      log(`${what}: not run, window ${win} is not active`);
      say(`${what}: not run; ${OTHER_WINDOW} before it started`);
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
   * commands run in order, re-checking the epoch and the window before each;
   * the first failure stops the rest. Not atomic: a failure or a switch to
   * another window reports how far it got (R28).
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
      if (!isActive()) {
        say(`${verb} ${done} of ${plan.paths}; the rest not run: ${OTHER_WINDOW}`);
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
   * Run one row's write commands, or a commit's (R26), in order, in the root
   * through the runner, so a bind-mounted dev container writes on the host
   * (R13). On failure, git's reason goes to the status bar (R15, R26) and the
   * rest do not run; either way the queue asks for a refresh, which shows the
   * repository's actual status. A write that finishes across an epoch change
   * (an attach, detach or trust change) only logs. A command after the first
   * does not start once another window is active (R28).
   *
   * Never killed (F0): in 0.5.9 a kill is a SIGKILL, and a killed `git add`
   * leaves `.git/index.lock` behind for good. After `WRITE_TIMEOUT_MS` the
   * user is told git is still running; it is waited for, holding the queue,
   * and how it ended is reported too: by `onOk` when given, which runs once
   * every command has succeeded and says the last word, so no `done` of this
   * function's own overwrites it (R26). `onOk` is not awaited: the queue
   * counts the write as done (`writeSeq`) as soon as git exits, so a status
   * read before that is never drawn while `onOk` runs its own read.
   * `classify` reads each command's result: a commit's is `classifyCommit`.
   */
  async function write(
    commands: string[][],
    what: string,
    asked: number,
    onOk?: (m: Mode, r0: string) => Promise<void>,
    classify: typeof classifyWrite = classifyWrite,
  ): Promise<void> {
    const where = stillAsked(what, asked);
    if (where === null) return;
    const myEpoch = epoch;
    let slow = false;
    for (const [i, args] of commands.entries()) {
      if (i > 0 && !isActive()) {
        say(`could not ${what} in full: ${OTHER_WINDOW}`);
        return;
      }
      const r = await runWrite(runner, where.m, args, where.r0, (left) => {
        slow = true;
        if (myEpoch === epoch) say(`${what}: git is ${left.stderr}`);
      });
      const outcome = classify(r, where.r0);
      if (myEpoch !== epoch) {
        log(`${what} finished after a restart: ${outcome.ok ? "ok" : outcome.reason}`);
        return;
      }
      if (!outcome.ok) {
        say(`could not ${what}: ${outcome.reason}`);
        return;
      }
    }
    if (onOk !== undefined) void guardedAsync(what, () => onOk(where.m, where.r0))();
    // After "still running", say how it ended.
    else if (slow) say(`${what}: done`);
  }

  /**
   * Commit… (R26): ask for a one-line message, then commit exactly what is
   * staged, through the write queue like every write: one at a time with
   * stages and unstages, in the order asked, never killed (R15, INV §8 P16).
   * With nothing staged, or while the last commit holds the queue's key, no
   * prompt opens. The prompt can stay open across a
   * refresh or a restart, so what it found is checked again once it answers:
   * the section's end, its rows (a restart may have brought up a notice),
   * and Staged Changes. A restart during the prompt is caught by the queue's
   * `stillAsked`, which says so. A prompt that answers while another window
   * is active commits nothing, and says so once `win` is active again (R28).
   */
  async function commitFlow(): Promise<void> {
    const ready = readiness();
    if ("why" in ready) {
      say(ready.why);
      return;
    }
    const before = paletteTarget("commit", selectedKey, ready.status, ready.entries);
    if (!before.ok) {
      say(before.message);
      return;
    }
    // Refused before the prompt opens, not after the message is typed; the
    // queue still refuses one that becomes busy while the prompt is open.
    const ops = queueFor(ready.root);
    if (ops.blocked(COMMIT_KEY)) {
      say(COMMIT_BUSY);
      return;
    }
    const asked = epoch;
    const typed = await editor.prompt("Commit message: ", "");
    if (phase === "ended") return;
    if (!isActive()) {
      // The prompt is `win`'s, as a window's prompt is its own (INV §11.4):
      // the message waits for `win`, like any other about it (R28).
      say(`nothing committed: ${OTHER_WINDOW}`);
      return;
    }
    // Esc: nothing changes, and that is said (R26), so an earlier message,
    // such as "nothing staged to commit", is not left beside Fresh's own
    // "Search cancelled." (INV §8, live checks).
    if (typed === null) {
      say("commit cancelled");
      return;
    }
    if (rows === null) {
      say("nothing committed: the Git section no longer shows files");
      return;
    }
    const now = paletteTarget("commit", selectedKey, rows.status, rows.entries);
    if (!now.ok) {
      say(now.message);
      return;
    }
    const args = commitArgs(typed);
    if (args === null) {
      say("the commit message is empty; nothing committed");
      return;
    }
    const typedSubject = typed.trim();
    const queued = ops.enqueue(
      COMMIT_KEY,
      guardedAsync("commit", () => write([args], "commit", asked, (m, r0) => committed(m, r0, typedSubject), classifyCommit)),
    );
    if (queued === null) say(COMMIT_BUSY);
  }

  /** After a commit: its short id and its message as git recorded it, after
   *  any hook rewrote it (R26, `commitMessage`), read on its own after the
   *  commit. Across a restart it only logs, as a write does. It runs beside
   *  the next queued write, so a message sent during the read, such as that
   *  write's failure, is newer and is not covered: the commit only logs then,
   *  and the refresh shows it. With another window active the read would run
   *  on its authority, so the message names the typed subject only (R28). */
  async function committed(m: Mode, r0: string, typedSubject: string): Promise<void> {
    if (!isActive()) {
      say(`committed: ${typedSubject}`);
      return;
    }
    const myEpoch = epoch;
    const saidBefore = said;
    const msg = commitMessage(await run(runner, m, "git", HEAD_SUMMARY_ARGS, r0), typedSubject);
    if (myEpoch !== epoch) log(`${msg} (finished after a restart)`);
    else if (said !== saidBefore) log(`${msg} (not shown: a later message was)`);
    else say(msg);
  }

  function commitSoon(): void {
    void guardedAsync("commitFlow", commitFlow)();
  }

  /**
   * Resolve Conflict (R25): open the conflicted file as View File does, then
   * start Fresh's merge resolution on it, which acts on the buffer just
   * opened when asked right after the open (INV §8 P29). With merge_conflict
   * disabled the action is unknown and the host logs an ERROR and shows a
   * warning count, so it is asked only when `listPlugins()` lists the plugin
   * enabled (P29); the file still opens. Never stages anything (R15). A
   * switch to another window while the host answers opens nothing (R28).
   */
  async function resolveConflict(key: string): Promise<void> {
    const row = rowKind(key);
    if (row.kind !== "file") return;
    const myEpoch = epoch;
    // A list that cannot be read counts as no resolver: the file still
    // opens (R25).
    let plugins: { name: string; enabled: boolean }[] = [];
    try {
      plugins = await editor.listPlugins();
    } catch (e) {
      log(`listPlugins threw: ${String(e)}; opening the file only`);
    }
    if (!live(myEpoch)) return;
    // The rows may have changed while the menu was open or the host
    // answered: the row may be gone, or no longer conflicted.
    const now = rows;
    if (now === null || !now.entries.has(key)) {
      say(`${trimSlash(row.path)} is no longer listed`);
      return;
    }
    if (!conflicted(key, now.entries)) {
      say(`${trimSlash(row.path)} no longer has a merge conflict`);
      return;
    }
    const resolver = plugins.some((p) => p.name === MERGE_PLUGIN && p.enabled);
    if (!viewFile(key)) return;
    if (resolver) editor.executeAction(MERGE_ACTION);
    else log(`${MERGE_PLUGIN} is not enabled: opened the file only`);
  }

  function resolveSoon(key: string): void {
    void guardedAsync("resolveConflict", () => resolveConflict(key))();
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
    menu = { owner: api, key };
  }

  /** A choice in this section's menu, after the menu closed: it does what
   *  the same action does elsewhere (R17). */
  function menuChoose(key: string, choice: NonNullable<ReturnType<typeof menuChoice>>): void {
    // The rows may have changed while the menu was open.
    const row = rowKind(key);
    if (row.kind === "file" && !rows?.entries.has(key)) {
      say(`${trimSlash(row.path)} is no longer listed`);
      return;
    }
    // Each choice routed by name: a new choice must never fall into a write.
    switch (choice) {
      case "diff":
        openDiffSoon(key);
        return;
      case "file":
        viewFile(key);
        return;
      case "resolve":
        resolveSoon(key);
        return;
      case "commit":
        commitSoon();
        return;
      case "stage":
      case "unstage":
      case "stageAll":
      case "unstageAll":
        rowOp(key);
        return;
    }
  }

  /** An event from this section's panel. Its `window_id` is the active
   *  window's, not necessarily this one's (INV §11.4): the panel id routed
   *  it here. */
  function onPanelEvent(e: HookEventMap["widget_event"]): void {
    const p = (e.payload ?? {}) as { index?: unknown; key?: unknown; expanded?: unknown; via?: unknown; col?: unknown; row?: unknown };
    const key = typeof p.key === "string" ? p.key : null;
    const index = typeof p.index === "number" ? p.index : null;
    const select = () => {
      if (key === null || index === null) return;
      recordSelection(key, index);
    };
    // A press handled after a switch to another window does nothing: its
    // git and buffers would be that window's (R28). `isActive()` comes last,
    // so a keyboard move reads no window.
    switch (e.event_type) {
      case "cancel":
        // The host removed the section: with `closable: false` that happens
        // only when its window closed. Stop for good.
        drop(win);
        return;
      case "focus":
        sectionFocused = true;
        keyboardRegion = "section";
        return;
      case "blur":
        sectionFocused = false;
        return;
      case "select":
        select();
        // A click on a file row opens its diff (R14); keyboard moves carry
        // no `via` (INV §9.1). A click on the row already selected re-opens
        // it: the tree's `cardBorders` lets that press through (INV §8 P21).
        if (p.via === "click" && key !== null && rowKind(key).kind === "file" && isActive()) openDiffSoon(key);
        return;
      case "expand":
        if (key !== null && p.expanded === true) expanded.add(key);
        if (key !== null && p.expanded === false) expanded.delete(key);
        select();
        return;
      case "activate":
        select();
        if (key !== null && isActive()) activate(key, p.via === "space");
        return;
      case "context":
        // A right-click: absolute screen cells, and the host does not move
        // the selection, so none is recorded (INV §9.3).
        if (key !== null && typeof p.col === "number" && typeof p.row === "number" && isActive()) openMenu(key, p.col, p.row);
        return;
      case "action":
        // The row's button. The host moves the highlight to the row but
        // sends no `select`, so record it from this (INV §9.3).
        select();
        if (key !== null && isActive()) rowOp(key);
        return;
    }
  }

  /** Enter in a diff the section opened (R19): the row's file, at the line
   *  under the diff's cursor (`targetLine`). Bound in DIFF_MODE; `n`, `p`,
   *  `]`, `[`, `q` and Esc fall through to Fresh's own keys for a
   *  side-by-side view (INV §8 P25). */
  async function diffEnter(): Promise<void> {
    const v = slot.current();
    if (v === null) return;
    const myEpoch = epoch;
    const info = await editor.getCompositeCursorInfo();
    // A restart, the view closed or replaced, or another window active,
    // while the host answered.
    if (!live(myEpoch) || slot.current() !== v || info === null) return;
    await openAt(v.key, targetLine(info.lines, v.hunks, v.rightLines), myEpoch);
  }

  /**
   * The diff's key hint (R20), once the keyboard is in the diff it waits for:
   * in the editor, not the section, with the diff's tab active. Said once per
   * view; a view replaced or closed meanwhile drops it.
   */
  function hintIfInDiff(): void {
    if (hintFor === null || sectionFocused || keyboardRegion !== "editor") return;
    if (slot.current()?.composite !== hintFor) {
      hintFor = null;
      return;
    }
    if (editor.getActiveBufferId() !== hintFor) return;
    hintFor = null;
    say(DIFF_HINT);
  }

  /** Which region holds the keyboard in this window (INV §8 P28 c): the
   *  section only when the region is a section named by this plugin and
   *  panel. A click into the diff, or Esc in the section, moves it to the
   *  editor (P25 e). */
  function onChrome(e: HookEventMap["chrome_focus_changed"]): void {
    sectionFocused = e.region === "section" && e.plugin === PLUGIN_NAME && e.panel_id === panel;
    hintIfInDiff();
  }

  /**
   * Auto-reveal (R23): when this window's active tab changes to a file the
   * section lists, while the keyboard is elsewhere, select that file's row.
   * `setSelectedIndex` scrolls it into view, never moves the keyboard and
   * sends no `select` back (INV §8 P28 a, b), so no diff opens. A collapsed
   * group, a row past the cap, or one of the file's rows already selected
   * leaves the selection alone (`revealKey`). Only a tab change reveals: a
   * refresh never does (R10). A tab change to a diff also gives the hint
   * that waits for it (R20).
   */
  function onActiveBuffer(e: HookEventMap["active_buffer_changed"]): void {
    // A tab change to a diff waiting for its hint, the keyboard in the editor.
    hintIfInDiff();
    if (sectionFocused || rows === null || root === null) return;
    // A window switch back to this window is not a tab change: its active
    // tab is the one it had, whose row the user may have left since (R28).
    if (e.reason === "window") return;
    // "" for a virtual buffer, such as a diff view, or one with no file.
    const path = editor.getBufferPath(e.buffer_id);
    if (path === "") return;
    const key = revealKey(path, root, rows.entries, shownKeys, expanded, selectedKey);
    if (key === null) return;
    const index = shownKeys.indexOf(key);
    recordSelection(key, index);
    pushSelection(index);
  }

  /** A buffer of this window closed. The user closed the diff tab (or
   *  something closed a source): drop the composite's state, which closing
   *  its buffer leaves in the host, then close the rest of the view, so
   *  nothing is left behind (R14; `dropView`, as git-review's `buffer_closed`
   *  → `closeDiff`). While another window is active, `dropView` keeps them
   *  until this one is: a window that closes takes them with it. */
  function onBufferClosed(e: HookEventMap["buffer_closed"]): void {
    const closed = slot.onClosed(e.buffer_id);
    if (closed !== null) dropView(closed.composite, closed.rest);
  }

  // -------------------------------------------------------------------------
  // Palette (R18)
  // -------------------------------------------------------------------------

  function paletteCommand(cmd: PaletteCommand): void {
    const t = paletteTarget(cmd, selectedKey, rows?.status ?? null, rows?.entries ?? NO_ENTRIES);
    if (!t.ok) {
      say(t.message);
      return;
    }
    switch (cmd) {
      case "viewFile":
        viewFile(t.key);
        return;
      case "viewDiff":
        openDiffSoon(t.key);
        return;
      case "resolve":
        resolveSoon(t.key);
        return;
      case "commit":
        commitSoon();
        return;
      case "toggle":
      case "stageAll":
      case "unstageAll":
        // The selected file, or the group itself for Stage All and Unstage
        // All: the same path as its button (R15, R16).
        rowOp(t.key);
        return;
    }
  }

  /**
   * Focus (R22): move the keyboard into the section. The host's "focus"
   * shows a hidden explorer column and expands a collapsed section (INV §8
   * P27). With rows shown and none selected, the first row is selected first,
   * so Enter and Space have one to act on. Not routed through `paletteTarget`:
   * it acts under the placeholder and a notice too, where there are no rows
   * to target. A key the user binds to its handler can run it at any
   * time, so with no section it says so.
   */
  function focusSection(): void {
    if (shown === null) {
      say(NOT_SHOWN);
      return;
    }
    if (rows !== null && selectedKey === null && shownKeys.length > 0) {
      recordSelection(shownKeys[0], 0);
      pushSelection(0);
    }
    editor.floatingPanelControl(panel, "focus", 0);
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  /** The authority or the workspace trust changed. A run in flight belongs to
   *  the old one. Attach or detach (`forget`) keeps the window and the
   *  section, but what was known is about the other side: where git runs must
   *  be found out again (R13), and a definitive failure now takes the section
   *  down (R1). A trust change moves no mount, so a mode already found stands
   *  (one that trust blocked was never found); it only lifts a give-up: a run
   *  it blocked may now be allowed. */
  function restart(forget: boolean): void {
    epoch++;
    slot.invalidate();
    if (forget) {
      mode = null;
      authorityLabel = editor.getAuthorityLabel();
    }
    if (forget || phase === "gaveUp") phase = "pending";
    requestRefresh();
  }

  /** The section was just made, for the active window: mount now when the
   *  folder looks like a repository. A section mounted later than a few
   *  frames after its window is restored loses its saved layout (INV §8 P2,
   *  §11.2). Rows follow from the first status; if git then fails, the
   *  section goes away again. */
  function start(): void {
    if (looksLikeRepo(workspace)) show(BARE_TITLE, buildTree(null));
    requestRefresh();
  }

  /** The active window's authority label, read on `authority_changed` and on
   *  every activation: a label other than the one the mode was found for
   *  means this window was attached or detached, so where git runs is found
   *  out again (R13); whether it restarted. The hook also comes on a switch
   *  between windows with different labels (INV §11.4), when this window's
   *  own authority has not changed: then nothing happens. */
  function checkAuthority(): boolean {
    if (editor.getAuthorityLabel() === authorityLabel) return false;
    restart(true);
    return true;
  }

  /** The window became active again (R28): the messages that waited for
   *  it, the diff views left to close, then a refresh. A section that gave
   *  up tries again: its folder may be a repository now. */
  function activated(): void {
    sayDeferred();
    for (const v of leftovers.splice(0)) dropView(v.composite, v.ids);
    if (checkAuthority()) return;
    if (phase === "gaveUp") restart(false);
    else requestRefresh();
  }

  const api = {
    panel,
    repo: () => root,
    start,
    activated,
    tick,
    /** When the next refresh is due. Only the active window's is armed
     *  (`armActive`); an ended section is no longer listed. */
    nextDue: () => sched.nextDue(),
    requestRefresh,
    restart,
    checkAuthority,
    end,
    hasRows: () => rows !== null,
    isShown: () => shown !== null,
    onPanelEvent,
    menuChoose,
    onChrome,
    onActiveBuffer,
    onBufferClosed,
    paletteCommand,
    focusSection,
    diffEnter,
  };
  return api;
}

// ---------------------------------------------------------------------------
// Windows (R28)
// ---------------------------------------------------------------------------

/** The section of window `win`, made now if it has none yet: for the window's
 *  folder, as `listWindows()` gives it, with the panel id of its workspace
 *  (`panelIdFor`, INV §11.2). Null while the window is not listed yet: the
 *  next activation or tab change tries again. */
function ensureSection(win: number): Section | null {
  const have = sections.get(win);
  if (have !== undefined) return have;
  const info = editor.listWindows().find((w) => w.id === win);
  if (info === undefined) {
    log(`window ${win} is not listed yet`);
    return null;
  }
  const taken = new Set([...sections.values()].map((s) => s.panel));
  const s = makeSection(win, info.root, panelIdFor(windowKey(info.stable_id, info.root), taken));
  sections.set(win, s);
  s.start();
  return s;
}

/** Set both contexts from `s`, the active window's section, or clear them
 *  where it has none. Contexts are stored per window and written to the active
 *  one (INV §8 P33), and a section's changes while its window was not
 *  active did not reach them, so this runs on every switch. */
function syncContexts(s: Section | null): void {
  editor.setContext(ROWS_CONTEXT, s?.hasRows() ?? false);
  editor.setContext(SHOWN_CONTEXT, s?.isShown() ?? false);
}

/** Close the right-click menu, if one is open: it was for the window that
 *  was active. */
function closeMenu(): void {
  if (menu === null) return;
  menu = null;
  editor.unmountFloatingWidget(MENU);
}

/** A window became active (R28): its section, made and mounted now on its
 *  first activation (INV §11.3), its contexts, its waiting message and a
 *  refresh. Reads the active window when it runs, not from the event, which
 *  may be stale by then. */
function onActivated(): void {
  closeMenu();
  const s = ensureSection(editor.activeWindow());
  syncContexts(s);
  s?.activated();
  armActive();
}

/** Window `win` closed, or its section was removed with it: end its section.
 *  Both come for one close (`cancel`, then `window_closed`, INV §8 P31 f). */
function drop(win: number): void {
  const s = sections.get(win);
  if (s === undefined) return;
  sections.delete(win);
  if (menu?.owner === s) menu = null;
  // `end` re-arms the timer, for the section now active.
  s.end();
}

/** An event on the menu panel. A choice closes the menu and does what the
 *  same action does elsewhere (R17); Esc or a click outside closes it and
 *  changes nothing. Neither ends the section. */
function onMenuEvent(e: HookEventMap["widget_event"]): void {
  if (e.event_type === "cancel") {
    // The host has already closed the menu.
    menu = null;
    return;
  }
  if (e.event_type !== "activate") return;
  const open = menu;
  closeMenu();
  const choice = menuChoice(e.widget_key);
  if (open === null || choice === null) return;
  open.owner.menuChoose(open.key, choice);
}

registerHandler(
  TICK,
  guarded("tick", () => {
    timer.fired();
    activeSection()?.tick();
  }),
);

editor.on(
  "widget_event",
  guarded("widget_event", (e: HookEventMap["widget_event"]) => {
    // The menu first: its events would otherwise be dropped as another panel's.
    if (e.panel_id === MENU) {
      onMenuEvent(e);
      return;
    }
    // By panel, never by `window_id`, which names the active window (INV
    // §11.4). Another panel, such as the legacy one load unmounts, is not ours.
    for (const s of sections.values()) {
      if (s.panel === e.panel_id) {
        s.onPanelEvent(e);
        return;
      }
    }
  }),
);

registerHandler(
  "gitSidebar_diffEnter",
  guardedAsync("diff Enter", async () => {
    await activeSection()?.diffEnter();
  }),
);

editor.on(
  "chrome_focus_changed",
  guarded("chrome_focus_changed", (e: HookEventMap["chrome_focus_changed"]) => {
    keyboardRegion = e.region;
    sections.get(e.window_id)?.onChrome(e);
  }),
);

editor.on(
  "active_buffer_changed",
  guarded("active_buffer_changed", (e: HookEventMap["active_buffer_changed"]) => {
    // The first focus announcement comes with no `active_window_changed`
    // (INV §11.3): a window with no section yet gets one now.
    if (!sections.has(e.window_id) && e.window_id === editor.activeWindow()) onActivated();
    sections.get(e.window_id)?.onActiveBuffer(e);
  }),
);

editor.on(
  "buffer_closed",
  guarded("buffer_closed", (e: HookEventMap["buffer_closed"]) => {
    sections.get(e.window_id)?.onBufferClosed(e);
  }),
);

editor.on("active_window_changed", guarded("active_window_changed", onActivated));
editor.on(
  "window_closed",
  guarded("window_closed", (e: HookEventMap["window_closed"]) => drop(e.id)),
);

// ---------------------------------------------------------------------------
// Palette (R18)
// ---------------------------------------------------------------------------

/** `Git Sidebar:` prefix: the host keys plugin commands by display name,
 *  and a later registration of the same name replaces an earlier one. Each
 *  handler is `gitSidebar_<cmd>`, the name a key binding uses (R27). They
 *  act on the active window's section (R28). */
const COMMANDS: { name: string; description: string; cmd: PaletteCommand }[] = [
  { name: "Git Sidebar: View Diff", description: "Side-by-side diff of the file selected in the Git section", cmd: "viewDiff" },
  { name: "Git Sidebar: View File", description: "Open the file selected in the Git section", cmd: "viewFile" },
  { name: "Git Sidebar: Stage or Unstage", description: "Stage or unstage the file selected in the Git section", cmd: "toggle" },
  { name: "Git Sidebar: Stage All", description: "Stage every file under Changes", cmd: "stageAll" },
  { name: "Git Sidebar: Unstage All", description: "Unstage every file under Staged Changes", cmd: "unstageAll" },
  { name: "Git Sidebar: Commit…", description: "Commit what is staged, with a one-line message", cmd: "commit" },
  { name: "Git Sidebar: Resolve Conflict", description: "Open the conflicted file selected in the Git section and start Fresh's merge resolution", cmd: "resolve" },
];
const FOCUS_HANDLER = "gitSidebar_focus";

/** A palette command in a window with no section: what it would say with no
 *  rows. */
function paletteCommand(cmd: PaletteCommand): void {
  const s = activeSection();
  if (s !== undefined) {
    s.paletteCommand(cmd);
    return;
  }
  const t = paletteTarget(cmd, null, null, NO_ENTRIES);
  if (!t.ok) editor.setStatus(t.message);
}

function focusSection(): void {
  const s = activeSection();
  if (s !== undefined) s.focusSection();
  else editor.setStatus(NOT_SHOWN);
}

guarded("palette", () => {
  for (const c of COMMANDS) {
    const handler = `gitSidebar_${c.cmd}`;
    registerHandler(handler, guarded(handler, () => paletteCommand(c.cmd)));
    // Listed only while the section shows rows (R18; INV §8, P11).
    editor.registerCommand(c.name, c.description, handler, ROWS_CONTEXT);
  }
  // Listed whenever the section is shown at all (R22).
  registerHandler(FOCUS_HANDLER, guarded(FOCUS_HANDLER, focusSection));
  editor.registerCommand("Git Sidebar: Focus", "Move the keyboard to the Git section", FOCUS_HANDLER, SHOWN_CONTEXT);
})();

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** The active window's section only: another window's refreshes when it is
 *  active again (R28). These hooks carry no window id, or come only from the
 *  active window (INV §11.4). */
const onChange = guarded("trigger", () => activeSection()?.requestRefresh());
editor.on("after_file_save", onChange);
editor.on("after_file_revert", onChange);
editor.on("focus_gained", onChange);
editor.on("after_file_explorer_change", onChange);
// Authority and trust are the active window's, and the hooks say nothing
// else (INV §11.4). The authority hook also comes on a switch between windows
// with different labels, after the active window has changed, so it restarts
// a section only when that window's own label changed (`checkAuthority`).
editor.on("authority_changed", guarded("authority_changed", () => activeSection()?.checkAuthority()));
editor.on("trust_changed", guarded("trust_changed", () => activeSection()?.restart(false)));

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

// Mount now for the active window, when its folder looks like a repository:
// a section mounted later than a few frames after startup loses the divider
// the user dragged (INV §8, P2). Other windows get theirs when they first
// become active (R28).
guarded("load", () => {
  // The host keeps a context across a plugin reload: clear those a previous
  // load left set in the active window, so the palette lists nothing before
  // rows are shown, nor Focus before the section is (R18, R22, INV §9.6).
  // Other windows' are set again when they become active (`syncContexts`).
  editor.setContext(ROWS_CONTEXT, false);
  editor.setContext(SHOWN_CONTEXT, false);
  editor.defineMode(DIFF_MODE, [["Enter", "gitSidebar_diffEnter"]], true);
  // The section of the plugin before R28, kept by the host across a reload
  // after an update (INV §2). Unmounting an id that is not mounted is a no-op.
  editor.unmountFloatingWidget(LEGACY_PANEL);
  ensureSection(editor.activeWindow());
})();
