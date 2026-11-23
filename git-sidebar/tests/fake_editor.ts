// A fake of the part of Fresh's EditorAPI the plugin uses: a call log,
// processes that resolve with the real result shapes (`{code}` from
// `runOnTarget`, `{exit_code}` from `spawnHostProcess`), host timers and
// `delay` on a manual clock, and an event emitter.

export interface ProcCall {
  via: "target" | "host";
  program: string;
  args: string[];
  cwd: string;
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
}

export const WIDGET_CALLS = new Set([
  "mountSidebarSection",
  "updateFloatingWidget",
  "unmountFloatingWidget",
  "widgetMutate",
  "floatingPanelControl",
]);

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
  /** Return values that replace an API call's default, by call name. Each
   *  entry is consumed by one call. */
  returns = new Map<string, unknown[]>();
  files = new Set<string>();
  dirs = new Set<string>();
  calls: Call[] = [];
  procs: ProcCall[] = [];
  kills = 0;
  script: (call: ProcCall) => ProcOutcome = () => ({ code: 127, stdout: "", stderr: "not scripted" });

  private handlers = new Map<string, Handler[]>();
  private globals = new Map<string, (payload?: unknown) => unknown>();
  private timers = new Map<number, Pending>();
  private waits: Pending[] = [];
  private nextTimer = 1;
  private seq = 0;
  private realNow = Date.now;

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

  async widget(event_type: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.emit("widget_event", { window_id: 1, panel_id: 1, widget_key: "git", event_type, payload, focus_key: "git" });
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
    this.calls.push({ name, args });
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

  private spawn(via: "target" | "host", program: string, args: string[], cwd: string) {
    const call = { via, program, args: [...args], cwd };
    this.procs.push(call);
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
      activeWindow: rec("activeWindow", () => this.window),
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
        this.files.has(p) || this.dirs.has(p) ? { isFile: this.files.has(p), isDir: this.dirs.has(p), size: 0, readonly: false } : null,
      ),
      openFile: rec("openFile", () => true),
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
