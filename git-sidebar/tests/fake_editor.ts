// A fake of the part of Fresh's EditorAPI the plugin uses: a call log,
// processes that resolve with the real result shapes (`{code}` from
// `runOnTarget`, `{exit_code}` from `spawnHostProcess`), host timers and
// `delay` on a manual clock, and an event emitter. Windows (R28): a list
// for `listWindows`, contexts stored per window and written to the active
// one, and helpers that switch and close windows as the host does (INV §11).
// The diff (R37–R39): one split layout with an active split, buffer groups
// with H4's close order, `compareBuffers` as a real line diff, focus
// announcements made once per frame (H16), and the host's ERROR on a second
// close of a buffer (H14) and WARN on a focus of a split that is gone (P42
// e), which the tests' afterEach asserts never happen.

import { panelIdFor, windowKey } from "../lib/windows.ts";

export interface ProcCall {
  via: "target" | "host";
  program: string;
  args: string[];
  cwd: string;
  /** The window active when it started, and that window's root (R28). */
  window: number;
  windowRoot: string | null;
}

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What a process does: resolve after `ms` simulated milliseconds (default
 *  0), hang until killed, or settle when the test settles `wait`. */
export type ProcOutcome = ProcResult | { result: ProcResult; ms: number } | { wait: Promise<ProcResult> } | "hang";

/** A process result the test hands over when it chooses. */
export function deferred(): { outcome: ProcOutcome; resolve: (r: ProcResult) => void } {
  let resolve!: (r: ProcResult) => void;
  const wait = new Promise<ProcResult>((r) => (resolve = r));
  return { outcome: { wait }, resolve };
}

export interface Call {
  name: string;
  args: unknown[];
  /** The window active when the call was made. */
  window: number;
}

export const WIDGET_CALLS = new Set([
  "mountSidebarSection",
  "updateFloatingWidget",
  "unmountFloatingWidget",
  "widgetMutate",
  "floatingPanelControl",
  "mountFloatingWidget",
]);

/** A window as `listWindows` gives it (the fields the plugin reads). */
export interface FakeWindow {
  id: number;
  stable_id: string;
  root: string;
}

/** A split of the fake's one layout: where it is, and what its visible tab
 *  shows, a buffer or a buffer group. */
export interface FakeSplit {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The buffer its visible tab shows (0 for none), when no group does. */
  buffer: number;
  /** The buffer group its visible tab shows, or null. The group itself:
   *  its id repeats across windows. */
  group: FakeGroup | null;
}

/** A buffer group as `createBufferGroup` made it (INV §13.3, P41 h, P42). */
export interface FakeGroup {
  id: number;
  window: number;
  name: string;
  mode: string;
  /** The layout as passed, parsed. */
  layout: unknown;
  /** The host split it was shown in. */
  split: number;
  /** Panel buffer ids and panel split ids, by panel name. */
  panels: Record<string, number>;
  panelSplits: Record<string, number>;
  /** Buffers its scrollable leaves borrowed (`bufferId`), and those it owns
   *  (fixed leaves): closing it closes only the owned ones (H4). */
  borrowed: number[];
  owned: number[];
  /** What the split showed before, given back when the group closes. */
  previous: number;
}

/** A side of a `compareBuffers` result (`CompareSide` in the type file). */
export interface FakeCompareSide {
  start: number;
  count: number;
  from: number;
  to: number;
  jump: number;
  lines: [number, number][];
  spans: ([number, number] | null)[];
}

export interface FakeCompareResult {
  hunks: { left: FakeCompareSide; right: FakeCompareSide; eolOnly: boolean }[];
  leftLines: number;
  rightLines: number;
  leftLen: number;
  rightLen: number;
  leftVersion: number;
  rightVersion: number;
}

/** Lines as the host splits them for a diff: each keeps its `\n`, and a final
 *  unterminated segment is a line (`split_inclusive`, H17). */
export function inclusiveLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * `compareBuffers` of two texts, as Fresh 0.5.9 answers it
 * (`fresh-core/src/diff.rs`, INV §13.3, P42 b, i): a line diff (here an
 * LCS) over lines that keep their terminator, grouped into hunks, with each
 * side's byte range, its lines' text ranges, and for paired lines the part
 * that differs (null when only the terminator does). Offsets are string
 * indices, which are bytes for the ASCII texts the tests use.
 */
export function compareTexts(a: string, b: string): FakeCompareResult {
  const x = inclusiveLines(a);
  const y = inclusiveLines(b);
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const offsets = (ls: string[]) => {
    const o = [0];
    for (const l of ls) o.push(o[o.length - 1] + l.length);
    return o;
  };
  const ox = offsets(x);
  const oy = offsets(y);
  const bare = (l: string) => l.replace(/\r?\n$/, "");
  const side = (ls: string[], o: number[], start: number, count: number): FakeCompareSide => {
    const lines: [number, number][] = [];
    for (let k = 0; k < count; k++) lines.push([o[start + k], o[start + k] + bare(ls[start + k]).length]);
    const from = o[start];
    return { start, count, from, to: o[start + count], jump: count === 0 && start > 0 ? o[start - 1] : from, lines, spans: [] };
  };
  const hunks: FakeCompareResult["hunks"] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
      continue;
    }
    const [si, sj] = [i, j];
    while ((i < x.length || j < y.length) && !(i < x.length && j < y.length && x[i] === y[j])) {
      if (j >= y.length || (i < x.length && lcs[i + 1][j] >= lcs[i][j + 1])) i++;
      else j++;
    }
    const left = side(x, ox, si, i - si);
    const right = side(y, oy, sj, j - sj);
    let eolOnly = left.count === right.count && left.count > 0;
    for (let k = 0; k < Math.min(left.count, right.count); k++) {
      const [lt, rt] = [bare(x[si + k]), bare(y[sj + k])];
      if (lt === rt) {
        left.spans.push(null);
        right.spans.push(null);
        continue;
      }
      eolOnly = false;
      let pre = 0;
      while (pre < lt.length && pre < rt.length && lt[pre] === rt[pre]) pre++;
      let suf = 0;
      while (suf < lt.length - pre && suf < rt.length - pre && lt[lt.length - 1 - suf] === rt[rt.length - 1 - suf]) suf++;
      left.spans.push([left.lines[k][0] + pre, left.lines[k][1] - suf]);
      right.spans.push([right.lines[k][0] + pre, right.lines[k][1] - suf]);
    }
    hunks.push({ left, right, eolOnly });
  }
  return { hunks, leftLines: x.length, rightLines: y.length, leftLen: a.length, rightLen: b.length, leftVersion: 1, rightVersion: 1 };
}

/** The panel id of the section of the window whose workspace is
 *  `stableId` at `root`, when no other section holds it. */
export function panelOf(stableId: string, root = "/repo"): number {
  return panelIdFor(windowKey(stableId, root), new Set());
}

/** Which panel and widget a `widget_event` comes from. */
interface WidgetFrom {
  panel?: number;
  widgetKey?: string;
}

interface Pending {
  at: number;
  seq: number;
  fire: () => void;
}

type Handler = (payload: unknown) => unknown;

export class FakeEditor {
  now = 1_000_000;
  label = "";
  cwd = "/repo";
  window = 1;
  /** What `listWindows` gives; null: the active window alone, at `cwd`,
   *  with stable id `ws-<id>`. */
  windows: FakeWindow[] | null = null;
  /** Return values that replace an API call's default, by call name. Each
   *  entry is consumed by one call. */
  returns = new Map<string, unknown[]>();
  files = new Set<string>();
  dirs = new Set<string>();
  /** What `readFile` returns for a path in `files` (default ""). Fresh
   *  0.5.9 gives `undefined` for a file that is not valid UTF-8, although
   *  its type file says null. */
  contents = new Map<string, string | null | undefined>();
  /** `fileStat().size` for a path (default: the length of its contents). */
  sizes = new Map<string, number>();
  /** Buffers open in the editor that the plugin did not make, by path: the
   *  id `findBufferByPath` gives and the text `getBufferText` gives, which
   *  may differ from the file on disk (unsaved edits). */
  userBuffers = new Map<string, { id: number; text: string }>();
  /** `getBufferPath` by buffer id ("" for any other, as for a virtual buffer). */
  bufferPaths = new Map<number, string>();
  /** What `getActiveBufferId` gives: the buffer `showBuffer` last showed,
   *  or one a test sets, as a tab change would. */
  activeBuffer = 0;
  /** The spec each panel shows now: the last mounted or updated, kept
   *  across `clear()`. */
  drawn = new Map<number, unknown>();
  /** What `setClipboard` last put on the clipboard. */
  clipboard: string | null = null;
  /** What `listPlugins` lists: by default merge_conflict, enabled. */
  plugins: { name: string; path: string; enabled: boolean }[] = [{ name: "merge_conflict", path: "merge_conflict.ts", enabled: true }];
  /** What each `prompt` resolves with, in order (null: Esc), or a promise
   *  the test settles. With none left, Esc. */
  promptAnswers: (string | null | Promise<string | null>)[] = [];
  /** How each `startPrompt` is answered, in order: a string is typed or
   *  picked and confirmed (`prompt_confirmed`), null is Esc
   *  (`prompt_cancelled`), or a promise the test settles with either. With
   *  none left, the prompt stays open. */
  startPromptAnswers: (string | null | Promise<string | null>)[] = [];
  /** The suggestions `setPromptSuggestions` last set. */
  suggestions: { id: string; text: string; value?: string }[] = [];
  /** Fresh's own environment, as `getEnv` reads it: `undefined` for a name
   *  that is not set, as in 0.5.9 (INV §8 P39 c). */
  env = new Map<string, string>();
  /** When set, `listPlugins` settles only after this does. */
  pluginsGate: Promise<void> | null = null;
  /** The layout (one for every window): splits, the active one, and the
   *  terminal buffers and the files open in them. Split 0 is the top-left
   *  editor split. */
  splits: FakeSplit[] = [{ id: 0, x: 0, y: 0, width: 100, height: 30, buffer: 0, group: null }];
  activeSplit = 0;
  /** Terminal buffers: they have a path, their scrollback file, and are
   *  virtual (H12). */
  terminals = new Set<number>();
  /** Buffer groups open now, in every window. Ids are per window, so look
   *  one up by window and id (`groupOf`). */
  groups = new Set<FakeGroup>();
  /** Every group made, in order, open or not. */
  groupsMade: FakeGroup[] = [];
  /** Each buffer's cursor (byte and 0-based line), as `setBufferCursor` or a
   *  test set it; `getPrimaryCursor` reads the active buffer's. */
  cursors = new Map<number, { position: number; line: number | null }>();
  /** When set, `createBufferGroup` settles only after this does (a
   *  rejection makes the call reject). */
  groupGate: Promise<void> | null = null;
  /** When set, `compareBuffers` answers with this instead of the line diff,
   *  or settles only after the promise does. */
  compareResult: FakeCompareResult | Promise<FakeCompareResult> | null = null;
  /** What the host would log as ERROR, as `closeBuffer` on a buffer
   *  already closed does (H14, INV P29). The tests' afterEach asserts none. */
  errors: string[] = [];
  /** What the host would log as WARN, as `focusSplit` on an unknown split
   *  does (P42 e). The tests' afterEach asserts none. */
  warnings: string[] = [];
  calls: Call[] = [];
  procs: ProcCall[] = [];
  /** Every process started, never cleared. */
  allProcs: ProcCall[] = [];
  kills = 0;
  script: (call: ProcCall) => ProcOutcome = () => ({ code: 127, stdout: "", stderr: "not scripted" });

  private handlers = new Map<string, Handler[]>();
  private globals = new Map<string, (payload?: unknown) => unknown>();
  private timers = new Map<number, Pending>();
  private waits: Pending[] = [];
  private nextTimer = 1;
  private seq = 0;
  private realNow = Date.now;
  private open = new Set<number>();
  private nextBuffer = 100;
  private commands = new Map<string, string>();
  /** Contexts by window: `setContext` writes to the active window's. */
  private contexts = new Map<number, Set<string>>();
  /** The window each buffer the plugin made was opened in. */
  private bufferWindow = new Map<number, number>();
  /** The mode each buffer the plugin made was given. */
  private bufferMode = new Map<number, string>();
  /** The text of each buffer the plugin made, from its entries. */
  private bufferText = new Map<number, string>();
  /** Buffers whose close was asked for and has not landed yet. */
  private closing = new Set<number>();
  /** Group ids are per window (`buffer_group_closed` names both). */
  private nextGroup = new Map<number, number>();
  private nextSplit = 1000;
  /** Set by a focus change the plugin asked for; the next frame announces
   *  the active buffer if it changed (H16). */
  private focusDirty = false;
  private announced = 0;

  /** Installs `getEditor`, `registerHandler` and the clock as globals. */
  install(): void {
    const g = globalThis as unknown as Record<string, unknown>;
    g.getEditor = () => this.api();
    g.registerHandler = (name: string, fn: (payload?: unknown) => unknown) => {
      this.globals.set(name, fn);
    };
    Date.now = () => this.now;
  }

  uninstall(): void {
    Date.now = this.realNow;
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.getEditor;
    delete g.registerHandler;
  }

  named(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  widgetCalls(): Call[] {
    return this.calls.filter((c) => WIDGET_CALLS.has(c.name));
  }

  /** Calls that would reach the user above debug level. */
  loudCalls(): Call[] {
    return this.calls.filter((c) => ["info", "warn", "error", "setStatus"].includes(c.name));
  }

  gitCalls(): ProcCall[] {
    return this.procs.filter((p) => p.program === "git");
  }

  /** Buffers the plugin created and has not closed. */
  openBuffers(): Set<number> {
    return new Set(this.open);
  }


  /** Commands registered now, by name, and whether each is listed (its
   *  context, if any, is set). */
  palette(): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const [name] of this.commands) out.set(name, this.listed(name));
    return out;
  }

  private contextOf = new Map<string, string | null>();

  private contextsOf(window: number): Set<string> {
    let set = this.contexts.get(window);
    if (set === undefined) {
      set = new Set();
      this.contexts.set(window, set);
    }
    return set;
  }

  /** As the host lists a command: no context, a context set in the active
   *  window, or the active buffer's mode (`command_registry.rs:236-243`,
   *  INV §8 P39 k). */
  private listed(name: string): boolean {
    const ctx = this.contextOf.get(name) ?? null;
    return ctx === null || this.contextsOf(this.window).has(ctx) || this.bufferMode.get(this.activeBuffer) === ctx;
  }

  /** Whether context `name` is set in `window` (default: the active one). */
  contextOn(name: string, window = this.window): boolean {
    return this.contextsOf(window).has(name);
  }

  /** What `listWindows` gives now. */
  windowList(): FakeWindow[] {
    return this.windows ?? [{ id: this.window, stable_id: `ws-${this.window}`, root: this.cwd }];
  }

  /** The panel id of window `id`'s section (when no other section holds
   *  it): what the plugin derives from the window's workspace. */
  panelOfWindow(id: number): number {
    const w = this.windowList().find((x) => x.id === id);
    return w === undefined ? -1 : panelOf(w.stable_id, w.root);
  }

  /** The panel `widget()` sends by default: the active window's section. */
  get panel(): number {
    return this.panelOfWindow(this.window);
  }

  /** The user switches to window `id`: it becomes active, then
   *  `active_window_changed` and `active_buffer_changed {reason:"window"}`
   *  fire, as in the host (INV §8 P31 b). The `chrome_focus_changed` the
   *  host sends only when the region changes, and the `blur` of a parked
   *  section, are the test's to send. */
  async switchWindow(id: number): Promise<void> {
    const previous = this.window;
    this.window = id;
    await this.emit("active_window_changed", { previous_id: previous, active_id: id });
    await this.emit("active_buffer_changed", {
      window_id: id,
      buffer_id: this.activeBuffer,
      previous: { window_id: previous, buffer_id: this.activeBuffer },
      reason: "window",
    });
  }

  /** Window `id`, not the active one, closes, as the host does it (INV §8
   *  P31 f): `buffer_closed` for each of its buffers, `cancel` on its
   *  section's panel (named by the active window), then `window_closed`. */
  async closeWindow(id: number): Promise<void> {
    const panel = this.panelOfWindow(id);
    // A window close fires only `buffer_closed`s, no `buffer_group_closed`
    // (H4).
    for (const g of this.groups) if (g.window === id) this.groups.delete(g);
    for (const [buffer, w] of this.bufferWindow) {
      if (w !== id) continue;
      await this.closeTab(buffer);
    }
    if (this.windows !== null) this.windows = this.windows.filter((w) => w.id !== id);
    await this.widget("cancel", {}, { panel });
    await this.emit("window_closed", { id });
  }

  /** Run a palette command as the user would. */
  async command(name: string): Promise<void> {
    const handler = this.commands.get(name);
    if (handler === undefined) throw new Error(`no command ${name}`);
    await this.fire(handler);
  }

  /** Run a handler the plugin registered, as a key bound to it would. */
  async fire(handler: string): Promise<void> {
    const fn = this.globals.get(handler);
    if (fn === undefined) throw new Error(`no handler ${handler}`);
    await fn();
    await this.flush();
  }

  /** The user closes a buffer's tab. */
  async closeTab(id: number): Promise<void> {
    if (!this.open.has(id)) return;
    await this.closeNow(id);
    await this.flush();
  }

  /** Buffer `id` closes. A buffer a group borrowed closes the group first:
   *  its owned panels, then `buffer_group_closed` (by then `getBufferInfo`
   *  is null for `id`, P42 j), then `buffer_closed` for `id` (H4). */
  private async closeNow(id: number): Promise<void> {
    this.closing.delete(id);
    if (!this.open.delete(id)) return;
    const g = [...this.groups].find((x) => x.borrowed.includes(id));
    if (g !== undefined) await this.dropGroup(g);
    for (const h of this.handlers.get("buffer_closed") ?? []) await h({ buffer_id: id, window_id: this.bufferWindow.get(id) ?? this.window });
  }

  /** A terminal buffer `id` shown in split `split` (the dock, say), with its
   *  scrollback file as its path (H12). */
  addTerminal(id: number, split: number, path = `/tmp/fresh-term-${id}.log`): void {
    this.terminals.add(id);
    this.bufferPaths.set(id, path);
    this.splitById(split)!.buffer = id;
  }

  /** The split `id`, or undefined. */
  splitById(id: number): FakeSplit | undefined {
    return this.splits.find((s) => s.id === id);
  }

  /** The user focuses split `id` (a click in it): it becomes the active
   *  split and its visible tab the active buffer, announced as the host
   *  does. */
  async clickSplit(id: number): Promise<void> {
    const sp = this.splitById(id)!;
    this.activeSplit = id;
    const buffer = sp.group === null ? sp.buffer : sp.group.borrowed[0];
    const previous = this.activeBuffer;
    this.activeBuffer = buffer;
    this.announced = buffer;
    await this.emit("active_buffer_changed", { window_id: this.window, buffer_id: buffer, previous: { window_id: this.window, buffer_id: previous }, reason: "buffer" });
  }

  /** The user closes a group's tab (its `×`, Close Tab): only
   *  `buffer_group_closed` and its owned panels' closes; the borrowed
   *  buffers stay open (H4, P41 m). */
  async closeGroupTab(g: FakeGroup): Promise<void> {
    if (!this.groups.has(g)) return;
    await this.dropGroup(g);
  }

  /** The active window's group `id`, or undefined: the host's group calls
   *  act there, and ids repeat across windows. */
  private groupOf(id: number): FakeGroup | undefined {
    return [...this.groups].find((g) => g.id === id && g.window === this.window);
  }

  /** The group shown now in split `split`, or undefined. */
  groupIn(split: number): FakeGroup | undefined {
    return this.splitById(split)?.group ?? undefined;
  }

  /** The text of buffer `id` the plugin made. */
  textOf(id: number): string | undefined {
    return this.bufferText.get(id);
  }

  /** A group closes: its owned panels, then `buffer_group_closed` (H4). */
  private async dropGroup(g: FakeGroup): Promise<void> {
    this.groups.delete(g);
    const sp = this.splitById(g.split);
    if (sp !== undefined && sp.group === g) {
      sp.group = null;
      sp.buffer = g.previous;
    }
    for (const id of g.owned) {
      if (!this.open.delete(id)) continue;
      for (const h of this.handlers.get("buffer_closed") ?? []) await h({ buffer_id: id, window_id: g.window });
    }
    for (const h of this.handlers.get("buffer_group_closed") ?? []) await h({ group_id: g.id, window_id: g.window });
  }

  /** One frame: the active buffer, announced if a focus change asked for
   *  it and it changed (H16). */
  private frame(): void {
    if (!this.focusDirty) return;
    this.focusDirty = false;
    if (this.activeBuffer === this.announced) return;
    const previous = this.announced;
    this.announced = this.activeBuffer;
    const payload = { window_id: this.window, buffer_id: this.activeBuffer, previous: { window_id: this.window, buffer_id: previous }, reason: "buffer" };
    for (const h of this.handlers.get("active_buffer_changed") ?? []) void h(payload);
  }

  /** What `getBufferInfo` gives for `id` (null once closed): a buffer the
   *  plugin made or a terminal is virtual; a user buffer or a buffer on a
   *  file path is not (H12). `splits` lists only the splits where it is the
   *  visible tab (H15). */
  private infoOf(id: number): Record<string, unknown> | null {
    const user = [...this.userBuffers.values()].find((x) => x.id === id);
    const made = this.open.has(id);
    const terminal = this.terminals.has(id);
    const file = !made && !terminal && this.bufferPaths.has(id);
    if (user === undefined && !made && !terminal && !file) return null;
    const splits = this.splits.filter((s) => s.group === null && s.buffer === id).map((s) => s.id);
    const length = user?.text.length ?? this.bufferText.get(id)?.length ?? 0;
    return { id, length, is_virtual: made || terminal, is_terminal: terminal, path: this.bufferPaths.get(id) ?? "", splits };
  }

  /** The kind `describeWorkspace` gives a pane showing buffer `id`. */
  private kindOf(id: number): string {
    if (this.terminals.has(id)) return "terminal";
    return !this.open.has(id) && this.bufferPaths.has(id) ? "file" : "virtual";
  }

  /** Splits whose visible tab is not a group: the host leaves the others
   *  out of `listSplits` and `describeWorkspace` (H3). */
  private plainSplits(): FakeSplit[] {
    return this.splits.filter((s) => s.group === null).sort((a, b) => a.y - b.y || a.x - b.x);
  }

  /** The 0-based line of byte `pos` in buffer `id`'s text. */
  private lineAt(id: number, pos: number): number {
    const text = this.bufferText.get(id) ?? "";
    let n = 0;
    for (let k = 0; k < Math.min(pos, text.length); k++) if (text[k] === "\n") n++;
    return n;
  }

  /** Each leaf of a group layout, in order. */
  private leaves(node: unknown): { type: string; id: string; bufferId?: number }[] {
    const n = node as { type: string; id: string; bufferId?: number; first?: unknown; second?: unknown };
    if (n.type === "split") return [...this.leaves(n.first), ...this.leaves(n.second)];
    return [n];
  }

  armedTimers(): number {
    return this.timers.size;
  }

  clear(): void {
    this.calls = [];
    this.procs = [];
  }

  async emit(event: string, payload: unknown = {}): Promise<void> {
    for (const h of this.handlers.get(event) ?? []) await h(payload);
    await this.flush();
  }

  async widget(event_type: string, payload: Record<string, unknown> = {}, from: WidgetFrom = {}): Promise<void> {
    const widget_key = from.widgetKey ?? "git";
    // The active window's id, whichever section sent it (INV §11.4).
    await this.emit("widget_event", { window_id: this.window, panel_id: from.panel ?? this.panel, widget_key, event_type, payload, focus_key: widget_key });
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  }

  /** Move the clock forward, firing timers, delays and process completions
   *  in time order. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await this.flush();
    for (;;) {
      const next = [...this.timers.values(), ...this.waits]
        .filter((p) => p.at <= end)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.now = Math.max(this.now, next.at);
      this.waits = this.waits.filter((w) => w !== next);
      for (const [id, t] of this.timers) if (t === next) this.timers.delete(id);
      next.fire();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }

  private record(name: string, args: unknown[]): void {
    this.calls.push({ name, args, window: this.window });
  }

  /** Something to fire `ms` from now, in creation order among equals. */
  private pending(ms: number, fire: () => void): Pending {
    return { at: this.now + Math.max(0, ms), seq: this.seq++, fire };
  }

  private later(ms: number, fire: () => void): Pending {
    const p = this.pending(ms, fire);
    this.waits.push(p);
    return p;
  }

  /** A new buffer id, open from `ms` from now (in `advance` order). */
  private newBuffer(mode?: unknown): Promise<number> {
    return new Promise<number>((r) =>
      this.later(0, () => {
        const id = this.nextBuffer++;
        this.open.add(id);
        this.bufferWindow.set(id, this.window);
        if (typeof mode === "string") this.bufferMode.set(id, mode);
        r(id);
      }),
    );
  }


  /** `closeBuffer` on a buffer the plugin made. On one already closed, or
   *  whose close is still pending, the host logs `ERROR Failed to close
   *  buffer` (H14): recorded in `errors`. */
  private closeBuffer(id: number): boolean {
    if (!this.open.has(id) || this.closing.has(id)) {
      this.errors.push(`Failed to close buffer ${id}`);
      return true;
    }
    this.closing.add(id);
    // Fire-and-forget, like the host: the close and its events come later.
    this.later(0, () => {
      void this.closeNow(id);
    });
    return true;
  }

  private spawn(via: "target" | "host", program: string, args: string[], cwd: string) {
    const windowRoot = this.windowList().find((w) => w.id === this.window)?.root ?? null;
    const call = { via, program, args: [...args], cwd, window: this.window, windowRoot };
    this.procs.push(call);
    this.allProcs.push(call);
    const shape = (r: ProcResult) =>
      via === "target" ? { code: r.code, stdout: r.stdout, stderr: r.stderr } : { exit_code: r.code, stdout: r.stdout, stderr: r.stderr };
    let resolve!: (v: unknown) => void;
    const result = new Promise<unknown>((r) => (resolve = r));
    let done = false;
    const settle = (r: ProcResult) => {
      if (done) return;
      done = true;
      resolve(shape(r));
    };
    const outcome = this.script(call);
    let pending: Pending | null = null;
    if (outcome !== "hang" && "wait" in outcome) {
      void outcome.wait.then(settle);
    } else if (outcome !== "hang") {
      const { result: r, ms } = "result" in outcome ? outcome : { result: outcome, ms: 0 };
      pending = this.later(ms, () => settle(r));
    }
    return {
      then: (a?: (v: unknown) => unknown, b?: (e: unknown) => unknown) => result.then(a, b),
      result,
      processId: this.procs.length,
      kill: async () => {
        this.kills++;
        if (pending) this.waits = this.waits.filter((w) => w !== pending);
        settle({ code: -1, stdout: "", stderr: "killed" });
        return true;
      },
    };
  }

  api(): Record<string, unknown> {
    const rec =
      <T>(name: string, ret: (...a: never[]) => T) =>
      (...a: unknown[]): T => {
        this.record(name, a);
        const queued = this.returns.get(name);
        if (queued && queued.length > 0) return queued.shift() as T;
        return (ret as (...x: unknown[]) => T)(...a);
      };
    return {
      getCwd: rec("getCwd", () => this.cwd),
      // A read the plugin makes before every git run (R28), not recorded.
      activeWindow: () => this.window,
      listWindows: rec("listWindows", () => this.windowList()),
      getAuthorityLabel: rec("getAuthorityLabel", () => this.label),
      pathJoin: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
      // As documented: the parent, or "" for a root or a path with no parent.
      pathDirname: (p: string) => {
        const t = p.length > 1 ? p.replace(/\/+$/, "") : p;
        const slash = t.lastIndexOf("/");
        return t === "/" || slash < 0 ? "" : slash === 0 ? "/" : t.slice(0, slash);
      },
      fileExists: rec("fileExists", (p: string) => this.files.has(p) || this.dirs.has(p)),
      fileStat: rec("fileStat", (p: string) =>
        this.files.has(p) || this.dirs.has(p)
          ? { isFile: this.files.has(p), isDir: this.dirs.has(p), size: this.sizes.get(p) ?? (this.contents.get(p) ?? "").length, readonly: false }
          : null,
      ),
      readFile: rec("readFile", (p: string) => (this.files.has(p) ? (this.contents.has(p) ? this.contents.get(p)! : "") : null)),
      openFile: rec("openFile", () => true),
      getBufferPath: rec("getBufferPath", (id: number) => this.bufferPaths.get(id) ?? ""),
      findBufferByPath: rec("findBufferByPath", (p: string) => this.userBuffers.get(p)?.id ?? 0),
      // Only `length` is read: the size of a user buffer's text.
      getBufferInfo: rec("getBufferInfo", (id: number) => this.infoOf(id)),
      getBufferText: (id: number) => {
        this.record("getBufferText", [id]);
        const b = [...this.userBuffers.values()].find((x) => x.id === id);
        return Promise.resolve(b?.text ?? "");
      },
      executeAction: rec("executeAction", () => true),
      setClipboard: rec("setClipboard", (text: string) => {
        this.clipboard = text;
      }),
      prompt: (label: string, initial: string) => {
        this.record("prompt", [label, initial]);
        return Promise.resolve(this.promptAnswers.length > 0 ? this.promptAnswers.shift()! : null);
      },
      startPrompt: (label: string, type: string) => {
        this.record("startPrompt", [label, type]);
        if (this.startPromptAnswers.length === 0) return true;
        const answer = Promise.resolve(this.startPromptAnswers.shift()!);
        void answer.then((a) =>
          this.later(0, () => {
            const event = a === null ? "prompt_cancelled" : "prompt_confirmed";
            const index = a === null ? -1 : this.suggestions.findIndex((x) => (x.value ?? x.text) === a);
            const payload = a === null ? { prompt_type: type, input: "" } : { prompt_type: type, input: a, selected_index: index < 0 ? null : index };
            for (const h of this.handlers.get(event) ?? []) void h(payload);
          }),
        );
        return true;
      },
      setPromptSuggestions: rec("setPromptSuggestions", (suggestions: { id: string; text: string; value?: string }[]) => {
        this.suggestions = suggestions;
        return true;
      }),
      getEnv: (name: string) => this.env.get(name),
      listPlugins: () => {
        this.record("listPlugins", []);
        return (this.pluginsGate ?? Promise.resolve()).then(() => this.plugins.map((p) => ({ ...p })));
      },
      setStatus: rec("setStatus", () => undefined),
      debug: rec("debug", () => undefined),
      info: rec("info", () => undefined),
      warn: rec("warn", () => undefined),
      error: rec("error", () => undefined),
      on: (event: string, h: Handler | string) => {
        const fn = typeof h === "string" ? (p: unknown) => this.globals.get(h)?.(p) : h;
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      },
      mountSidebarSection: rec("mountSidebarSection", (panel: number, spec: unknown) => {
        this.drawn.set(panel, spec);
        return true;
      }),
      updateFloatingWidget: rec("updateFloatingWidget", (panel: number, spec: unknown) => {
        this.drawn.set(panel, spec);
        return true;
      }),
      unmountFloatingWidget: rec("unmountFloatingWidget", () => true),
      widgetMutate: rec("widgetMutate", () => true),
      floatingPanelControl: rec("floatingPanelControl", () => true),
      mountFloatingWidget: rec("mountFloatingWidget", () => true),
      createVirtualBuffer: (opts: unknown) => {
        this.record("createVirtualBuffer", [opts]);
        const o = opts as { mode?: unknown; entries?: { text: string }[] };
        const text = (o.entries ?? []).map((e) => e.text).join("");
        return this.newBuffer(o.mode).then((bufferId) => {
          this.bufferText.set(bufferId, text);
          return { bufferId, splitId: null };
        });
      },
      getActiveSplitId: rec("getActiveSplitId", () => this.activeSplit),
      // Queued, and announced at the next frame, not by itself (H16). An
      // unknown id changes nothing and logs a WARN (P42 e).
      focusSplit: rec("focusSplit", (id: number) => {
        const sp = this.splitById(id);
        if (sp === undefined) {
          this.warnings.push(`Split SplitId(${id}) not found`);
          return true;
        }
        this.activeSplit = id;
        this.activeBuffer = sp.group === null ? sp.buffer : sp.group.borrowed[0];
        this.focusDirty = true;
        return true;
      }),
      listSplits: rec("listSplits", () =>
        this.plainSplits().map((s) => ({ splitId: s.id, bufferId: s.buffer, label: null, x: s.x, y: s.y, width: s.width, height: s.height })),
      ),
      describeWorkspace: rec("describeWorkspace", () => ({
        cwd: this.cwd,
        activeSplitId: this.activeSplit,
        panes: this.plainSplits().map((s) => ({
          splitId: s.id,
          bufferId: s.buffer,
          kind: this.kindOf(s.buffer),
          label: null,
          path: this.bufferPaths.get(s.buffer) ?? null,
          name: "",
          active: s.id === this.activeSplit,
          modified: false,
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
        })),
      })),
      flush: () => {
        this.record("flush", []);
        return new Promise<void>((r) =>
          this.later(0, () => {
            this.frame();
            r();
          }),
        );
      },
      // One tab in the active split; scrollable leaves with `bufferId`
      // borrow those buffers, fixed leaves get owned ones; the first
      // borrowed buffer becomes active, announced at the frame after the
      // call settles (H1, H2, H10, P42 k).
      createBufferGroup: (name: string, mode: string, layout: string) => {
        this.record("createBufferGroup", [name, mode, layout]);
        const parsed: unknown = JSON.parse(layout);
        const window = this.window;
        const split = this.activeSplit;
        const gate = this.groupGate ?? Promise.resolve();
        return gate.then(
          () =>
            new Promise((resolve) =>
              this.later(0, () => {
                const id = this.nextGroup.get(window) ?? 0;
                this.nextGroup.set(window, id + 1);
                const g: FakeGroup = { id, window, name, mode, layout: parsed, split, panels: {}, panelSplits: {}, borrowed: [], owned: [], previous: 0 };
                for (const leaf of this.leaves(parsed)) {
                  let buffer = leaf.bufferId;
                  if (buffer === undefined) {
                    buffer = this.nextBuffer++;
                    this.open.add(buffer);
                    this.bufferWindow.set(buffer, window);
                    g.owned.push(buffer);
                  } else g.borrowed.push(buffer);
                  g.panels[leaf.id] = buffer;
                  g.panelSplits[leaf.id] = this.nextSplit++;
                }
                const sp = this.splitById(split)!;
                g.previous = sp.buffer;
                sp.group = g;
                this.groups.add(g);
                this.groupsMade.push(g);
                this.activeSplit = split;
                this.activeBuffer = g.borrowed[0] ?? this.activeBuffer;
                this.focusDirty = true;
                resolve({ groupId: id, panels: { ...g.panels }, panelSplits: { ...g.panelSplits } });
                this.later(0, () => this.frame());
              }),
            ),
        );
      },
      closeBufferGroup: rec("closeBufferGroup", (id: number) => {
        const g = this.groupOf(id);
        if (g !== undefined) void this.dropGroup(g);
        return true;
      }),
      setPanelContent: rec("setPanelContent", () => true),
      focusBufferGroupPanel: rec("focusBufferGroupPanel", (groupId: number, panel: string) => {
        const g = this.groupOf(groupId);
        if (g === undefined || g.panels[panel] === undefined) return true;
        const sp = this.splitById(g.split);
        if (sp !== undefined) sp.group = g;
        this.activeSplit = g.split;
        this.activeBuffer = g.panels[panel];
        this.focusDirty = true;
        return true;
      }),
      // Rejects for a buffer not open, as the host does for one not in the
      // active window.
      compareBuffers: (left: number, right: number) => {
        this.record("compareBuffers", [left, right]);
        if (this.compareResult !== null) return Promise.resolve(this.compareResult);
        const [a, b] = [this.bufferText.get(left), this.bufferText.get(right)];
        if (!this.open.has(left) || !this.open.has(right) || a === undefined || b === undefined) return Promise.reject(new Error("buffer not found"));
        return Promise.resolve(compareTexts(a, b));
      },
      addOverlay: rec("addOverlay", () => true),
      addVirtualLine: rec("addVirtualLine", () => true),
      setLineIndicators: rec("setLineIndicators", () => true),
      setScrollbarMarkers: rec("setScrollbarMarkers", () => true),
      setLineWrap: rec("setLineWrap", () => true),
      createScrollSyncGroup: rec("createScrollSyncGroup", () => true),
      setScrollSyncAnchors: rec("setScrollSyncAnchors", () => true),
      removeScrollSyncGroup: rec("removeScrollSyncGroup", () => true),
      setBufferCursor: rec("setBufferCursor", (id: number, position: number) => {
        this.cursors.set(id, { position, line: this.lineAt(id, position) });
        return true;
      }),
      scrollToLineCenter: rec("scrollToLineCenter", () => true),
      getPrimaryCursor: rec("getPrimaryCursor", () => {
        const c = this.cursors.get(this.activeBuffer) ?? { position: 0, line: 0 };
        return { position: c.position, selection: null, line: c.line };
      }),
      getCursorLine: rec("getCursorLine", () => (this.cursors.get(this.activeBuffer) ?? { line: 0 }).line),
      showBuffer: rec("showBuffer", (id: number) => {
        this.activeBuffer = id;
        const sp = this.splitById(this.activeSplit);
        if (sp !== undefined) {
          sp.buffer = id;
          sp.group = null;
        }
        return true;
      }),
      getActiveBufferId: rec("getActiveBufferId", () => this.activeBuffer),
      closeBuffer: rec("closeBuffer", (id: number) => this.closeBuffer(id)),
      defineMode: rec("defineMode", () => true),
      registerCommand: rec("registerCommand", (name: string, _d: string, handler: string, context?: string | null) => {
        this.commands.set(name, handler);
        this.contextOf.set(name, context ?? null);
        return true;
      }),
      setContext: rec("setContext", (name: string, on: boolean) => {
        if (on) this.contextsOf(this.window).add(name);
        else this.contextsOf(this.window).delete(name);
        return true;
      }),
      setTimeout: rec("setTimeout", (ms: number, name: string) => {
        const id = this.nextTimer++;
        this.timers.set(id, this.pending(ms, () => this.globals.get(name)?.()));
        return id;
      }),
      clearInterval: rec("clearInterval", (id: number) => this.timers.delete(id)),
      delay: (ms: number) => new Promise<void>((r) => this.later(ms, r)),
      runOnTarget: (program: string, args: string[] = [], cwd = "") => this.spawn("target", program, args, cwd),
      spawnHostProcess: (program: string, args: string[], cwd = "") => this.spawn("host", program, args, cwd),
    };
  }
}
