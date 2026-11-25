// image-viewer: an image file opened in Fresh shows the picture in its own
// tab, as coloured `▀` cells, instead of its bytes (R1, R2). `+ = - 0` zoom
// (R4), the arrows and `h j k l` pan (R5), `b` shows the bytes and the
// palette's "Image Viewer: Show Image" brings the image back (R7), `q`
// closes the tab (R8). Pixels come from an installed tool: ffmpeg, then
// ImageMagick, then sips (R10).
//
// This file only wires the editor to the pure pieces in lib/.
//
// A tab's view is a buffer group shown in the file's own tab (INV §2, P7):
// a 1-row header over the image panel. The group is created on the file's
// `buffer_activated`, before anything is awaited (R1). The plugin keeps no
// pixels between views: every view change asks the tool for exactly the
// pixels on screen.

import { baseName, isImage } from "./lib/files.ts";
import { base64ToBytes, parseBmp, parsePam, type Image } from "./lib/decode.ts";
import { cells, compose, fitCanvas, header, loadingHeader, TERMINAL_BG, themeBg, themeKey, type Canvas, type Rgb } from "./lib/paint.ts";
import { WindowQueue } from "./lib/queue.ts";
import { SingleFlight } from "./lib/render.ts";
import { Runner, stopper, type Scratch, type Stop } from "./lib/runner.ts";
import { classifyDetect, DETECT, planRender, planSize, preflight, type RenderPlan, type RunResult, type SizePlan, type Tool } from "./lib/tools.ts";
import { fitView, layout, pan, sameView, zoomIn, zoomLabel, zoomOut, type Area, type Size, type View } from "./lib/view.ts";

const editor = getEditor();

const MODE = "image-viewer";
/** Set while the active tab is an image file showing its bytes (R7). */
const BYTES_CONTEXT = "image-viewer-bytes";
const SHOW_COMMAND = "Image Viewer: Show Image";
const SHOW_HANDLER = "image_viewer_show";
/** A 1-row fixed header over a scrollable image: a single scrollable leaf
 *  draws nothing (INV §2, P7). */
const LAYOUT = JSON.stringify({
  type: "split",
  direction: "v",
  ratio: 0.1,
  first: { type: "fixed", id: "hdr", height: 1 },
  second: { type: "scrollable", id: "img" },
});

function log(msg: string): void {
  editor.debug(`image-viewer: ${msg}`);
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

/** `guarded` for async work: the promise it returns never rejects. What
 *  `fn` throws is logged, and `fallback` gives the result instead. */
function guardedAsync<T>(name: string, fn: () => Promise<T>, fallback: (e: unknown) => T): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (e) {
      log(`${name} threw: ${String(e)}`);
      return fallback(e);
    }
  };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One image file's tab in one window (INV §2). */
interface Tab {
  key: string;
  windowId: number;
  fileId: number;
  path: string;
  name: string;
  /** opening: the group is being created; shown: the group is up; bytes:
   *  the tab shows Fresh's byte view and stays so until Show Image (R7). */
  kind: "opening" | "shown" | "bytes";
  /** Bumped by everything that ends the current view; every await checks it. */
  epoch: number;
  /** Fired with each epoch bump: kills the current view's running step (R8). */
  stop: Stop;
  groupId: number | null;
  panels: { hdr: number; img: number } | null;
  splits: { hdr: number; img: number } | null;
  tool: Tool | null;
  src: Size | null;
  /** The image split's text area, only ever from its `viewport_changed` (INV §8 P17). */
  area: Area | null;
  view: View | null;
  /** The tool and the size, probed from the moment the create is sent;
   *  true once both are known. */
  ready: Promise<boolean> | null;
  /** The last painted canvas, re-cut at once when the panel shrinks. */
  canvas: Canvas | null;
  flight: SingleFlight<Canvas> | null;
}

const key = (windowId: number, id: number) => `${windowId}:${id}`;

/** By (window, file buffer). Group and split ids are per window, so every
 *  lookup matches the window too; buffer ids are global, and keying them
 *  by window as well costs nothing (INV §2). */
const tabs = new Map<string, Tab>();
/** Sizes from `viewport_changed` that came while a create was in flight in
 *  that window, for a split not yet known to be an image split. */
const seenArea = new Map<string, Area>();
/** Creates in flight, by window. */
const creating = new Map<number, number>();

/** The window has no create in flight any more, or it closed. */
function forgetCreates(windowId: number): void {
  creating.delete(windowId);
  for (const k of [...seenArea.keys()]) if (k.startsWith(`${windowId}:`)) seenArea.delete(k);
}

/** The window's tab that `match` names. There are a handful at most. */
function find(windowId: number, match: (t: Tab) => boolean): Tab | undefined {
  for (const t of tabs.values()) if (t.windowId === windowId && match(t)) return t;
  return undefined;
}
const byPanel = (windowId: number, buffer: number) => find(windowId, (t) => t.panels !== null && (t.panels.hdr === buffer || t.panels.img === buffer));
const byGroup = (windowId: number, group: number) => find(windowId, (t) => t.groupId === group);
const bySplit = (windowId: number, split: number) => find(windowId, (t) => t.splits?.img === split);

// ------------------------------------------------------------ windows (INV §2) and processes

/** Groups, panels, status, contexts and the cursor reset act on the active
 *  window (INV §2): each goes through `onWindow`. */
const queue = new WindowQueue({ active: () => editor.activeWindow(), onError: (e) => log(`queued operation threw: ${String(e)}`) });
const onWindow = (windowId: number, kind: string, op: () => void) => queue.run(windowId, kind, op);
/** What survives a tab's switch to its bytes: the message saying why. */
const keepStatus = (kind: string) => kind === "status";

const runner = new Runner({
  spawn: (program, args) => editor.spawnHostProcess(program, args),
  delay: (ms) => editor.delay(ms),
  log,
  scratch,
  active: () => editor.activeWindow(),
});

/** Plans waiting for their window to be active again, by window. */
const waiting = new Map<number, (() => void)[]>();

/** Resolves once `windowId` is the active window (at once if it is), or
 *  once it has closed. */
function whenActive(windowId: number): Promise<void> {
  if (editor.activeWindow() === windowId) return Promise.resolve();
  return new Promise((resolve) => waiting.set(windowId, [...(waiting.get(windowId) ?? []), resolve]));
}

function wake(windowId: number): void {
  const list = waiting.get(windowId) ?? [];
  waiting.delete(windowId);
  for (const resolve of list) resolve();
}

/** A new directory for one run's files, made by the editor under its config
 *  dir: in the shared temp dir another local user could plant a symlink at
 *  a name they guessed, and the tool would write through it (INV §8 P31).
 *  Both calls return a Rust `Option`, which reaches the plugin as
 *  `undefined`, not the DTS's `null` (as `readFile`'s does, git-sidebar's
 *  INV §8): so test for neither, not `=== null`. */
function scratch(): Scratch | null {
  const token = editor.scratchCreate("image-viewer");
  if (!token) return null;
  const dir = editor.scratchPath(token);
  if (!dir) {
    editor.scratchDiscard(token);
    return null;
  }
  return { dir, discard: () => editor.scratchDiscard(token) };
}

function say(tab: Tab, msg: string): void {
  log(msg);
  onWindow(tab.windowId, `${tab.key}:status`, () => editor.setStatus(msg));
}

/** The Show Image command is listed exactly while the active tab is an
 *  image file showing its bytes (R7). Contexts are the active window's. */
function syncContext(): void {
  const tab = tabs.get(key(editor.activeWindow(), editor.getActiveBufferId()));
  editor.setContext(BYTES_CONTEXT, tab !== undefined && tab.kind === "bytes");
}

let warnedTheme = "";

/** The editor background as RGB (INV §8 P19), and whether it is the
 *  terminal's own. Black stands in when the theme leaves it to the terminal
 *  or the lookup fails. */
function readThemeBg(): { rgb: Rgb; terminal: boolean } {
  let name = "";
  let bg: Rgb | typeof TERMINAL_BG | null = null;
  try {
    name = themeKey(editor.getConfig(), editor.getThemesDir(), (n) => editor.getEnv(n));
    bg = themeBg(editor.getThemeData(name));
  } catch (e) {
    log(`theme lookup threw: ${String(e)}`);
  }
  if (Array.isArray(bg)) return { rgb: bg, terminal: false };
  if (warnedTheme !== name) {
    warnedTheme = name;
    log(`theme "${name}" ${bg === TERMINAL_BG ? "leaves the background to the terminal" : "has no editor.bg colour"}; blending over black`);
  }
  return { rgb: [0, 0, 0], terminal: bg === TERMINAL_BG };
}

// ------------------------------------------------------------ painting

function headerText(tab: Tab): string {
  const cols = tab.area?.cols ?? 200;
  return tab.src !== null && tab.view !== null ? header(tab.name, tab.src, zoomLabel(tab.view.scale), cols) : loadingHeader(tab.name, cols);
}

function paintHeader(tab: Tab): void {
  const text = headerText(tab);
  onWindow(tab.windowId, `${tab.key}:hdr`, () => {
    if (tab.groupId !== null) editor.setPanelContent(tab.groupId, "hdr", [{ text }]);
  });
}

/** Puts the image panel's hidden cursor back at byte 0. A click moves it,
 *  and when the panel then shrinks the host scrolls to keep it visible,
 *  which draws the next frame off to one side (INV §8 P25). */
function resetCursor(tab: Tab): void {
  onWindow(tab.windowId, `${tab.key}:cursor`, () => {
    if (tab.panels !== null) editor.setBufferCursor(tab.panels.img, 0);
  });
}

/** Puts `canvas` in the image panel, cut to the area as it is when the
 *  operation runs (INV §9.6, P18). */
function paintImage(tab: Tab, canvas: Canvas): void {
  onWindow(tab.windowId, `${tab.key}:img`, () => {
    if (tab.groupId === null || tab.area === null) return;
    editor.setPanelContent(tab.groupId, "img", cells(fitCanvas(canvas, tab.area)) as unknown as Record<string, unknown>[]);
  });
}

// ------------------------------------------------------------ the view's lifecycle

const live = (tab: Tab, epoch: number) => tabs.get(tab.key) === tab && tab.epoch === epoch;

/** The current view is over: awaits that check the epoch stop there, and a
 *  step still running is killed now rather than at its deadline (R8, R11). */
function endView(tab: Tab): void {
  tab.epoch++;
  tab.stop.fire();
  tab.stop = stopper();
}

/** The tab shows its bytes, and stays so until Show Image or the tab
 *  closes (R7, INV §2): `b`, a failure (R10, R11, with `why`), a rejected
 *  create, a preflight, and `buffer_group_closed` all end here. The group,
 *  if one is up, closes; its `buffer_group_closed` comes back here. */
function toBytes(tab: Tab, why?: string): void {
  if (why !== undefined) say(tab, why);
  tab.kind = "bytes";
  endView(tab);
  tab.canvas = null;
  tab.flight = null;
  queue.drop(tab.windowId, `${tab.key}:`, keepStatus);
  const gid = tab.groupId;
  if (gid !== null) onWindow(tab.windowId, `${tab.key}:close`, () => editor.closeBufferGroup(gid));
  syncContext();
}

/** Forgets the tab: it closed, or Show Image starts it over (R7, R8). */
function drop(tab: Tab): void {
  endView(tab);
  tabs.delete(tab.key);
  queue.drop(tab.windowId, `${tab.key}:`);
}

function newTab(windowId: number, fileId: number, path: string): Tab {
  return {
    key: key(windowId, fileId),
    windowId,
    fileId,
    path,
    name: baseName(path),
    kind: "opening",
    epoch: 0,
    stop: stopper(),
    groupId: null,
    panels: null,
    splits: null,
    tool: null,
    src: null,
    area: null,
    view: null,
    ready: null,
    canvas: null,
    flight: null,
  };
}

/** Opens the view for the active window's file `fileId` (R1). */
function start(windowId: number, fileId: number, path: string): void {
  const tab = newTab(windowId, fileId, path);
  const win = editor.listWindows().find((w) => w.id === windowId);
  const why = preflight({ trust: editor.workspaceTrustLevel(), remote: win?.remote !== undefined && win.remote !== null });
  if (why !== null) {
    tabs.set(tab.key, tab);
    toBytes(tab, `image viewer: ${why}`);
    return;
  }
  // Pre-check: a group lands in the file's tab only while that tab is the
  // split's current one (INV §8 P17). Otherwise the next activation tries again.
  if (editor.getActiveBufferId() !== fileId) return;
  tabs.set(tab.key, tab);
  const epoch = tab.epoch;
  // The split the group is shown in: the one active now (INV §8 P17).
  const split = editor.getActiveSplitId();
  creating.set(windowId, (creating.get(windowId) ?? 0) + 1);
  const done = () => {
    const n = (creating.get(windowId) ?? 0) - 1;
    if (n > 0) creating.set(windowId, n);
    else forgetCreates(windowId);
  };
  let sent: Promise<BufferGroupResult>;
  try {
    sent = editor.createBufferGroup(tab.name, MODE, LAYOUT, { inTabOf: fileId });
  } catch (e) {
    // As a rejected create: else the tab would stay "opening", ignoring
    // every activation, and the window would count a create for good.
    done();
    toBytes(tab, `${tab.name}: could not open the image view (${message(e)})`);
    return;
  }
  sent.then(
    guarded("created", (r: BufferGroupResult) => {
      // A window that closed meanwhile has taken the group with it, and
      // would never run a queued operation.
      if (!editor.listWindows().some((w) => w.id === windowId)) {
        done();
        return;
      }
      // The post-check reads the window's buffers, so it waits for the
      // window to be active (INV §2). Not under the tab's key: a tab dropped
      // meanwhile still gets its group closed.
      onWindow(windowId, `create:${r.groupId}`, () => {
        try {
          created(tab, epoch, r, split);
        } finally {
          done();
        }
      });
    }),
    guarded("create rejected", (e: unknown) => {
      done();
      if (live(tab, epoch)) toBytes(tab, `${tab.name}: could not open the image view (${String(e)})`);
    }),
  );
  // The tool and the size don't need the group: probe them meanwhile. A
  // spawn whose result rejects shows the bytes, as any failure does (R11).
  tab.ready = guardedAsync(
    "prepare",
    () => prepare(tab, epoch),
    (e) => {
      guarded("prepare failed", () => {
        if (live(tab, epoch)) toBytes(tab, `${tab.name}: could not run the image tool (${message(e)})`);
      })();
      return false;
    },
  )();
}

/** The create resolved; runs while the tab's window is active. */
function created(tab: Tab, epoch: number, r: BufferGroupResult, split: number): void {
  const gid = r.groupId;
  if (!live(tab, epoch)) {
    editor.closeBufferGroup(gid);
    return;
  }
  // Post-check (INV §8 P17): in the file's tab, the file stays the
  // buffer tab of the split the create was sent from; a group in a tab of
  // its own leaves `[]`. The split is the one active at the create, so a
  // focus move since then does not close a group that landed right.
  const info = editor.getBufferInfo(tab.fileId);
  if (info === null || !info.splits.includes(split)) {
    log(`${tab.name}: the group did not land in the file's tab; closing it`);
    editor.closeBufferGroup(gid);
    drop(tab);
    return;
  }
  // The image panel is the active buffer while the group shows, and an
  // empty, pathless active buffer is reused for the next file the editor
  // opens: an explorer preview would load into the panel and close with
  // the group (INV §8 P32). One cell, now, in this turn: the editor handles
  // it on its next pass, about 5 ms on, instead of at the first render.
  editor.setPanelContent(gid, "img", [{ text: " " }]);
  const panels = { hdr: r.panels.hdr, img: r.panels.img };
  const splits = { hdr: r.panelSplits.hdr, img: r.panelSplits.img };
  tab.groupId = gid;
  tab.panels = panels;
  tab.splits = splits;
  tab.kind = "shown";
  tab.area = seenArea.get(key(tab.windowId, splits.img)) ?? null;
  tab.flight = new SingleFlight<Canvas>({
    run: () => renderOnce(tab, epoch),
    apply: (canvas) => {
      tab.canvas = canvas;
      paintImage(tab, canvas);
    },
    alive: () => live(tab, epoch) && tab.kind === "shown",
    onError: (e) => log(`${tab.name}: render threw: ${String(e)}`),
  });
  onWindow(tab.windowId, `${tab.key}:panels`, () => {
    for (const name of ["hdr", "img"] as const) {
      editor.setLineNumbers(panels[name], false);
      editor.setBufferShowCursors(panels[name], false);
      editor.setLineWrap(panels[name], splits[name], false);
    }
  });
  paintHeader(tab);
  // The first view, once the tool and the size are known (R2).
  void tab.ready?.then(
    guarded("ready", (ok: boolean) => {
      if (!ok || !live(tab, epoch)) return;
      paintHeader(tab);
      if (tab.area !== null) tab.flight?.request();
    }),
  );
}

/** Whether to run a refused plan again, once the tab's window is active.
 *  Workspace trust is checked against the active window (INV §7), so a step
 *  refused while another window was active says nothing about this tab's.
 *  A refusal of a step spawned while the tab's window was active is its
 *  own, and shows the bytes; which window that was is the one active at the
 *  spawn, not when the answer comes back. A plan run again gets a new
 *  directory; the refused run's went when it ended. */
async function again(tab: Tab, epoch: number, r: RunResult): Promise<boolean> {
  if (r.ok || !r.refused || !live(tab, epoch)) return false;
  const at = r.window ?? editor.activeWindow();
  if (at === tab.windowId) return false;
  log(`${tab.name}: ${r.reason} (window ${at} was active); running it again in window ${tab.windowId}`);
  await whenActive(tab.windowId);
  return live(tab, epoch);
}

/** Finds the tool and the image's size; true when both are known. Shows
 *  the bytes, with the reason, when either fails (R10, R11). */
async function prepare(tab: Tab, epoch: number): Promise<boolean> {
  const alive = () => live(tab, epoch);
  // Detection runs on every open, so a tool installed later is found
  // without a restart (A13).
  let detected: RunResult;
  do {
    detected = await runner.run(() => ({ steps: [DETECT], final: null }), alive, tab.stop.fired);
  } while (await again(tab, epoch, detected));
  if (!alive()) return false;
  const found = classifyDetect(detected);
  if (typeof found !== "string") {
    toBytes(tab, `${tab.name}: ${found.why}`);
    return false;
  }
  tab.tool = found;
  // `run` builds the plan at once, in the run's own directory.
  const built: { plan?: SizePlan } = {};
  let r: RunResult;
  do {
    r = await runner.run((dir) => (built.plan = planSize(found, tab.path, dir)), alive, tab.stop.fired);
  } while (await again(tab, epoch, r));
  if (!alive()) return false;
  if (!r.ok) {
    toBytes(tab, `${tab.name}: ${r.reason}`);
    return false;
  }
  const src = built.plan?.parse(r.stdout, r.stderr) ?? null;
  if (src === null) {
    toBytes(tab, `${tab.name}: ${found} gave no image size`);
    return false;
  }
  tab.src = src;
  tab.view = fitView(src);
  return true;
}

/** One view: the tool's pixels for the view as it is now, on a canvas
 *  blended over the theme's background, read once for the frame. */
async function renderOnce(tab: Tab, epoch: number): Promise<Canvas | null> {
  const { src, area, view, tool } = tab;
  if (src === null || area === null || view === null || tool === null) return null;
  const l = layout(src, area, view);
  const built: { plan?: RenderPlan } = {};
  const r = await runner.run((dir) => (built.plan = planRender(tool, tab.path, src, l, dir)), () => live(tab, epoch), tab.stop.fired);
  if (!live(tab, epoch)) return null;
  if (!r.ok) {
    // Run again for the view as it is by then.
    if (await again(tab, epoch, r)) return renderOnce(tab, epoch);
    if (live(tab, epoch)) toBytes(tab, `${tab.name}: ${r.reason}`);
    return null;
  }
  let img: Image;
  try {
    const bytes = base64ToBytes(r.stdout);
    img = built.plan?.format === "bmp" ? parseBmp(bytes) : parsePam(bytes);
  } catch (e) {
    toBytes(tab, `${tab.name}: cannot read ${tool}'s output (${message(e)})`);
    return null;
  }
  const bg = readThemeBg();
  return compose(img, l, bg.rgb, bg.terminal);
}

// ------------------------------------------------------------ events

function onActivated(e: { buffer_id: number; window_id: number }): void {
  syncContext();
  const path = editor.getBufferPath(e.buffer_id);
  if (!isImage(path)) return;
  if (tabs.has(key(e.window_id, e.buffer_id))) return;
  if (e.window_id !== editor.activeWindow()) return;
  start(e.window_id, e.buffer_id, path);
}

editor.on("buffer_activated", guarded("buffer_activated", onActivated));

editor.on(
  "viewport_changed",
  guarded("viewport_changed", (e: HookEventMap["viewport_changed"]) => {
    const tab = bySplit(e.window_id, e.split_id);
    const area: Area = { cols: e.width, rows: e.height };
    if (area.cols <= 0 || area.rows <= 0) return;
    if (tab === undefined) {
      if (creating.has(e.window_id)) seenArea.set(key(e.window_id, e.split_id), area);
      return;
    }
    const old = tab.area;
    if (old !== null && old.cols === area.cols && old.rows === area.rows) return;
    tab.area = area;
    resetCursor(tab);
    // A shrink re-cuts the last frame at once, so nothing overflows until the
    // new one lands (R6). The view's centre is kept as it is (R6).
    if (old !== null && tab.canvas !== null && (area.cols < old.cols || area.rows < old.rows)) paintImage(tab, tab.canvas);
    paintHeader(tab);
    if (tab.src !== null) tab.flight?.request();
  }),
);

editor.on(
  "mouse_click",
  guarded("mouse_click", (e: MouseClickHookArgs) => {
    // A click in the view moves the hidden cursor, and the host scrolls
    // to it (P13, INV §8 P25): put it back.
    if (e.buffer_id === null) return;
    const tab = byPanel(editor.activeWindow(), e.buffer_id);
    if (tab !== undefined) resetCursor(tab);
  }),
);

editor.on(
  "buffer_group_closed",
  guarded("buffer_group_closed", (e: HookEventMap["buffer_group_closed"]) => {
    // Whoever closed it (`b`, a failure, the host), the tab now shows its
    // bytes and stays so: the activation that follows is ignored (R7, INV §2).
    const tab = byGroup(e.window_id, e.group_id);
    log(`buffer_group_closed (group ${e.group_id}, window ${e.window_id})${tab === undefined ? "" : `: ${tab.name} shows its bytes`}`);
    if (tab === undefined) return;
    tab.groupId = null;
    tab.panels = null;
    tab.splits = null;
    toBytes(tab);
  }),
);

editor.on(
  "buffer_closed",
  guarded("buffer_closed", (e: HookEventMap["buffer_closed"]) => {
    const tab = tabs.get(key(e.window_id, e.buffer_id));
    if (tab === undefined) return;
    log(`${tab.name}: buffer_closed; the view is gone`);
    drop(tab);
    syncContext();
  }),
);

editor.on(
  "active_window_changed",
  guarded("active_window_changed", (e: HookEventMap["active_window_changed"]) => {
    queue.drain(e.active_id);
    syncContext();
    wake(e.active_id);
  }),
);

editor.on(
  "window_closed",
  guarded("window_closed", (e: HookEventMap["window_closed"]) => {
    // The host closes only an inactive window, after `buffer_closed` for
    // each of its buffers (docs/investigations/git-sidebar.md §11.4). What
    // is left goes too: tabs, queued operations, creates in flight, and
    // plans waiting for the window, which then find their tab gone.
    for (const t of [...tabs.values()]) if (t.windowId === e.id) drop(t);
    queue.forget(e.id);
    forgetCreates(e.id);
    wake(e.id);
  }),
);

// ------------------------------------------------------------ keys and the palette

/** The tab whose view has the keyboard. */
function activeTab(): Tab | undefined {
  const tab = byPanel(editor.activeWindow(), editor.getActiveBufferId());
  return tab !== undefined && tab.kind === "shown" ? tab : undefined;
}

/** A zoom or pan key: the view changes at once, then one render (R4, R5, R9). */
function viewKey(change: (v: View, src: Size, area: Area) => View): void {
  const tab = activeTab();
  if (tab === undefined || tab.src === null || tab.area === null || tab.view === null) return;
  const next = change(tab.view, tab.src, tab.area);
  if (sameView(next, tab.view, tab.src, tab.area)) return;
  tab.view = next;
  paintHeader(tab);
  tab.flight?.request();
}

const panBy = (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => () => viewKey((v, s, a) => pan(v, s, a, dx, dy));

/** Each action's keys, its handler, and what it does (P13). */
const ACTIONS: [string[], string, () => void][] = [
  [["+", "="], "image_viewer_zoom_in", () => viewKey(zoomIn)],
  [["-"], "image_viewer_zoom_out", () => viewKey(zoomOut)],
  [["0"], "image_viewer_fit", () => viewKey((_v, src) => fitView(src))],
  [["Left", "h"], "image_viewer_left", panBy(-1, 0)],
  [["Right", "l"], "image_viewer_right", panBy(1, 0)],
  [["Up", "k"], "image_viewer_up", panBy(0, -1)],
  [["Down", "j"], "image_viewer_down", panBy(0, 1)],
  [
    ["b"],
    "image_viewer_bytes",
    () => {
      // R7: the bytes, for this tab, until Show Image or the tab closes.
      const tab = activeTab();
      if (tab !== undefined) toBytes(tab);
    },
  ],
  [
    ["q"],
    "image_viewer_close",
    () => {
      // R8: the file's tab closes, and its group with it (INV §2, P15).
      const tab = activeTab();
      if (tab !== undefined) editor.closeBuffer(tab.fileId);
    },
  ],
];

/** Show Image (R7): the active tab's image again, at fit. */
function showImage(): void {
  const windowId = editor.activeWindow();
  const fileId = editor.getActiveBufferId();
  const tab = tabs.get(key(windowId, fileId));
  if (tab === undefined || tab.kind !== "bytes") return;
  drop(tab);
  start(windowId, fileId, tab.path);
  syncContext();
}

guarded("load", () => {
  for (const [, handler, fn] of ACTIONS) registerHandler(handler, guarded(handler, fn));
  editor.defineMode(
    MODE,
    ACTIONS.flatMap(([keys, handler]) => keys.map((k) => [k, handler])),
    true,
  );
  registerHandler(SHOW_HANDLER, guarded(SHOW_HANDLER, showImage));
  editor.registerCommand(SHOW_COMMAND, "Show this image file as an image again, at fit", SHOW_HANDLER, BYTES_CONTEXT);
  editor.setContext(BYTES_CONTEXT, false);
  // An image already active when the plugin loads.
  onActivated({ buffer_id: editor.getActiveBufferId(), window_id: editor.activeWindow() });
})();
