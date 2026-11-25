// Running a plan's steps (R11, INV §7, §8 P21, P31). Each converter step
// is spawned directly, never under `sh -c`: `kill()` reaches only the direct
// child, and a child of a shell keeps the pipe open and hangs the reader.
// A plan writes its files in a directory of its own, which the run makes
// when the plan first asks for it and removes when it ends. The editor's
// spawn, delay and directories are injected, so this runs on a fake clock.

import { privateStep, readStep, reason, stepReason } from "./tools.ts";
import type { Dir, Plan, RunResult } from "./tools.ts";

export interface ProcResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** What `spawnHostProcess` returns, as far as the runner uses it. */
export interface Proc {
  result: Promise<ProcResult>;
  kill(): Promise<boolean>;
}

/** A directory of the run's own: the editor's `scratchCreate`, under its
 *  config dir, not the shared temp dir (INV §8 P31). `discard` removes it
 *  in the editor, so workspace trust cannot refuse it; false when it could
 *  not. */
export interface Scratch {
  dir: string;
  discard(): boolean;
}

export interface RunnerDeps {
  spawn(program: string, args: string[]): Proc;
  delay(ms: number): Promise<void>;
  log(msg: string): void;
  /** A new directory for one run, or null when none can be made. */
  scratch(): Scratch | null;
  /** The active window, whose trust a spawn is checked against (INV §7).
   *  A refusal carries the one active at its spawn, not at its answer. */
  active?(): number;
}

/** Fired when the view a run is for has ended (R8, R11): the tab closed,
 *  showed its bytes, or started over. `fired` resolves once, on `fire`. */
export interface Stop {
  readonly fired: Promise<void>;
  fire(): void;
}

export function stopper(): Stop {
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire: () => fire() };
}

/** A tool gets 10 s (R11, spec Decisions). */
export const DEADLINE_MS = 10_000;
/** How long the directory's removal waits for a killed step to exit (P21: 110–130 ms). */
export const KILL_SETTLE_MS = 1_000;

export const NO_DIR = "cannot create a temporary directory";

const failed = (why: string, unanswered = false, refused = false): RunResult => ({ ok: false, reason: why, unanswered, refused });

/** A step that came back `exit_code -1` without a kill. The editor gives -1
 *  with a reason for a spawn it refused or could not start (INV §8 P27),
 *  and with whatever the tool wrote when a signal ended it, so empty stderr
 *  is a signal (a crash, the OOM killer). Anything with a reason is taken
 *  for a refusal, by the trust of `window`, active when it was spawned. */
function noExit(program: string, stderr: string, window: number | undefined): RunResult {
  if (stderr.trim() === "") return failed(`${program} was killed by a signal`, true);
  return { ...failed(reason(stderr), true, true), ...(window === undefined ? {} : { window }) };
}

export class Runner {
  private readonly deps: RunnerDeps;
  /** Staging directories made private in this load. A spawn costs 30–150
   *  ms in Fresh, so not one a run: every run's directory is inside the
   *  staging directory, and that one being private covers them all (INV §8
   *  P31). */
  private readonly closed = new Set<string>();

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  /** Removes a run's directory, whatever the tab's epoch (R11). The host
   *  forgets the directory before removing it, so one it fails to remove
   *  stays until its 24 h sweep: say which (INV §8 P31). */
  private discard(scratch: Scratch): void {
    try {
      if (!scratch.discard()) this.deps.log(`could not remove ${scratch.dir}`);
    } catch (e) {
      this.deps.log(`removing ${scratch.dir} threw: ${String(e)}`);
    }
  }

  /** Kills `handle` without waiting for it, and gives what the directory's
   *  removal waits for: the step's exit, or `KILL_SETTLE_MS` (INV §8 P21). */
  private kill(handle: Proc): Promise<void> {
    handle.kill().then(undefined, (e: unknown) => this.deps.log(`kill threw: ${String(e)}`));
    const exited = handle.result.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([exited, this.deps.delay(KILL_SETTLE_MS)]);
  }

  /** Runs the plan `build` gives, its steps in order, each raced against one
   *  deadline promise for the plan (R11) and against `stop` (R8): either
   *  kills the step without awaiting it, and the failure comes back at once.
   *  With `final`, a read step then base64-encodes it; it is never killed.
   *  `build`'s `dir` makes the run's directory on its first call. Before any
   *  tool writes there, the directory holding it is made private, once a
   *  load; until that has worked, every run tries it. However the run ends,
   *  the run's directory is removed, after a killed step has exited or
   *  `KILL_SETTLE_MS` (R11, INV §8 P21, P31). */
  async run(build: (dir: Dir) => Plan, alive: () => boolean, stop?: Promise<void>): Promise<RunResult> {
    let scratch: Scratch | null | undefined;
    const dir: Dir = () => {
      if (scratch === undefined) scratch = this.deps.scratch();
      return scratch?.dir ?? "";
    };
    let afterKill: Promise<void> | null = null;
    try {
      const plan = build(dir);
      if (scratch === null) return failed(NO_DIR);
      const parent = scratch === undefined ? null : scratch.dir.slice(0, scratch.dir.lastIndexOf("/"));
      const close = parent === null || this.closed.has(parent) ? null : privateStep(parent);
      const steps = close === null ? plan.steps : [close, ...plan.steps];
      const deadline = this.deps.delay(DEADLINE_MS).then(() => "timeout" as const);
      const stopped = stop?.then(() => "stopped" as const);
      let last: ProcResult | null = null;
      for (const step of steps) {
        if (!alive()) return failed("stale");
        const at = this.deps.active?.();
        const handle = this.deps.spawn(step.program, step.args);
        const r = await Promise.race(stopped === undefined ? [handle.result, deadline] : [handle.result, deadline, stopped]);
        if (r === "timeout" || r === "stopped") {
          afterKill = this.kill(handle);
          return r === "stopped" ? failed("stale") : failed(`${step.program} timed out after ${DEADLINE_MS / 1000} s`, true);
        }
        if (r.exit_code === -1) return noExit(step.program, r.stderr, at);
        if (r.exit_code !== 0) return failed(stepReason(step, r.stderr, `${step.program} exited with ${r.exit_code}`));
        if (step === close && parent !== null) this.closed.add(parent);
        last = r;
      }
      if (plan.final === null) return { ok: true, stdout: last?.stdout ?? "", stderr: last?.stderr ?? "" };
      if (!alive()) return failed("stale");
      const at = this.deps.active?.();
      const read = readStep(plan.final);
      const r = await this.deps.spawn(read.program, read.args).result;
      // A refused spawn ran nothing (INV §7).
      if (r.exit_code === -1) return noExit("the read step", r.stderr, at);
      if (r.exit_code !== 0) return failed(reason(r.stderr, "could not read the tool's output"));
      return { ok: true, stdout: r.stdout, stderr: r.stderr };
    } finally {
      const made = scratch;
      if (made) {
        if (afterKill === null) this.discard(made);
        else afterKill.then(() => this.discard(made), (e: unknown) => this.deps.log(`removal wait threw: ${String(e)}`));
      }
    }
  }
}
