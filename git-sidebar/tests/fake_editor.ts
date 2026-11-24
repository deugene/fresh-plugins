// A fake of the part of Fresh's EditorAPI the plugin uses: a call log,
// processes that resolve with the real result shapes (`{code}` from
// `runOnTarget`, `{exit_code}` from `spawnHostProcess`), host timers and
// `delay` on a manual clock, and an event emitter. Windows (R28): a list
// for `listWindows`, contexts stored per window and written to the active
// one, and helpers that switch and close windows as the host does (INV §11).

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
  /** When set, `createCompositeBuffer` settles only after this does. */
  compositeGate: Promise<void> | null = null;
  /** What `getCompositeCursorInfo` resolves with (null: the active buffer
   *  is not a composite), or a promise the test settles. */
  cursorInfo: { focusedPane: number; paneCount: number; lines: (number | null)[] } | null | Promise<unknown> = null;
  /** Buffers open in the editor that the plugin did not make, by path: the
   *  id `findBufferByPath` gives and the text `getBufferText` gives, which
   *  may differ from the file on disk (unsaved edits). */
  userBuffers = new Map<string, { id: number; text: string }>();
  /** `getBufferPath` by buffer id ("" for any other, as for a virtual buffer). */
  bufferPaths = new Map<number, string>();
  /** What `getActiveBufferId` gives: the buffer `showBuffer` last showed,
   *  or one a test sets, as a tab change would. */
  activeBuffer = 0;
  /** What `listPlugins` lists: by default merge_conflict, enabled. */
  plugins: { name: string; path: string; enabled: boolean }[] = [{ name: "merge_conflict", path: "merge_conflict.ts", enabled: true }];
  /** What each `prompt` resolves with, in order (null: Esc), or a promise
   *  the test settles. With none left, Esc. */
  promptAnswers: (string | null | Promise<string | null>)[] = [];
  /** When set, `listPlugins` settles only after this does. */
  pluginsGate: Promise<void> | null = null;
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
  /** Composite state the host keeps per composite buffer, apart from the
   *  buffer: only `closeCompositeBuffer` drops it, not `closeBuffer`
   *  (`composite_buffer_actions.rs:217-222`). */
  private composites = new Set<number>();
  private nextBuffer = 100;
  private commands = new Map<string, string>();
  /** Contexts by window: `setContext` writes to the active window's. */
  private contexts = new Map<number, Set<string>>();
  /** The window each buffer the plugin made was opened in. */
  private bufferWindow = new Map<number, number>();

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

  /** Composite buffers whose host state has not been dropped. */
  compositeStates(): Set<number> {
    return new Set(this.composites);
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

  private listed(name: string): boolean {
    const ctx = this.contextOf.get(name) ?? null;
    return ctx === null || this.contextsOf(this.window).has(ctx);
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
    for (const [buffer, w] of this.bufferWindow) {
      if (w !== id) continue;
      this.composites.delete(buffer);
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
    if (!this.open.delete(id)) return;
    await this.emit("buffer_closed", { buffer_id: id, window_id: this.bufferWindow.get(id) ?? this.window });
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
  private newBuffer(): Promise<number> {
    return new Promise<number>((r) =>
      this.later(0, () => {
        const id = this.nextBuffer++;
        this.open.add(id);
        this.bufferWindow.set(id, this.window);
        r(id);
      }),
    );
  }

  private closeBuffer(id: number): boolean {
    if (!this.open.has(id)) return true;
    // Fire-and-forget, like the host: the close and its event come later.
    this.later(0, () => {
      if (!this.open.delete(id)) return;
      for (const h of this.handlers.get("buffer_closed") ?? []) void h({ buffer_id: id, window_id: this.bufferWindow.get(id) ?? this.window });
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
      getBufferInfo: rec("getBufferInfo", (id: number) => {
        const b = [...this.userBuffers.values()].find((x) => x.id === id);
        return b === undefined ? null : { id, length: b.text.length };
      }),
      getBufferText: (id: number) => {
        this.record("getBufferText", [id]);
        const b = [...this.userBuffers.values()].find((x) => x.id === id);
        return Promise.resolve(b?.text ?? "");
      },
      executeAction: rec("executeAction", () => true),
      prompt: (label: string, initial: string) => {
        this.record("prompt", [label, initial]);
        return Promise.resolve(this.promptAnswers.length > 0 ? this.promptAnswers.shift()! : null);
      },
      listPlugins: () => {
        this.record("listPlugins", []);
        return (this.pluginsGate ?? Promise.resolve()).then(() => this.plugins.map((p) => ({ ...p })));
      },
      getCompositeCursorInfo: () => {
        this.record("getCompositeCursorInfo", []);
        return Promise.resolve(this.cursorInfo);
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
      mountSidebarSection: rec("mountSidebarSection", () => true),
      updateFloatingWidget: rec("updateFloatingWidget", () => true),
      unmountFloatingWidget: rec("unmountFloatingWidget", () => true),
      widgetMutate: rec("widgetMutate", () => true),
      floatingPanelControl: rec("floatingPanelControl", () => true),
      mountFloatingWidget: rec("mountFloatingWidget", () => true),
      createVirtualBuffer: (opts: unknown) => {
        this.record("createVirtualBuffer", [opts]);
        return this.newBuffer().then((bufferId) => ({ bufferId, splitId: null }));
      },
      createCompositeBuffer: (opts: unknown) => {
        this.record("createCompositeBuffer", [opts]);
        const gate = this.compositeGate ?? Promise.resolve();
        return gate.then(() => this.newBuffer()).then((id) => {
          this.composites.add(id);
          return id;
        });
      },
      // As the host tokenises (`fresh-core/src/diff.rs:36-55`): lines keep
      // their `\n`, and a final unterminated segment is a line, so a change
      // to the final newline alone is a hunk. One hunk over everything
      // between the common prefix and suffix: enough for the plugin, which
      // passes the hunks on as they are.
      computeLineDiff: rec("computeLineDiff", (a: string, b: string) => {
        const lines = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const x = lines(a);
        const y = lines(b);
        let pre = 0;
        while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
        let suf = 0;
        while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
        const oldCount = x.length - pre - suf;
        const newCount = y.length - pre - suf;
        return oldCount === 0 && newCount === 0 ? [] : [{ oldStart: pre, oldCount, newStart: pre, newCount }];
      }),
      showBuffer: rec("showBuffer", (id: number) => {
        this.activeBuffer = id;
        return true;
      }),
      getActiveBufferId: rec("getActiveBufferId", () => this.activeBuffer),
      closeBuffer: rec("closeBuffer", (id: number) => this.closeBuffer(id)),
      // As in Fresh 0.5.9: drops the composite's state, not the buffer
      // (INV §9.4, P9 c). Only closeBuffer closes it.
      closeCompositeBuffer: rec("closeCompositeBuffer", (id: number) => {
        this.composites.delete(id);
        return true;
      }),
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
