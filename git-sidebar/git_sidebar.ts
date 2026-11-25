// git-sidebar: a "Git" section under the file explorer with the current
// branch and three groups, Staged Changes, Changes and Graph, kept current. A click
// or Enter on a file opens its side-by-side diff (R14), and Enter in the
// diff opens the file at its line (R19, R20); `+`/`−` and Space stage and
// unstage (R15, R16); a right-click opens the row's menu (R17), with
// Resolve Conflict (R25) and Commit… (R26); the palette has the same
// commands, and Focus (R18, R22). Switching to a listed file selects its
// row (R23). Each window has a section of its own, for its own folder (R28).
// Next and Previous Change move through the diff (R29). The Graph shows the
// branch's history with each commit's files, their diffs, View Commit and
// the copies (R30–R33, INV §12.3); Pull and Push sit beside Commit…
// (R34–R36, INV §12.4).
//
// This file only wires the editor to the pure pieces in lib/: status parsing
// (status.ts), the tree (view.ts), what each row offers (actions.ts), the
// diff view (diff.ts; its panes and marks, diff_view.ts; where it opens,
// placement.ts), staging (stage.ts), refresh timing (scheduler.ts),
// where git runs (git.ts), each window's panel id (windows.ts), and the
// Graph: its reads (history.ts), lanes (lanes.ts), rows (graph.ts) and
// when it reads the log (graph_state.ts).
// Collapsing the whole section, its height and its position belong to the
// host; the plugin keeps the section mounted and updates it in place.
//
// `makeSection` holds one window's section: everything that was the whole
// plugin before R28. The rest of the file routes the editor's events to the
// section they are about, and keeps what is the editor's alone: the timer,
// the right-click menu, the keyboard's region and the palette.

import { dirReason, nameReason, parseStatus, title as statusTitle, unpassable, type Status } from "./lib/status.ts";
import {
  anchorArg,
  buttonLabel,
  conflicted,
  isGraphCommand,
  menuChoice,
  menuItems,
  menuSpec,
  NO_ROWS,
  NOT_SHOWN,
  paletteTarget,
  rowAction,
  type GraphCommand,
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
  utf8Length,
  type GroupPlan,
} from "./lib/stage.ts";
import {
  blobRefusal,
  contentToEntries,
  DIFF_HINT,
  DiffSlot,
  lineCount,
  MAX_DIFF_BYTES,
  NO_NEXT_CHANGE,
  NO_PREVIOUS_CHANGE,
  NO_SECTION_DIFF,
  openLine,
  refusal,
  refusalMessage,
  sideOf,
  sizeRefusal,
  sourceName,
  statusDiffTarget,
  type DiffTarget,
  type Refusal,
  type Side,
  type View,
} from "./lib/diff.ts";
import {
  centreLine,
  diffLayout,
  facingLine,
  headerEntries,
  headerPanel,
  lineTotal,
  onePaneHunks,
  paint,
  paneSides,
  stepHunk,
  viewHunks,
  type PaneSide,
  type SidePaint,
  type ViewHunk,
} from "./lib/diff_view.ts";
import { isFile, splitCandidates } from "./lib/placement.ts";
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
  failReason,
  gitReason,
  commitMessage,
  HEAD_SUMMARY_ARGS,
  isDefinitiveFailure,
  objectId,
  run,
  runOn,
  runWrite,
  shortId,
  STATUS_ARGS,
  TOPLEVEL_ARGS,
  trimSlash,
  type Detected,
  type GitResult,
  type Mode,
  type Runner,
} from "./lib/git.ts";
import { LEGACY_PANEL, panelIdFor, windowKey } from "./lib/windows.ts";
import { commitDiffTarget, commitOf, GRAPH_KEY, type GraphRows } from "./lib/graph.ts";
import { GraphState } from "./lib/graph_state.ts";
import { commitMessageText, messageArgs, showArgs } from "./lib/history.ts";
import {
  classifyPull,
  classifyPush,
  configuredSsh,
  HEAD_REF_ARGS,
  parseRemotes,
  parseUpstream,
  publishArgs,
  pullArgs,
  pullTargetCheck,
  pushArgs,
  remoteArgv,
  remoteEnv,
  REMOTES_ARGS,
  SSH_CONFIG_ARGS,
  sshCommand,
  upstreamArgs,
  upstreamName,
} from "./lib/remote.ts";

const editor = getEditor();

/** The plugin's name as the host gives it: the entry file's stem (INV §4).
 *  `chrome_focus_changed` names a section by it (INV §8 P28 c). */
const PLUGIN_NAME = "git_sidebar";
/** The right-click menu (R17): a floating panel of its own. Its `cancel`
 *  (Esc, a click outside) closes only the menu, never the section. Each
 *  window's section has its own panel id (`panelIdFor`, never 0 to 2). */
const MENU = 2;
const TICK = "gitSidebarTick";
/** The diff view's keymap, read-only (R14), on its sources: in a buffer
 *  group Fresh gives none of its side-by-side keys, so every key of R20 is
 *  bound here (INV §8 P41 k, P42 f), and Enter opens the file (R19). Also
 *  the palette context of Next and Previous Change: the host lists a
 *  command whose context is the focused buffer's mode
 *  (`command_registry.rs:236-243`, INV §8 P39 k), so they are listed
 *  exactly while a section diff is the active tab (R29). Only the diff's
 *  sources may have this mode. */
const DIFF_MODE = "git-sidebar-diff";
/** R20's keys. `j`/`k` name Fresh's built-in `scroll_down`/`scroll_up`,
 *  which scroll the focused pane and its sync partner without moving the
 *  cursor (H9, P42 f): action names, not API, so recheck them after a
 *  Fresh upgrade. */
const DIFF_KEYS: [string, string][] = [
  ["Enter", "gitSidebar_diffEnter"],
  ["n", "gitSidebar_nextChange"],
  ["]", "gitSidebar_nextChange"],
  ["p", "gitSidebar_prevChange"],
  ["[", "gitSidebar_prevChange"],
  ["q", "gitSidebar_diffClose"],
  ["Escape", "gitSidebar_diffClose"],
  ["Tab", "gitSidebar_diffSwitch"],
  ["BackTab", "gitSidebar_diffSwitch"],
  ["j", "scroll_down"],
  ["k", "scroll_up"],
];
/** The namespace of the diff's decorations (R38, R39). */
const DIFF_NS = "git-sidebar-diff";
/** Scroll sync group ids are the plugin's, editor-wide, while split ids
 *  repeat across windows (H13): one counter for every window's diffs. A
 *  group goes away with its panes, so nothing removes one. */
let syncSeq = 0;
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
const NO_GRAPH: GraphRows = new Map();
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
/** The prompt type of Publish's question (R35): every prompt hook fires for
 *  every prompt, so its answers are told apart by it (INV §8 P39 h). */
const PUBLISH_PROMPT = "git-sidebar-publish";
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

/** An environment variable of Fresh's own, which git inherits (INV §8 P39
 *  c): `getEnv` gives `undefined` for one that is not set. */
function envVar(name: string): string | null {
  const v: unknown = editor.getEnv(name);
  return typeof v === "string" ? v : null;
}
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
  /** Group and commit expansion, owned here because a remount resets the
   *  host's. All three groups start expanded (R3). */
  const expanded = new Set<string>([STAGED_KEY, CHANGES_KEY, GRAPH_KEY]);
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
   *  (`raw`), so a refresh with the same output builds nothing (R10); and
   *  the Graph rows drawn with them (`graph`), by key, which its menus, the
   *  palette, View File and the diff act on. Graph rows are kept out of
   *  `entries`, which every write reads, so no write can reach one (R30,
   *  R32: they have no button). Null under a notice, the placeholder, or no
   *  section. Every row action and palette command reads this, so none acts
   *  on rows that are not on screen (R13, R17, R18): in volume mode that
   *  would be host git on the wrong folder. ROWS_CONTEXT is set exactly
   *  while it is not null, while `win` is active. */
  let rows: { status: Status; entries: EntryMap; raw: string; graph: GraphRows } | null = null;
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
   *  or null. */
  let hintFor: View | null = null;
  /** The Graph's commits, lanes, files and when to read the log (R30–R32). */
  const graph = new GraphState({ runner, live: (e) => live(e), say: (m) => say(m) });
  /** View Commit's one tab (R33): its buffer. Which View Commit is the
   *  latest is the slot's generation (`DiffSlot.claim`), so a slower earlier
   *  one, or one overtaken by a diff, opens nothing. */
  let commitTab: number | null = null;
  /** The split View Commit's tab was shown in, recorded then: a replacing
   *  tab opens there (R37). `BufferInfo.splits` would not tell once another
   *  tab of that split is the visible one (H15). */
  let commitSplit: number | null = null;
  /** The split that was last the active one while it showed a file or one
   *  of the section's tabs: where a new section tab opens (R37). The dock
   *  never shows a file (INV §13.1), so it is never this. Tracked on
   *  `active_buffer_changed` (`track`); null until then. */
  let lastSplit: number | null = null;
  /** Set from the focus that places a section tab until the tab is made
   *  (`enterTarget`): a frame between them may announce the target split's
   *  own tab (H16, P42 d), which must neither move the selection (R23) nor
   *  be tracked. A count: two builds can be placing at once. */
  let placing = 0;
  /** This window's open Publish prompt (R35): the answer it waits for.
   *  Prompts are each window's own (INV §11.4), and the prompt hooks name
   *  no window: a prompt is answered in the active window, so the hooks go
   *  to its section (`answerPublish`). */
  let publishAnswer: ((input: string | null) => void) | null = null;

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
  const leftovers: number[][] = [];

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

  /** The section's tree for `status`: its groups with their buttons, and
   *  the Graph's rows as they stand. The one builder, so a status change
   *  never drops the Graph's rows and moves a selection in it (R10). */
  function treeFor(status: Status, entries: EntryMap): TreeSpec {
    return buildTree(status, (key) => buttonLabel(key, status, entries), graph.part(expanded));
  }

  /** Draw a status; whether the section now shows it. */
  function showStatus(stdout: string): boolean {
    const status = parseStatus(stdout);
    const entries = entryMap(status);
    // The host refused it: the rows, their entries and the palette context
    // stay those of the status still on screen (R13, R18), and the next
    // refresh, whose output differs from theirs, draws this one again.
    if (!show(statusTitle(status), treeFor(status, entries))) return false;
    setRows({ status, entries, raw: stdout, graph: graph.rows() });
    return true;
  }

  /** Draw the rows again for the status on screen: the Graph changed
   *  (R30–R32). In place, under the same title. */
  function redraw(): void {
    if (rows === null) return;
    if (show(statusTitle(rows.status), treeFor(rows.status, rows.entries))) rows.graph = graph.rows();
  }

  function showNotice(text: string): void {
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
    if (!(r.stdout === rows?.raw || showStatus(r.stdout))) return;
    ops.release(seq);
    // The Graph, in the same tick: the scheduler times the whole refresh, so
    // R11's 25% covers its reads too.
    if (rows !== null) await refreshGraph(myEpoch, m, root, rows.status);
  }

  /**
   * The Graph after a status (R30): the log when HEAD, the branch or the
   * upstream moved, or something forced it (`GraphState.afterStatus`); then
   * the files of expanded commits not read yet, such as after Load more or a
   * switch back to the window; then the rows again if anything changed, with
   * Load more's first new commit selected (R30). Every read checks `live`
   * first (R28).
   */
  async function refreshGraph(myEpoch: number, m: Exclude<Mode, "volume">, r0: string, status: Status): Promise<void> {
    let changed = await graph.afterStatus(status, m, r0, myEpoch, expanded.has(GRAPH_KEY));
    if (myEpoch !== epoch) return;
    // The host keeps a dropped key expanded otherwise: an update in place
    // ignores the spec's seeds, and the commit could come back.
    if (graph.prune(expanded)) pushExpanded();
    for (const id of graph.unread(expanded)) {
      if (await graph.ensureFiles(id, m, r0, myEpoch)) changed = true;
      if (myEpoch !== epoch) return;
    }
    if (changed) redraw();
    const first = graph.takeSelection();
    if (first !== null) {
      const index = shownKeys.indexOf(first);
      if (index >= 0) {
        recordSelection(first, index);
        pushSelection(index);
      }
    }
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
    // A Publish prompt still open: its flow sees the end and does nothing.
    answerPublish(null);
    stop(false);
    armActive();
  }

  /** Enter on a group or a commit row toggles it: the host does not (INV §8
   *  P39 g), and pushing the keys sends no `expand` back. */
  function toggleGroup(key: string): void {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    pushExpanded();
    if (expanded.has(key)) onExpanded(key);
  }

  /** A row was just expanded, by the host or by Enter. The Graph group: read
   *  the log now, as nothing ran while it was collapsed (R11, R30). A
   *  commit: list its files (R32). */
  function onExpanded(key: string): void {
    if (key === GRAPH_KEY) {
      graph.forceNext();
      requestRefresh();
      return;
    }
    const row = rowKind(key);
    if (row.kind === "commit") void guardedAsync("files", () => loadFiles(row.id))();
  }

  /** A commit's files, read when it is expanded (R32), then drawn. A
   *  failure says git's reason and lists none (`GraphState.ensureFiles`).
   *  Drawn whether they were read now or kept from before: a commit
   *  collapsed and expanded again keeps its files, but a redraw while it was
   *  collapsed dropped its rows, and the host shows children only when sent
   *  (INV §8 P36 d). An unchanged tree makes no widget call. */
  async function loadFiles(id: string): Promise<void> {
    if (!isActive()) return;
    const ready = readiness();
    if ("why" in ready) return;
    const myEpoch = epoch;
    await graph.ensureFiles(id, ready.mode, ready.root, myEpoch);
    if (myEpoch === epoch) redraw();
  }

  /** Load more (R30): one more page of commits on a refresh now; the first
   *  new one is selected once drawn (`refreshGraph`). A second press while it
   *  loads does nothing: a double click loads one page (R30). */
  function loadMore(): void {
    if (graph.loadMore()) requestRefresh();
  }

  /** What a row action runs against: the rows shown, the root and where git
   *  runs; or why none can run now. Under a notice or the placeholder there
   *  are no rows to act on. */
  type Readiness = { why: string } | { status: Status; entries: EntryMap; graph: GraphRows; root: string; mode: Exclude<Mode, "volume"> };

  function readiness(): Readiness {
    if (rows === null || root === null) return { why: NO_ROWS };
    if (mode === null) return { why: FINDING_MODE };
    if (mode === "volume") return { why: "the sources are in a container volume" };
    return { status: rows.status, entries: rows.entries, graph: rows.graph, root, mode };
  }

  /** The row's file in the working tree as an absolute path, when it is a
   *  regular file that View File may open; otherwise null, after saying why.
   *  A status row, or a commit's file (R7, R32), whose working-tree file
   *  is opened: the one a commit changed may since be gone. A commit file's
   *  key holds its path, so Enter in its diff (R19) opens it once its row
   *  is no longer listed too. */
  function fileToOpen(key: string): string | null {
    const row = rowKind(key);
    if (root === null) return null;
    let rel: string;
    let dir: boolean;
    if (row.kind === "file") {
      rel = row.path;
      dir = rows?.entries.get(key)?.entry.dir === true;
    } else if (row.kind === "commitFile") {
      // The key's path is the entry's (`commitFileKey`).
      const entry = rows?.graph.get(key)?.entry;
      rel = row.path;
      dir = entry?.dir === true;
    } else {
      return null;
    }
    if (dir) {
      say(dirReason(trimSlash(rel)));
      return null;
    }
    // Status names it lossily (F6): the path names no file, so the stat below
    // would call it deleted.
    if (unpassable(rel)) {
      say(nameReason(rel));
      return null;
    }
    const path = editor.pathJoin(root, rel);
    // openFile on a missing path would create a new buffer, and `fileExists`
    // is true for a directory too (a deleted file's path reused by one, a
    // symlink to one).
    const stat = editor.fileStat(path) as { isFile?: unknown; isDir?: unknown } | null;
    if (stat?.isFile === true) return path;
    say(stat?.isDir === true ? `${rel} is a directory` : `${rel} is deleted`);
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

  /** Close buffers of a diff view or View Commit's tab, each once (a second
   *  close of a buffer logs an ERROR, H14). Closing a diff's source closes
   *  its group too (H4), so the sources are all a diff needs. `closeBuffer`
   *  acts on the active window (INV §11.4), so another window's buffers wait
   *  until it is active again (`leftovers`). */
  function dropView(ids: Iterable<number>): void {
    const list = [...ids];
    if (list.length === 0) return;
    if (!isActive()) {
      leftovers.push(list);
      log(`window ${win}'s diff closes once it is active`);
      return;
    }
    for (const id of list) editor.closeBuffer(id, true);
  }

  /** Close a diff view the plugin made: its sources not yet closed, which
   *  takes its group with them (R14 "no leftovers"). Never `closeBufferGroup`
   *  (it would leave the sources open) nor `removeScrollSyncGroup` (the sync
   *  group goes with its panes, H13). */
  function closeView(v: View): void {
    const ids = [...v.open];
    v.open.clear();
    dropView(ids);
  }

  /** What the row `key` diffs (R14, R32): a Staged, Changes or conflicted
   *  row through its status entry, a commit's file through the Graph's
   *  rows; null for any other row, or one no longer listed. */
  function diffTargetOf(key: string, status: Status, entries: EntryMap, graphRows: GraphRows): DiffTarget | null {
    const listed = entries.get(key);
    if (listed !== undefined) return statusDiffTarget(listed.entry, listed.group, status.oid === null, key);
    const g = graphRows.get(key);
    return g?.entry === undefined ? null : commitDiffTarget(g.commit, g.entry, key);
  }

  /**
   * Open the row's side-by-side diff in the editor area (R37), replacing the
   * one shown (R14), whichever row it is for: a status row or a commit's
   * file (R32). The keyboard stays in the section (INV §8 P42 d, k).
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
    const target = diffTargetOf(key, ready.status, ready.entries, ready.graph);
    if (target === null) return;
    // A directory, a name that is not UTF-8 (F6), or a symbolic link.
    if (target.refusal !== null) {
      // This click is the latest: a slower build for an earlier click must
      // not open its diff after this message (R14 "each later click"), nor a
      // slower View Commit its tab (R33).
      slot.invalidate();
      say(refusalMessage(target.refusal === "unpassable name" ? target.refusedName : target.path, target.refusal));
      return;
    }
    await buildDiff(target, ready.mode, ready.root);
  }

  /** Whether split `id` exists in this window now, checked without
   *  focusing it: a focus on a split that is gone logs a WARN (P42 e).
   *  `listSplits` leaves out a split whose visible tab is a buffer group
   *  (H3), so the split of the diff shown now counts too. */
  function splitExists(id: number): boolean {
    return id === slot.current()?.split || editor.listSplits().some((s) => s.splitId === id);
  }

  /**
   * Make the split a new section tab belongs in the active one, right
   * before the tab is made (R37): Fresh puts a buffer group, or a new
   * virtual buffer's tab, in the active split, which may be the dock (H1,
   * INV §13.1). The caller sets `placing` around this and the creation, and
   * no `flush` may come between them: a frame between would announce the
   * target's own tab (H16, P42 k).
   *
   * - A diff replacing the one shown (`replacing`): a focus on one of its
   *   panels, so the new group lands in its split (P42 d (ii): one
   *   announcement, for the new view, none for the old one; P42 l for one
   *   pane).
   * - Otherwise the first of `splitCandidates` that exists, `replacingSplit`
   *   (View Commit's) first; the active split when none does.
   *
   * Never `showBuffer` or create a section tab without this.
   */
  function enterTarget(replacing: View | null, replacingSplit: number | null): void {
    if (replacing !== null) {
      editor.focusBufferGroupPanel(replacing.group, replacing.left !== null ? "left" : "right");
      return;
    }
    const panes = editor.describeWorkspace().panes;
    const target = splitCandidates({ replacing: replacingSplit, last: lastSplit, panes }).find(splitExists);
    if (target !== undefined && target !== editor.getActiveSplitId()) editor.focusSplit(target);
  }

  /** Track the split the user works in (R37 "Which split"): the active
   *  split, when buffer `id`, now its active tab, is a file or one of the
   *  section's tabs. Never by its path: a terminal has one (H12). */
  function track(id: number): void {
    if (!isActive()) return;
    const v = slot.current();
    const sectionTab = id === commitTab || (v !== null && sideOf(v, id) !== null);
    if (sectionTab || isFile(editor.getBufferInfo(id))) lastSplit = editor.getActiveSplitId();
  }

  /** One pane's decorations (R38 "Changes", R39): line and span tints,
   *  blank rows facing the other side's lines, gutter marks and scrollbar
   *  marks. */
  function decorate(buffer: number, p: SidePaint): void {
    for (const [a, b] of p.lines) editor.addOverlay(buffer, DIFF_NS, a, b, { bg: p.lineBg, extendToLineEnd: true });
    for (const [a, b] of p.spans) editor.addOverlay(buffer, DIFF_NS, a, b, { bg: p.spanBg });
    for (const f of p.fillers) {
      for (let i = 0; i < f.count; i++) editor.addVirtualLine(buffer, f.anchor, "", { bg: p.fillerBg }, f.above, DIFF_NS, i);
    }
    const [r, g, b] = p.gutterColor;
    if (p.gutter.length > 0) editor.setLineIndicators(buffer, p.gutter, DIFF_NS, p.gutterSymbol, r, g, b, 10);
    if (p.markers.length > 0) editor.setScrollbarMarkers(buffer, DIFF_NS, p.markers);
  }

  /**
   * Build and show the diff of `target` (R14, R38): a buffer group over
   * hidden read-only sources, one pane when a side is empty (R38 "One
   * side"). Every await re-checks the epoch, the slot's generation and the
   * window: buffers open in the active window, so a build overtaken by a
   * switch stops (R28). A stale build closes what it made.
   */
  async function buildDiff(target: DiffTarget, m: Exclude<Mode, "volume">, r: string): Promise<void> {
    const { key, path } = target;
    const gen = slot.begin(key);
    // The same row's build is pending: a double-click (INV §9.1) joins it.
    // Otherwise the generation moved: a View Commit still reading opens no
    // tab after this diff (R14, R33).
    if (gen === null) return;
    const myEpoch = epoch;
    const stale = () => !live(myEpoch) || !slot.isCurrent(gen);
    const saidBefore = said;
    try {
      // Both sides at once; a git object's side reads its id, its size, then
      // its content.
      const got = await Promise.all([readSide(target.left, m, r, stale), readSide(target.right, m, r, stale)]);
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
      const [leftText, rightText] = reads.map((x) => x.text);
      const [leftLabel, rightLabel] = target.labels;
      // A zero-byte side gets no pane (R38 "One side", INV §8 P42 b).
      const sides = paneSides(leftText.length, rightText.length);
      // Hidden, read-only sources: the diff is a snapshot, not an editor
      // (R14). Each holds its exact text: `compareBuffers` keeps each line's
      // newline, so a change to the final newline alone is a change (H17,
      // P42 i).
      const source = (label: string, text: string) =>
        editor.createVirtualBuffer({
          name: sourceName(label, path),
          mode: DIFF_MODE,
          readOnly: true,
          editingDisabled: true,
          hiddenFromTabs: true,
          showLineNumbers: true,
          entries: text === "" ? [] : [{ text }],
        });
      // One at a time, each id kept as it comes: until the slot has the view,
      // nothing else knows these buffers, so a call that throws or rejects
      // part-way closes what was made (R14 "no leftovers"). Closing them
      // also closes a group made over them (H4).
      const made: number[] = [];
      let view: View;
      try {
        let left: number | null = null;
        let right: number | null = null;
        if (sides !== "right") {
          left = (await source(leftLabel, leftText)).bufferId;
          made.push(left);
          if (stale()) {
            dropView(made);
            return;
          }
        }
        if (sides !== "left") {
          right = (await source(rightLabel, rightText)).bufferId;
          made.push(right);
          if (stale()) {
            dropView(made);
            return;
          }
        }
        // One line diff of the two buffers gives every decoration and the
        // alignment (INV §13.3); a one-pane diff has none (R38 "One side").
        let compared: CompareResult | null = null;
        if (left !== null && right !== null) {
          try {
            compared = await editor.compareBuffers(left, right);
          } catch (e) {
            dropView(made);
            if (!stale()) say(`could not compare ${path}: ${String(e)}`);
            return;
          }
          if (stale()) {
            dropView(made);
            return;
          }
        }
        // Placed in the editor area, never the dock (R37).
        let group: BufferGroupResult;
        placing++;
        try {
          enterTarget(slot.current(), null);
          group = await editor.createBufferGroup(target.title, "", diffLayout(left, right));
        } finally {
          placing--;
        }
        if (stale()) {
          dropView(made);
          return;
        }
        const g = group.groupId;
        const panelSplit = (side: PaneSide): number | undefined => group.panelSplits[side];
        // Each pane under its side's header, unwrapped: a borrowed panel
        // takes `editor.line_wrap`, on by default (H7, R38 "Aligned").
        for (const [side, buffer, label] of [
          ["left", left, leftLabel],
          ["right", right, rightLabel],
        ] as const) {
          if (buffer === null) continue;
          editor.setPanelContent(g, headerPanel(side, sides), headerEntries(label));
          editor.setLineWrap(buffer, panelSplit(side) ?? null, false);
        }
        let hunks: ViewHunk[];
        let at: number | null = null;
        if (compared !== null && left !== null && right !== null) {
          const p = paint(compared);
          decorate(left, p.left);
          decorate(right, p.right);
          const [ls, rs] = [panelSplit("left"), panelSplit("right")];
          if (ls !== undefined && rs !== undefined) {
            const sync = ++syncSeq;
            editor.createScrollSyncGroup(sync, ls, rs);
            editor.setScrollSyncAnchors(sync, p.anchors);
          }
          hunks = viewHunks(compared);
          // Both cursors on the first change, in view (R38 "Cursors").
          const first = hunks[0];
          if (first !== undefined) {
            at = 0;
            editor.setBufferCursor(left, first.left.jump);
            editor.setBufferCursor(right, first.right.jump);
            if (ls !== undefined) editor.scrollToLineCenter(ls, left, centreLine(first.left));
          }
        } else {
          const side: PaneSide = left !== null ? "left" : "right";
          hunks = onePaneHunks(side, lineTotal(side === "left" ? leftText : rightText));
        }
        view = {
          group: g,
          left,
          right,
          open: new Set(made),
          key,
          hunks,
          at,
          rightLines: lineTotal(rightText),
          // The host split: a panel's own is not the active split (P41 n).
          split: editor.getActiveSplitId(),
          panelSplits: { left: panelSplit("left"), right: panelSplit("right") },
        };
      } catch (e) {
        dropView(made);
        throw e;
      }
      // Shown, then the one it replaces closed: one tab (R14).
      const prev = slot.install(view);
      if (prev !== null) closeView(prev);
      // The diff's keys work only once the keyboard is in the diff, and a
      // click or Enter on a row leaves it in the section (R14), so then the
      // hint waits for it to move in (`hintIfInDiff`). Not over a message
      // sent during the build, such as a write's outcome (R15, R26), which
      // nothing would say again.
      hintFor = sectionFocused ? view : null;
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
   * the rows on screen: it covers paths past the 1,000-row cap, and none that
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
      say(`could not read the status: ${failReason(st, r0)}`);
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
    const before = paletteTarget("commit", selectedKey, ready.status, ready.entries, ready.graph);
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
    const now = paletteTarget("commit", selectedKey, rows.status, rows.entries, rows.graph);
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

  /** Ask which remote to publish `branch` to (R35), with one suggestion per
   *  remote; the first is highlighted, so Enter at once picks it (INV §8 P39
   *  h). Resolves with the answer, typed or picked, or null for Esc. A
   *  Publish asked again in this window answers its own older one with
   *  null; another window's is left alone (INV §11.4). */
  function askPublish(branch: string, remotes: string[]): Promise<string | null> {
    answerPublish(null);
    return new Promise((resolve) => {
      publishAnswer = resolve;
      editor.startPrompt(`Publish ${branch} to: `, PUBLISH_PROMPT);
      editor.setPromptSuggestions(remotes.map((r) => ({ id: r, text: r, value: r })));
    });
  }

  /** This window's Publish prompt answered: the input, or null for Esc. */
  function answerPublish(input: string | null): void {
    const answer = publishAnswer;
    publishAnswer = null;
    answer?.(input);
  }

  /**
   * Pull or Push (R34, R35), from the palette or the Graph group's menu.
   * Detached, or a Pull with no upstream: no git, a message. A Push with no
   * upstream publishes (R35): the remotes are read, and with none no prompt
   * opens; otherwise a prompt asks which remote, before anything is queued,
   * as Commit… does, so declining leaves nothing queued (R35). Esc cancels,
   * an answer that is not a listed remote too, and one given after a switch
   * to another window does nothing (R28). The epoch is taken before the
   * prompt opens, so a restart while it is open is caught (`stillAsked`).
   * Then the write queue runs it, one at a time with stages, unstages and
   * commits, in the order asked (R36); a second request while one is queued
   * or not yet drawn is refused, and says so, as a second Commit… is (R26).
   */
  async function remoteFlow(kind: "pull" | "push"): Promise<void> {
    const ready = readiness();
    if ("why" in ready) {
      say(ready.why);
      return;
    }
    const { status } = ready;
    const branch = status.branch;
    if (branch === null) {
      say(`HEAD is detached: check out a branch to ${kind}`);
      return;
    }
    if (kind === "pull" && status.upstream === null) {
      say(`${branch} has no upstream to pull from`);
      return;
    }
    const busy = `a ${kind} is still finishing; try again in a moment`;
    const ops = queueFor(ready.root);
    if (ops.blocked(kind)) {
      say(busy);
      return;
    }
    // The epoch the request was made in, before any prompt opens (as in
    // `commitFlow`): a restart while it is open stops the write.
    const asked = epoch;
    let publishTo: string | null = null;
    if (kind === "push" && status.upstream === null) {
      if (!isActive()) return;
      const myEpoch = epoch;
      const remotes = parseRemotes(await run(runner, ready.mode, "git", REMOTES_ARGS, ready.root));
      if (!live(myEpoch)) return;
      if (remotes.length === 0) {
        say(`${branch} has no upstream, and there is no remote to publish it to`);
        return;
      }
      const answer = await askPublish(branch, remotes);
      if (phase === "ended") return;
      if (!isActive()) {
        say(`push not run: ${OTHER_WINDOW}`);
        return;
      }
      if (answer === null) {
        say("push cancelled");
        return;
      }
      const picked = answer.trim();
      if (!remotes.includes(picked)) {
        say(`${picked === "" ? "no remote given" : `${picked} is not a remote`}; push cancelled`);
        return;
      }
      publishTo = picked;
    }
    const queued = ops.enqueue(kind, guardedAsync(kind, () => remoteWrite(kind, branch, publishTo, asked)));
    if (queued === null) say(busy);
  }

  /**
   * The queued pull or push (R34–R36), after `groupWrite`: it runs only
   * while still asked for (`stillAsked`), reads the branch's upstream and
   * the repository's ssh command again, as they stand when it runs, and
   * Fresh's own `GIT_SSH_COMMAND` and `GIT_SSH`, and checks the window again
   * after those reads: git would run on another window's authority (R28).
   * A pull integrates into HEAD, so it runs only while `branch`, the one on
   * screen when it was asked for, is still checked out: the branch is
   * switched in a terminal, or by a write queued before it (R34). A push
   * names its branch in full, so it needs no such check. Then `env … git
   * pull|push`, never killed: after 60 s it says git is still running (INV
   * §8 P37 g, h). How it went is said; the queue's refresh shows the rest,
   * the title's `↑A ↓B` and the Graph included.
   */
  async function remoteWrite(kind: "pull" | "push", branch: string, publishTo: string | null, asked: number): Promise<void> {
    const where = stillAsked(kind, asked);
    if (where === null) return;
    const { m, r0 } = where;
    const myEpoch = epoch;
    // A switch to another window before git starts: it would run on that
    // window's authority (R28). After a restart there is nothing to say.
    const overtaken = (): boolean => {
      if (live(myEpoch)) return false;
      if (myEpoch === epoch) say(`${kind} not run; ${OTHER_WINDOW} before it started`);
      return true;
    };
    let args: string[];
    let name: string;
    if (publishTo !== null) {
      args = publishArgs(publishTo, branch);
      name = `${publishTo}/${branch}`;
    } else {
      const u = parseUpstream(await run(runner, m, "git", upstreamArgs(branch), r0));
      if (myEpoch !== epoch) return;
      if (u === null) {
        say(kind === "pull" ? `${branch} has no upstream to pull from` : `${branch} has no upstream any more; push again to publish it`);
        return;
      }
      args = kind === "pull" ? pullArgs(u) : pushArgs(u, branch);
      name = upstreamName(u);
    }
    if (overtaken()) return;
    const configured = configuredSsh(await run(runner, m, "git", SSH_CONFIG_ARGS, r0), kind, r0);
    if (overtaken()) return;
    if ("refused" in configured) {
      say(configured.refused);
      return;
    }
    if (kind === "pull") {
      const head = await run(runner, m, "git", HEAD_REF_ARGS, r0);
      if (overtaken()) return;
      const refused = pullTargetCheck(head, branch, r0);
      if (refused !== null) {
        say(refused);
        return;
      }
    }
    const ssh = sshCommand({
      envCommand: envVar("GIT_SSH_COMMAND"),
      configured: configured.command,
      envSsh: envVar("GIT_SSH"),
    });
    const argv = remoteArgv(args, remoteEnv(ssh));
    const r = await runWrite(
      runner,
      m,
      argv,
      r0,
      (left) => {
        if (myEpoch === epoch) say(`${kind}: git is ${left.stderr}`);
      },
      "env",
    );
    const outcome = kind === "pull" ? classifyPull(r, name, r0) : classifyPush(r, name, r0);
    if (myEpoch !== epoch) {
      log(`${kind} finished after a restart: ${outcome.message}`);
      return;
    }
    say(outcome.message);
  }

  function remoteSoon(kind: "pull" | "push"): void {
    void guardedAsync(kind, () => remoteFlow(kind))();
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
    switch (row.kind) {
      case "group":
        // Space does what the group's button does (R16); the host does not
        // toggle a group on Enter, so Enter does (R7). The Graph group has no
        // button: Space there does nothing.
        if (space) rowOp(key);
        else toggleGroup(key);
        return;
      case "file":
        // Space does what the row's button does (R15); it never opens
        // anything (R7). Enter is the keyboard twin of a click (R14).
        if (space) rowOp(key);
        else openDiffSoon(key);
        return;
      // Graph rows have no button: Space on one changes nothing (R30), and
      // is not sent to `rowOp`, which can still say why no row acts. Enter
      // toggles a commit, which the host does not do (INV §8 P39 g), opens a
      // commit's file's diff (R32), and loads more (R30).
      case "commit":
        if (!space) toggleGroup(key);
        return;
      case "commitFile":
        if (!space) openDiffSoon(key);
        return;
      case "loadMore":
        if (!space) loadMore();
        return;
      case "inert":
        return;
    }
  }

  /**
   * View Commit (R33): the commit as `git show` prints it, in a read-only tab
   * of its own, coloured as a diff by its name `*<id7>:show.diff*` (INV §8
   * P36 i). No mode: `DIFF_MODE` lists Next and Previous Change, which act
   * on the section's diff only. A later View Commit replaces the tab, and a
   * slower earlier one opens nothing. A read like any other: killed at its
   * timeout, and nothing opens once the window is not active (R28). It and
   * the diff supersede each other: whichever was asked for last opens. Text
   * over 5 MiB is refused after it is read; "" with rc 0 is output that was
   * not UTF-8 (INV §8 P17). It opens in the editor area, where the tab it
   * replaces was, never in the dock (R37): a new virtual buffer's tab goes
   * in the active split (INV §13.1).
   */
  async function viewCommit(key: string): Promise<void> {
    if (!isActive()) return;
    const ready = readiness();
    if ("why" in ready) {
      say(ready.why);
      return;
    }
    const commit = commitOf(key, ready.graph);
    if (commit === null) return;
    const id7 = shortId(commit.id);
    // The latest request wins: a diff still being built opens nothing after
    // this tab, and a later diff or View Commit makes this one stale (R14,
    // R33).
    const gen = slot.claim();
    const myEpoch = epoch;
    const stale = () => !live(myEpoch) || !slot.isCurrent(gen);
    const r = await run(runner, ready.mode, "git", showArgs(commit.id), ready.root);
    if (stale()) return;
    if (r.code !== 0) {
      say(`could not show ${id7}: ${failReason(r, ready.root)}`);
      return;
    }
    if (r.stdout === "") {
      say(`${id7} could not be shown: its text is not UTF-8`);
      return;
    }
    if (utf8Length(r.stdout) > MAX_DIFF_BYTES) {
      say(`${id7} is larger than 5 MiB; not shown`);
      return;
    }
    let made: VirtualBufferResult;
    placing++;
    try {
      enterTarget(null, commitTab !== null ? commitSplit : null);
      made = await editor.createVirtualBuffer({
        name: `*${id7}:show.diff*`,
        readOnly: true,
        editingDisabled: true,
        showLineNumbers: false,
        entries: contentToEntries(r.stdout),
      });
    } finally {
      placing--;
    }
    if (stale()) {
      dropView([made.bufferId]);
      return;
    }
    const prev = commitTab;
    commitTab = made.bufferId;
    editor.showBuffer(made.bufferId);
    commitSplit = editor.getActiveSplitId();
    if (prev !== null && prev !== made.bufferId) dropView([prev]);
  }

  /** Copy Commit ID (R33): the commit's full id to the clipboard, and a
   *  message saying so. */
  function copyId(key: string): void {
    const commit = commitOf(key, rows?.graph ?? NO_GRAPH);
    if (commit === null) return;
    editor.setClipboard(commit.id);
    // The short id: the status bar cuts a long message (spec decisions).
    say(`copied the full id of ${shortId(commit.id)}`);
  }

  /** Copy Commit Message (R33): the commit's full message, read from git,
   *  to the clipboard, and a message saying so. The read is a killed read,
   *  and copies nothing once the window is not active (R28). */
  async function copyMessage(key: string): Promise<void> {
    const commit = commitOf(key, rows?.graph ?? NO_GRAPH);
    if (commit === null) return;
    const id7 = shortId(commit.id);
    if (!isActive()) return;
    const ready = readiness();
    if ("why" in ready) {
      say(ready.why);
      return;
    }
    const myEpoch = epoch;
    const r = await run(runner, ready.mode, "git", messageArgs(commit.id), ready.root);
    if (!live(myEpoch)) return;
    if (r.code !== 0) {
      say(`could not read the message of ${id7}: ${failReason(r, ready.root)}`);
      return;
    }
    // "" with rc 0 is also output that is not UTF-8 through
    // `spawnHostProcess` (INV §8 P17): copy nothing rather than "".
    const text = commitMessageText(r.stdout);
    if (text === "") {
      say(`nothing copied: the message of ${id7} is empty or not UTF-8`);
      return;
    }
    editor.setClipboard(text);
    say(`copied the message of ${id7}`);
  }

  function viewCommitSoon(key: string): void {
    void guardedAsync("viewCommit", () => viewCommit(key))();
  }

  function copyMessageSoon(key: string): void {
    void guardedAsync("copy", () => copyMessage(key))();
  }

  /** View Commit, the copies, Pull and Push: the same from the menu and the
   *  palette. `key` is the commit's row for the first three; Pull and Push
   *  act on the branch (R33–R35). */
  function graphCommand(cmd: GraphCommand, key: string): void {
    switch (cmd) {
      case "viewCommit":
        viewCommitSoon(key);
        return;
      case "copyId":
        copyId(key);
        return;
      case "copyMessage":
        copyMessageSoon(key);
        return;
      case "pull":
      case "push":
        remoteSoon(cmd);
        return;
    }
  }

  /** Open the row's menu at the pointer (R17), replacing one already open. A
   *  row with no items (the `… N more` row, Load more, a notice, an empty
   *  group) opens none. */
  function openMenu(key: string, col: number, row: number): void {
    const items = menuItems(key, rows?.status ?? null, rows?.entries ?? NO_ENTRIES, rows?.graph ?? NO_GRAPH);
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
    if ((row.kind === "commit" || row.kind === "commitFile") && !rows?.graph.has(key)) {
      say(`${row.kind === "commit" ? shortId(row.id) : row.path} is no longer listed`);
      return;
    }
    // Each choice routed by name: a new choice must never fall into a write.
    if (isGraphCommand(choice)) {
      graphCommand(choice, key);
      return;
    }
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

  /** A click on the row `key`: a file row, a commit's file's too, opens its
   *  diff (R14, R32), and Load more loads (R30). A row with children sends
   *  `expand` instead (INV §8 P39 g). */
  function clickRow(key: string): void {
    switch (rowKind(key).kind) {
      case "file":
      case "commitFile":
        openDiffSoon(key);
        return;
      case "loadMore":
        loadMore();
        return;
      case "group":
      case "commit":
      case "inert":
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
        // A click on a file row opens its diff (R14), a commit's file's too
        // (R32); keyboard moves carry no `via` (INV §9.1). A click on the row
        // already selected re-opens it: the tree's `cardBorders` lets that
        // press through (INV §8 P21). A click on Load more loads (R30).
        if (p.via === "click" && key !== null && isActive()) clickRow(key);
        return;
      case "expand":
        // Every toggle by the host: a click (on a row with children it sends
        // no `select`), the disclosure glyph, Right and Left (INV §8 P39 g).
        if (key !== null && p.expanded === true) expanded.add(key);
        if (key !== null && p.expanded === false) expanded.delete(key);
        select();
        if (key !== null && p.expanded === true && isActive()) onExpanded(key);
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
   *  facing the cursor of the pane holding the keyboard (`facingLine`,
   *  R19 "Either pane"). Bound in DIFF_MODE. The cursor is the focused
   *  panel's (INV §8 P41 n), read at once. */
  async function diffEnter(): Promise<void> {
    const d = activeDiff();
    const line = d === null ? null : (editor.getPrimaryCursor()?.line ?? null);
    // Another tab active, or a line not known yet (a huge text).
    if (d === null || line === null) return;
    await openAt(d.v.key, facingLine(d.v.hunks, d.side, line, d.v.rightLines), epoch);
  }

  /** The section diff of the active tab, and the side whose pane holds the
   *  keyboard; null when the active tab is not it. */
  function activeDiff(): { v: View; side: PaneSide } | null {
    const v = slot.current();
    const side = v === null ? null : sideOf(v, editor.getActiveBufferId());
    return v === null || side === null ? null : { v, side };
  }

  /**
   * Next Change or Previous Change (R29), and `n`/`]`, `p`/`[` (R20): both
   * panes' cursors to the next (previous) change, which the focused pane
   * brings into view (the other follows through the scroll sync). At the
   * last (first) change nothing moves, and a message says so. The commands
   * are listed only while a section diff is the active tab (by `DIFF_MODE`,
   * P39 k), but a key bound to one can run anywhere: then it says so.
   */
  function changeNav(dir: "next" | "prev"): void {
    const d = activeDiff();
    if (d === null) {
      say(NO_SECTION_DIFF);
      return;
    }
    const { v, side } = d;
    const i = stepHunk(v.hunks, side, editor.getPrimaryCursor()?.position ?? 0, dir === "next" ? 1 : -1, v.at);
    if (i === null) {
      say(dir === "next" ? NO_NEXT_CHANGE : NO_PREVIOUS_CHANGE);
      return;
    }
    v.at = i;
    const h = v.hunks[i];
    if (v.left !== null) editor.setBufferCursor(v.left, h.left.jump);
    if (v.right !== null) editor.setBufferCursor(v.right, h.right.jump);
    const split = v.panelSplits[side];
    const buffer = side === "left" ? v.left : v.right;
    if (split !== undefined && buffer !== null) editor.scrollToLineCenter(split, buffer, centreLine(h[side]));
  }

  /** `q` or Esc in the diff (R20): close it, leaving no buffer behind
   *  (R14). The view is taken out first, so the closes it brings find no
   *  view to close again (H14). */
  function diffClose(): void {
    const d = activeDiff();
    if (d === null) return;
    slot.take(d.v);
    closeView(d.v);
  }

  /** Tab and Shift+Tab in the diff (R20): the keyboard to the other pane,
   *  as a click there does (P42 f). A one-pane diff has none: nothing. */
  function diffSwitch(): void {
    const d = activeDiff();
    if (d === null || d.v.left === null || d.v.right === null) return;
    editor.focusBufferGroupPanel(d.v.group, d.side === "left" ? "right" : "left");
  }

  /**
   * The diff's key hint (R20), once the keyboard is in the diff it waits for:
   * in the editor, not the section, with one of the diff's panes the active
   * buffer. Said once per view; a view replaced or closed meanwhile drops it.
   */
  function hintIfInDiff(): void {
    if (hintFor === null || sectionFocused || keyboardRegion !== "editor") return;
    if (slot.current() !== hintFor) {
      hintFor = null;
      return;
    }
    if (sideOf(hintFor, editor.getActiveBufferId()) === null) return;
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
   * that waits for it (R20). It also tracks the split the user works in
   * (`track`, R37). While a section tab is being placed, the target split's
   * own tab may be announced (H16): it neither reveals nor is tracked.
   */
  function onActiveBuffer(e: HookEventMap["active_buffer_changed"]): void {
    // A tab change to a diff waiting for its hint, the keyboard in the editor.
    hintIfInDiff();
    // A window switch back to this window is not a tab change: its active
    // tab is the one it had, whose row the user may have left since (R28).
    if (placing > 0 || e.reason === "window") return;
    track(e.buffer_id);
    if (sectionFocused || rows === null || root === null) return;
    // "" for a virtual buffer, such as a diff view, or one with no file.
    const path = editor.getBufferPath(e.buffer_id);
    if (path === "") return;
    const key = revealKey(path, root, rows.entries, shownKeys, expanded, selectedKey);
    if (key === null) return;
    const index = shownKeys.indexOf(key);
    recordSelection(key, index);
    pushSelection(index);
  }

  /** A buffer of this window closed. A source of the diff shown, with no
   *  `buffer_group_closed` first: a window closing (H4). Close the rest of
   *  the view, so nothing is left behind (R14). While another window is
   *  active, `dropView` keeps them until this one is: a window that closes
   *  takes them with it. A closed view's sources closing find no view. */
  function onBufferClosed(e: HookEventMap["buffer_closed"]): void {
    // View Commit's tab: one buffer, closed with its tab (R33).
    if (e.buffer_id === commitTab) {
      commitTab = null;
      commitSplit = null;
    }
    const v = slot.onClosed(e.buffer_id);
    if (v !== null) closeView(v);
  }

  /** A buffer group of this window closed: the diff's tab closed by the
   *  user (its `×`, Close Tab), which leaves the sources open, or a source
   *  closed from outside, which closes the group first (H4). Close the
   *  sources still open, each once (R14, H14): a source whose close closed
   *  the group is already gone here (`getBufferInfo` null, P42 j), and its
   *  `buffer_closed` comes after. Another window's view waits for it to be
   *  active (`leftovers`, checked the same way then). */
  function onGroupClosed(e: HookEventMap["buffer_group_closed"]): void {
    const v = slot.onGroupClosed(e.group_id);
    if (v === null) return;
    if (isActive()) for (const id of v.open) if (editor.getBufferInfo(id) === null) v.open.delete(id);
    closeView(v);
  }

  // -------------------------------------------------------------------------
  // Palette (R18)
  // -------------------------------------------------------------------------

  function paletteCommand(cmd: PaletteCommand): void {
    const t = paletteTarget(cmd, selectedKey, rows?.status ?? null, rows?.entries ?? NO_ENTRIES, rows?.graph ?? NO_GRAPH);
    if (!t.ok) {
      say(t.message);
      return;
    }
    if (isGraphCommand(cmd)) {
      graphCommand(cmd, t.key);
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
    // Where a file is shown now, before any tab change (R37).
    track(editor.getActiveBufferId());
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
    // Only those still open: one closed meanwhile, as a source whose close
    // closed its group, would be closed twice (H14, P42 j).
    for (const ids of leftovers.splice(0)) dropView(ids.filter((id) => editor.getBufferInfo(id) !== null));
    // Refs that moved neither HEAD nor the upstream show now (R30).
    graph.forceNext();
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
    onGroupClosed,
    paletteCommand,
    focusSection,
    diffEnter,
    changeNav,
    diffClose,
    diffSwitch,
    answerPublish,
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
// `q`/Esc and Tab/Shift+Tab in the diff (R20), bound in DIFF_MODE.
registerHandler("gitSidebar_diffClose", guarded("diff close", () => activeSection()?.diffClose()));
registerHandler("gitSidebar_diffSwitch", guarded("diff switch", () => activeSection()?.diffSwitch()));

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

// Group ids are per window: routed by the window, then matched by id.
editor.on(
  "buffer_group_closed",
  guarded("buffer_group_closed", (e: HookEventMap["buffer_group_closed"]) => {
    sections.get(e.window_id)?.onGroupClosed(e);
  }),
);

editor.on("active_window_changed", guarded("active_window_changed", onActivated));
// Publish's prompt (R35): only its own type's answers (INV §8 P39 h). The
// payloads name no window, and a prompt is answered in the active window,
// whose own it is (INV §11.4): its section's prompt gets the answer.
editor.on(
  "prompt_confirmed",
  guarded("prompt_confirmed", (e: HookEventMap["prompt_confirmed"]) => {
    if (e.prompt_type !== PUBLISH_PROMPT) return;
    activeSection()?.answerPublish(e.input);
  }),
);
editor.on(
  "prompt_cancelled",
  guarded("prompt_cancelled", (e: HookEventMap["prompt_cancelled"]) => {
    if (e.prompt_type !== PUBLISH_PROMPT) return;
    activeSection()?.answerPublish(null);
  }),
);
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
  { name: "Git Sidebar: View Commit", description: "Show the commit selected in the Git section's Graph", cmd: "viewCommit" },
  { name: "Git Sidebar: Copy Commit ID", description: "Copy the id of the commit selected in the Git section's Graph", cmd: "copyId" },
  { name: "Git Sidebar: Copy Commit Message", description: "Copy the message of the commit selected in the Git section's Graph", cmd: "copyMessage" },
  { name: "Git Sidebar: Pull", description: "Pull the current branch from its upstream", cmd: "pull" },
  { name: "Git Sidebar: Push", description: "Push the current branch to its upstream, or publish it", cmd: "push" },
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
  const t = paletteTarget(cmd, null, null, NO_ENTRIES, NO_GRAPH);
  if (!t.ok) editor.setStatus(t.message);
}

function focusSection(): void {
  const s = activeSection();
  if (s !== undefined) s.focusSection();
  else editor.setStatus(NOT_SHOWN);
}

/** Next or Previous Change (R29) in the active window's section diff. */
function changeNav(dir: "next" | "prev"): void {
  const s = activeSection();
  if (s !== undefined) s.changeNav(dir);
  else editor.setStatus(NO_SECTION_DIFF);
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
  // Listed while a section diff is the active tab, by its mode (R29).
  for (const [dir, name, description] of [
    ["next", "Next Change", "Move to the next change in the Git section's diff"],
    ["prev", "Previous Change", "Move to the previous change in the Git section's diff"],
  ] as const) {
    const handler = `gitSidebar_${dir === "next" ? "nextChange" : "prevChange"}`;
    registerHandler(handler, guarded(handler, () => changeNav(dir)));
    editor.registerCommand(`Git Sidebar: ${name}`, description, handler, DIFF_MODE);
  }
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
  editor.defineMode(DIFF_MODE, DIFF_KEYS, true);
  // The section of the plugin before R28, kept by the host across a reload
  // after an update (INV §2). Unmounting an id that is not mounted is a no-op.
  editor.unmountFloatingWidget(LEGACY_PANEL);
  ensureSection(editor.activeWindow());
})();
