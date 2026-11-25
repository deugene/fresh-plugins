// A fake of the part of Fresh's EditorAPI the plugin uses, vendored from
// git-sidebar's and cut down. Processes resolve with `spawnHostProcess`'s
// shape (`{exit_code, stdout, stderr}`) on a manual clock, with `kill`
// (INV §8 P21); a window whose trust is Blocked refuses every spawn with
// the host's message (INV §7, §8 P27). Windows (INV §2): group and split
// ids are per window and start afresh in each. Buffer ids do too, which is
// stricter than the host, whose buffer ids are global: the plugin keys on
// (window, id) either way. Buffer lookups, focus, groups, panels, status and
// contexts act on the active window. `scratchCreate` gives directories under
// `/cfg/.staging/` (INV §8 P31). Buffer groups behave as INV §2, P7, P15
// and §8 P17 found:
// - a group lands in its file's tab only while that file is the window's
//   current tab when the host handles the create; else it gets a tab of
//   its own, and `getBufferInfo(file).splits` no longer names split 0;
// - `closeBufferGroup` fires `buffer_closed` for its panels, then
//   `buffer_group_closed`, then `buffer_activated` for the file;
// - closing the file fires `buffer_closed` for it and its panels, then
//   `buffer_group_closed`;
// - an explorer preview (`preview`) opens into the active buffer's id when
//   that buffer is a panel nothing has been written to, and closes the
//   previous preview, its group and that group's panels with it (INV §8 P32).
// The host closes only an inactive window: `buffer_closed` for each of its
// buffers, then `window_closed` (docs/investigations/git-sidebar.md §11.4).

export interface ProcCall {
  program: string;
  args: string[];
  /** The window active when it started. */
  window: number;
  /** Simulated time it started. */
  at: number;
  /** Refused by the window's Blocked trust: it ran nothing. */
  refused: boolean;
  /** Its place among every call and process, in order. */
  order: number;
}

/** What the host says when Blocked trust refuses a spawn (INV §8 P27). */
export const BLOCKED = "workspace trust is set to Blocked — no processes may run";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What a process does: resolve after `ms` simulated milliseconds (default
 *  0), reject its result (as the host does with no async runtime), or hang
 *  until killed. */
export type ProcOutcome = ProcResult | { result: ProcResult; ms: number } | { reject: Error } | "hang";

export interface Call {
  name: string;
  args: unknown[];
  /** The window active when the call was made. */
  window: number;
  /** Its place among every call and process, in order. */
  order: number;
}

interface Pending {
  at: number;
  seq: number;
  fire: () => void;
}

export interface Group {
  id: number;
  file: number;
  inTab: boolean;
  panels: { hdr: number; img: number };
  splits: { hdr: number; img: number };
  content: Map<string, unknown[]>;
}

interface Win {
  id: number;
  remote: boolean;
  trust: string;
  buffers: Map<number, Buffer>;
  nextBuffer: number;
  /** The focused split (`getActiveSplitId`); the file's tab is split 0's. */
  activeSplit: number;
  activeBuffer: number;
  /** The file that is the main split's buffer tab (`buffer_tab()`). */
  currentTab: number | null;
  groups: Map<number, Group>;
  nextGroup: number;
  nextSplit: number;
  contexts: Set<string>;
}

interface Buffer {
  id: number;
  window: number;
  path: string;
  panel: boolean;
}

type Handler = (payload: unknown) => unknown;

export class FakeEditor {
  now = 1_000_000;
  theme = "high-contrast";
  themes = new Map<string, unknown>([["high-contrast", { editor: { bg: [0, 0, 0] } }]]);
  /** When true, `scratchCreate` fails, as when the config dir cannot be
   *  written. Like `scratchPath` for a spent token, it then gives `undefined`,
   *  as the host does for a Rust `Option`, not the DTS's `null`. */
  scratchFail = false;
  /** Every directory `scratchCreate` made, by token, and whether it is still there. */
  private readonly scratchDirs = new Map<string, { dir: string; live: boolean }>();
  themesDir = "/home/u/.config/fresh/themes";
  /** The editor's environment, as `getEnv` reads it. */
  env = new Map<string, string>([["HOME", "/home/u"]]);
  /** The image split's size sent after a create, as the host does (P17);
   *  null: none, the test sends `viewport` itself. */
  autoViewport: { width: number; height: number } | null = { width: 199, height: 55 };
  /** Simulated ms a create takes. */
  createMs = 0;
  /** When set, the next create rejects with it. */
  createError: Error | null = null;
  /** When set, the next create throws it synchronously, as a binding does
   *  for an argument it cannot convert. */
  createThrow: Error | null = null;
  /** Simulated ms a killed process takes to exit (P21: 110–130 ms). */
  killMs = 0;
  calls: Call[] = [];
  procs: ProcCall[] = [];
  kills: ProcCall[] = [];
  /** Processes started and not yet settled. */
  running = new Set<ProcCall>();
  script: (call: ProcCall) => ProcOutcome = () => ({ code: 127, stdout: "", stderr: "not scripted" });

  private wins = new Map<number, Win>();
  private active = 1;
  private handlers = new Map<string, Handler[]>();
  private globals = new Map<string, (payload?: unknown) => unknown>();
  private waits: Pending[] = [];
  private seq = 0;
  private order = 0;
  private realNow = Date.now;
  private commands = new Map<string, { handler: string; context: string | null }>();
  private modes = new Map<string, Map<string, string>>();

  constructor() {
    this.addWindow(1);
  }

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

  addWindow(id: number, opts: { remote?: boolean } = {}): void {
    this.wins.set(id, {
      id,
      remote: opts.remote ?? false,
      trust: "trusted",
      buffers: new Map(),
      nextBuffer: 1,
      activeSplit: 0,
      activeBuffer: 0,
      currentTab: null,
      groups: new Map(),
      nextGroup: 0,
      nextSplit: 1,
      contexts: new Set(),
    });
  }

  /** The active window's focused split. */
  get activeSplit(): number {
    return this.win().activeSplit;
  }

  set activeSplit(split: number) {
    this.win().activeSplit = split;
  }

  /** Sets a window's workspace trust, as the trust dialog does, and fires
   *  `trust_changed` (INV §7). */
  async setTrust(level: "trusted" | "restricted" | "blocked", window = this.active): Promise<void> {
    this.win(window).trust = level;
    await this.emit("trust_changed", { level });
  }

  get activeWindow(): number {
    return this.active;
  }

  /** Makes `id` the active window without `active_window_changed`, as when
   *  the event is still on its way. */
  setActive(id: number): void {
    this.active = id;
  }

  private win(id = this.active): Win {
    const w = this.wins.get(id);
    if (w === undefined) throw new Error(`no window ${id}`);
    return w;
  }

  named(name: string): Call[] {
    return this.calls.filter((c) => c.name === name);
  }

  /** The directories `scratchCreate` made, in order, and whether each is still there. */
  scratches(): { dir: string; live: boolean }[] {
    return [...this.scratchDirs.values()].map((d) => ({ ...d }));
  }

  statuses(window?: number): string[] {
    return this.named("setStatus")
      .filter((c) => window === undefined || c.window === window)
      .map((c) => String(c.args[0]));
  }

  /** The groups open in a window. */
  groups(window = this.active): Group[] {
    return [...this.win(window).groups.values()];
  }

  /** Whether the window shows a tab of a group's own (an orphan). */
  ownTabs(window = this.active): Group[] {
    return this.groups(window).filter((g) => !g.inTab);
  }

  /** Buffers open, panels included, in every window. */
  openBuffers(): Buffer[] {
    return [...this.wins.values()].flatMap((w) => [...w.buffers.values()]);
  }

  contextOn(name: string, window = this.active): boolean {
    return this.win(window).contexts.has(name);
  }

  /** Commands registered, by name, and whether each is listed now. */
  palette(): Map<string, boolean> {
    const out = new Map<string, boolean>();
    for (const [name, c] of this.commands) out.set(name, c.context === null || this.contextOn(c.context));
    return out;
  }

  async command(name: string): Promise<void> {
    const c = this.commands.get(name);
    if (c === undefined) throw new Error(`no command ${name}`);
    await this.fire(c.handler);
  }

  /** A key in the view, as the mode routes it (INV §2, P13). */
  async key(k: string, mode = "image-viewer"): Promise<void> {
    const handler = this.modes.get(mode)?.get(k);
    if (handler === undefined) throw new Error(`no binding for ${k} in ${mode}`);
    await this.fire(handler);
  }

  bindings(mode = "image-viewer"): string[] {
    return [...(this.modes.get(mode)?.keys() ?? [])];
  }

  async fire(handler: string): Promise<void> {
    const fn = this.globals.get(handler);
    if (fn === undefined) throw new Error(`no handler ${handler}`);
    await fn();
    await this.flush();
  }

  // ---------------------------------------------------------------- the user

  /** Opens `path` as a new tab in the active window and activates it: the
   *  `buffer_activated` every route ends with (P2). */
  async open(path: string): Promise<number> {
    const w = this.win();
    const id = w.nextBuffer++;
    w.buffers.set(id, { id, window: w.id, path, panel: false });
    await this.activate(id);
    return id;
  }

  /** The explorer's cursor moves to `path` while `prev` is the preview tab
   *  (INV §8 P32). The host opens `path` into the active buffer's id when
   *  that buffer is pristine (empty, unmodified, no path), which a group
   *  panel is until something is written to it, and otherwise as a new
   *  buffer. Then it closes `prev`, and with it the group in its tab and
   *  that group's panels: a file opened into a panel closes too. */
  async preview(path: string, prev: number): Promise<number> {
    const w = this.win();
    const g = [...w.groups.values()].find((x) => x.panels.hdr === w.activeBuffer || x.panels.img === w.activeBuffer);
    const panel = g === undefined ? undefined : g.panels.hdr === w.activeBuffer ? "hdr" : "img";
    const written = (g?.content.get(panel ?? "") ?? []).some((e) => ((e as { text?: string }).text ?? "") !== "");
    const id = g !== undefined && !written ? w.activeBuffer : w.nextBuffer++;
    w.buffers.set(id, { id, window: w.id, path, panel: false });
    w.currentTab = id;
    w.activeBuffer = id;
    this.emitLater("buffer_activated", { buffer_id: id, window_id: w.id });
    this.closeFile(w, prev);
    await this.advance(0);
    return id;
  }

  /** The user switches the active window's tab to `id`. */
  async activate(id: number): Promise<void> {
    const w = this.win();
    const b = w.buffers.get(id);
    w.activeBuffer = id;
    if (b !== undefined && !b.panel) {
      const g = [...w.groups.values()].find((x) => x.file === id && x.inTab);
      w.currentTab = id;
      // A tab with a group in it activates the group's image panel (P20).
      if (g !== undefined) w.activeBuffer = g.panels.img;
    }
    await this.emit("buffer_activated", { buffer_id: w.activeBuffer, window_id: w.id });
  }

  /** The user closes a file's tab (Alt+W, ×; P15). */
  async closeTab(id: number, window = this.active): Promise<void> {
    this.closeFile(this.win(window), id);
    await this.advance(0);
  }

  /** The host closes window `id`, which is not the active one. */
  async closeWindow(id: number): Promise<void> {
    if (id === this.active) throw new Error("the host closes only an inactive window");
    const w = this.win(id);
    this.wins.delete(id);
    for (const b of [...w.buffers.keys()]) this.emitLater("buffer_closed", { buffer_id: b, window_id: id });
    this.emitLater("window_closed", { id });
    await this.advance(0);
  }

  async switchWindow(id: number): Promise<void> {
    const previous = this.active;
    this.active = id;
    await this.emit("active_window_changed", { previous_id: previous, active_id: id });
  }

  /** A left click, as the host reports it (DTS MouseClickHookArgs). */
  async click(bufferId: number | null): Promise<void> {
    await this.emit("mouse_click", { column: 10, row: 10, button: "left", modifiers: "", content_x: 0, content_y: 0, buffer_id: bufferId, buffer_row: bufferId === null ? null : 5, buffer_col: bufferId === null ? null : 30 });
  }

  /** The host's `viewport_changed` for a split of a window. */
  async viewport(split: number, width: number, height: number, window = this.active): Promise<void> {
    await this.emit("viewport_changed", { split_id: split, buffer_id: 0, window_id: window, top_byte: 0, top_line: 0, width, height });
  }

  // ---------------------------------------------------------------- the clock

  async emit(event: string, payload: unknown = {}): Promise<void> {
    for (const h of this.handlers.get(event) ?? []) await h(payload);
    await this.flush();
  }

  private emitLater(event: string, payload: unknown): void {
    for (const h of this.handlers.get(event) ?? []) void h(payload);
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
  }

  /** Moves the clock forward, firing delays, creates and process
   *  completions in time order. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await this.flush();
    for (;;) {
      const next = this.waits.filter((p) => p.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.now = Math.max(this.now, next.at);
      this.waits = this.waits.filter((w) => w !== next);
      next.fire();
      await this.flush();
    }
    this.now = end;
    await this.flush();
  }

  private later(ms: number, fire: () => void): void {
    this.waits.push({ at: this.now + Math.max(0, ms), seq: this.seq++, fire });
  }

  private record(name: string, args: unknown[]): void {
    this.calls.push({ name, args, window: this.active, order: this.order++ });
  }

  // ---------------------------------------------------------------- the host

  private newPanel(w: Win): number {
    const id = w.nextBuffer++;
    w.buffers.set(id, { id, window: w.id, path: "", panel: true });
    return id;
  }

  private createGroup(inTabOf: number | undefined): Promise<unknown> {
    const thrown = this.createThrow;
    this.createThrow = null;
    if (thrown !== null) throw thrown;
    const error = this.createError;
    this.createError = null;
    // Handled in the window that sent it.
    const w = this.win();
    return new Promise((resolve, reject) =>
      this.later(this.createMs, () => {
        if (error !== null) {
          reject(error);
          return;
        }
        const file = w.buffers.get(inTabOf ?? -1);
        const inTab = file !== undefined && !file.panel && w.currentTab === inTabOf;
        const g: Group = {
          id: w.nextGroup++,
          file: inTabOf ?? -1,
          inTab,
          panels: { hdr: this.newPanel(w), img: this.newPanel(w) },
          splits: { hdr: w.nextSplit++, img: w.nextSplit++ },
          content: new Map(),
        };
        w.groups.set(g.id, g);
        // A group in a tab of its own is shown without changing the split's
        // buffer tab (`show_group`), so a later create can still land in it.
        w.activeBuffer = g.panels.img;
        resolve({ groupId: g.id, panels: { ...g.panels }, panelSplits: { ...g.splits } });
        const vp = this.autoViewport;
        if (vp !== null) {
          this.later(1, () => {
            if (!w.groups.has(g.id)) return;
            this.emitLater("viewport_changed", { split_id: g.splits.hdr, buffer_id: g.panels.hdr, window_id: w.id, top_byte: 0, top_line: 0, width: vp.width + 1, height: 1 });
            this.emitLater("viewport_changed", { split_id: g.splits.img, buffer_id: g.panels.img, window_id: w.id, top_byte: 0, top_line: 0, width: vp.width, height: vp.height });
          });
        }
      }),
    );
  }

  private closeGroupNow(w: Win, g: Group, thenFile: boolean): void {
    w.groups.delete(g.id);
    for (const p of [g.panels.hdr, g.panels.img]) {
      w.buffers.delete(p);
      this.emitLater("buffer_closed", { buffer_id: p, window_id: w.id });
    }
    this.emitLater("buffer_group_closed", { group_id: g.id, window_id: w.id });
    if (!thenFile) return;
    // The file's tab shows the file again (P7); closing a group's own tab
    // goes back to the buffer tab (INV §8 P17).
    const back = g.inTab ? g.file : w.currentTab;
    if (back !== null && w.buffers.has(back)) {
      w.activeBuffer = back;
      this.emitLater("buffer_activated", { buffer_id: back, window_id: w.id });
    }
  }

  private closeFile(w: Win, id: number): void {
    const b = w.buffers.get(id);
    if (b === undefined || b.panel) return;
    w.buffers.delete(id);
    this.emitLater("buffer_closed", { buffer_id: id, window_id: w.id });
    for (const g of [...w.groups.values()]) if (g.file === id && g.inTab) this.closeGroupNow(w, g, false);
    if (w.currentTab === id) w.currentTab = null;
    if (w.activeBuffer === id) w.activeBuffer = 0;
  }

  private spawn(program: string, args: string[]) {
    const refused = this.win().trust === "blocked";
    const call: ProcCall = { program, args: [...args], window: this.active, at: this.now, refused, order: this.order++ };
    this.procs.push(call);
    this.running.add(call);
    let resolve!: (v: SpawnResultShape) => void;
    let reject!: (e: Error) => void;
    const result = new Promise<SpawnResultShape>((r, j) => {
      resolve = r;
      reject = j;
    });
    let done = false;
    const settle = (r: ProcResult | Error) => {
      if (done) return;
      done = true;
      this.running.delete(call);
      if (r instanceof Error) reject(r);
      else resolve({ exit_code: r.code, stdout: r.stdout, stderr: r.stderr });
    };
    const outcome: ProcOutcome = refused ? { code: -1, stdout: "", stderr: BLOCKED } : this.script(call);
    if (outcome === "hang") {
      // Settled only by a kill.
    } else if ("reject" in outcome) {
      this.later(0, () => settle(outcome.reject));
    } else {
      const { result: r, ms } = "result" in outcome ? outcome : { result: outcome, ms: 0 };
      this.later(ms, () => settle(r));
    }
    return {
      result,
      kill: async () => {
        this.kills.push(call);
        if (this.killMs > 0) this.later(this.killMs, () => settle({ code: -1, stdout: "", stderr: "" }));
        else settle({ code: -1, stdout: "", stderr: "" });
        return true;
      },
    };
  }

  api(): Record<string, unknown> {
    const rec =
      <T>(name: string, ret: (...a: never[]) => T) =>
      (...a: unknown[]): T => {
        this.record(name, a);
        return (ret as (...x: unknown[]) => T)(...a);
      };
    return {
      activeWindow: () => this.active,
      listWindows: () => [...this.wins.values()].map((w) => ({ id: w.id, stable_id: `ws-${w.id}`, label: `w${w.id}`, root: "/work", project_path: "/work", ...(w.remote ? { remote: { kind: "ssh" } } : {}) })),
      workspaceTrustLevel: () => this.win().trust,
      scratchCreate: (label: string) => {
        if (this.scratchFail) return undefined;
        const n = this.scratchDirs.size;
        this.scratchDirs.set(`s${n}`, { dir: `/cfg/.staging/${label}-${n}`, live: true });
        return `s${n}`;
      },
      scratchPath: (token: string) => {
        const d = this.scratchDirs.get(token);
        return d?.live ? d.dir : undefined;
      },
      scratchDiscard: (token: string) => {
        const d = this.scratchDirs.get(token);
        if (!d?.live) return false;
        d.live = false;
        return true;
      },
      getThemesDir: () => this.themesDir,
      getEnv: (name: string) => this.env.get(name) ?? null,
      pathJoin: (...parts: string[]) => parts.join("/").replace(/\/+/g, "/"),
      getConfig: rec("getConfig", () => ({ theme: this.theme })),
      getThemeData: (name: string) => this.themes.get(name) ?? null,
      getBufferPath: (id: number) => this.win().buffers.get(id)?.path ?? "",
      getActiveBufferId: () => this.win().activeBuffer,
      getActiveSplitId: () => this.win().activeSplit,
      getBufferInfo: (id: number) => {
        const w = this.win();
        const b = w.buffers.get(id);
        if (b === undefined) return null;
        return { id, path: b.path, splits: w.currentTab === id ? [0] : [] };
      },
      createBufferGroup: rec("createBufferGroup", (_name: string, _mode: string, _layout: string, opts?: { inTabOf?: number }) => this.createGroup(opts?.inTabOf)),
      closeBufferGroup: rec("closeBufferGroup", (gid: number) => {
        const w = this.win();
        const g = w.groups.get(gid);
        if (g === undefined) return true;
        this.later(0, () => {
          if (w.groups.get(gid) === g) this.closeGroupNow(w, g, true);
        });
        return true;
      }),
      setPanelContent: rec("setPanelContent", (gid: number, panel: string, entries: unknown[]) => {
        const g = this.win().groups.get(gid);
        if (g === undefined) return false;
        g.content.set(panel, entries);
        return true;
      }),
      closeBuffer: rec("closeBuffer", (id: number) => {
        // Fire-and-forget, like the host: the close and its events come later.
        const w = this.win();
        this.later(0, () => this.closeFile(w, id));
        return true;
      }),
      setBufferCursor: rec("setBufferCursor", () => true),
      setLineNumbers: rec("setLineNumbers", () => true),
      setBufferShowCursors: rec("setBufferShowCursors", () => true),
      setLineWrap: rec("setLineWrap", () => true),
      setStatus: rec("setStatus", () => undefined),
      debug: rec("debug", () => undefined),
      on: (event: string, h: Handler) => {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
      },
      defineMode: rec("defineMode", (name: string, bindings: string[][]) => {
        this.modes.set(name, new Map(bindings.map(([k, h]) => [k, h])));
        return true;
      }),
      registerCommand: rec("registerCommand", (name: string, _d: string, handler: string, context?: string | null) => {
        this.commands.set(name, { handler, context: context ?? null });
        return true;
      }),
      setContext: rec("setContext", (name: string, on: boolean) => {
        const set = this.win().contexts;
        if (on) set.add(name);
        else set.delete(name);
        return true;
      }),
      delay: (ms: number) => new Promise<void>((r) => this.later(ms, r)),
      spawnHostProcess: (program: string, args: string[]) => this.spawn(program, args),
    };
  }
}

interface SpawnResultShape {
  exit_code: number;
  stdout: string;
  stderr: string;
}
