import { test } from "node:test";
import assert from "node:assert/strict";
import { DEADLINE_MS, NO_DIR, Runner, stopper, type Proc, type ProcResult } from "../lib/runner.ts";
import type { RunResult, Step } from "../lib/tools.ts";

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

const BLOCKED = "workspace trust is set to Blocked — no processes may run";

interface Call {
  program: string;
  args: string[];
  at: number;
  killedAt: number | null;
}

/** A run's directory: when it was made and removed. */
interface Made {
  dir: string;
  at: number;
  discardedAt: number | null;
}

/** A Runner on a manual clock. `script` says what each spawn does: a result
 *  after `ms`, or "hang" until killed; a killed one exits `killMs` later.
 *  `scratch`: no directory can be made, or removing one fails or throws. */
function harness(script: (c: Call) => { ms?: number; result: ProcResult } | "hang", killMs = 0, scratch?: "none" | "false" | "throw") {
  let now = 0;
  let waits: { at: number; fire: () => void }[] = [];
  const later = (ms: number, fire: () => void) => waits.push({ at: now + ms, fire });
  const calls: Call[] = [];
  const logs: string[] = [];
  const made: Made[] = [];
  const runner = new Runner({
    scratch: () => {
      if (scratch === "none") return null;
      const m: Made = { dir: `/s/${made.length}`, at: now, discardedAt: null };
      made.push(m);
      return {
        dir: m.dir,
        discard: () => {
          if (scratch === "throw") throw new Error("boom");
          m.discardedAt = now;
          return scratch !== "false";
        },
      };
    },
    spawn: (program, args): Proc => {
      const call: Call = { program, args, at: now, killedAt: null };
      calls.push(call);
      let resolve!: (r: ProcResult) => void;
      const result = new Promise<ProcResult>((r) => (resolve = r));
      let done = false;
      const end = (r: ProcResult) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      const out = script(call);
      if (out !== "hang") later(out.ms ?? 0, () => end(out.result));
      return {
        result,
        kill: async () => {
          call.killedAt = now;
          later(killMs, () => end({ exit_code: -1, stdout: "", stderr: "" }));
          return true;
        },
      };
    },
    delay: (ms) => new Promise<void>((r) => later(ms, r)),
    log: (m) => logs.push(m),
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await settle();
      const next = waits.filter((w) => w.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      waits = waits.filter((w) => w !== next);
      next.fire();
    }
    now = end;
    await settle();
  };
  /** Runs `steps`; with `final`, then reads `<dir>/out`. `writes`: the
   *  plan asks for its directory. `stop`: the view's (R8). */
  const run = (steps: Step[], final: boolean, alive = () => true, writes = final, stop?: Promise<void>) => {
    let out: RunResult | null = null;
    void runner.run((dir) => ({ steps, final: final ? `${dir()}/out` : writes ? (dir(), null) : null }), alive, stop).then((r) => (out = r));
    return () => out;
  };
  return { runner, calls, logs, made, advance, run, now: () => now };
}

const ok = (stdout = "", stderr = ""): ProcResult => ({ exit_code: 0, stdout, stderr });
const step = (program: string, ...args: string[]): Step => ({ program, args });
const discarded = (made: Made[]) => made.map((m) => m.discardedAt);

test("the staging directory is made private first, then the steps run in order; the read step returns the output, then the run's directory goes (R11, INV §8 P31)", async () => {
  const h = harness((c) => ({ ms: 10, result: c.program === "sh" ? ok("QUJD") : ok() }));
  const out = h.run([step("sips", "1"), step("sips", "2")], true);
  await h.advance(100);
  assert.deepEqual(out(), { ok: true, stdout: "QUJD", stderr: "" });
  assert.deepEqual(
    h.calls.map((c) => [c.program, c.at]),
    [["chmod", 0], ["sips", 10], ["sips", 20], ["sh", 30]],
  );
  assert.deepEqual(h.calls[0].args, ["700", "/s"], "the directory holding the run's, before any tool writes there");
  assert.deepEqual(h.calls[3].args, ["-c", 'base64 < "$1"', "sh", "/s/0/out"], "the read step only reads");
  assert.deepEqual(h.made, [{ dir: "/s/0", at: 0, discardedAt: 40 }]);
});

test("without a read step, the last step's output; a plan that writes nothing gets no directory", async () => {
  const h = harness((c) => (c.args[0] === "bad" ? { result: { exit_code: 1, stdout: "", stderr: "\nboom\nmore" } } : { result: ok("out", "err") }));
  const a = h.run([step("sh", "x")], false);
  await h.advance(10);
  assert.deepEqual(a(), { ok: true, stdout: "out", stderr: "err" });
  assert.equal(h.made.length, 0);
  assert.deepEqual(h.calls.map((c) => c.program), ["sh"], "and no chmod");
  const b = h.run([step("magick", "bad")], true);
  await h.advance(10);
  assert.deepEqual(b(), { ok: false, reason: "boom", unanswered: false, refused: false });
  assert.deepEqual(discarded(h.made), [10], "a failure removes the directory too");
  const c = h.run([step("sips", "1")], false, () => true, true);
  await h.advance(10);
  assert.deepEqual(c(), { ok: true, stdout: "out", stderr: "err" });
  assert.deepEqual(discarded(h.made), [10, 20], "and so does a size probe that wrote a file");
});

test("alive() turning false between steps stops the plan and removes the directory (R11)", async () => {
  let alive = true;
  const h = harness(() => ({ ms: 50, result: ok() }));
  h.run([step("sips", "1"), step("sips", "2")], true, () => alive);
  await h.advance(60);
  alive = false;
  await h.advance(200);
  assert.deepEqual(h.calls.map((c) => c.program), ["chmod", "sips"]);
  assert.deepEqual(discarded(h.made), [100]);
});

test("no directory can be made: the run fails with the reason and spawns nothing (R11)", async () => {
  const h = harness(() => ({ result: ok() }), 0, "none");
  const out = h.run([step("ffmpeg")], true);
  await h.advance(10);
  assert.deepEqual(out(), { ok: false, reason: NO_DIR, unanswered: false, refused: false });
  assert.equal(h.calls.length, 0);
  const plain = h.run([step("sh", "detect")], false);
  await h.advance(10);
  assert.equal(plain()?.ok, true, "a plan that writes nothing does not need one");
});

test("a directory that cannot be removed, or whose removal throws, is logged and the run still ends", async () => {
  for (const mode of ["false", "throw"] as const) {
    const h = harness((c) => ({ result: c.program === "sh" ? ok("QUJD") : ok() }), 0, mode);
    const out = h.run([step("ffmpeg")], true);
    await h.advance(10);
    assert.equal(out()?.ok, true, mode);
    assert.ok(h.logs.some((l) => l.includes("/s/0")), `${mode}: ${h.logs.join(" | ")}`);
  }
});

test("one deadline for the plan: a step is killed 10 s after the plan began, and the failure does not wait (R11)", async () => {
  const h = harness(() => ({ ms: 6_000, result: ok() }), 300);
  const out = h.run([step("sips", "1"), step("sips", "2")], true);
  await h.advance(DEADLINE_MS - 1);
  assert.equal(out(), null);
  await h.advance(1);
  assert.deepEqual(out(), { ok: false, reason: "sips timed out after 10 s", unanswered: true, refused: false });
  assert.deepEqual(h.calls.map((c) => c.killedAt), [null, DEADLINE_MS], "the second step, at 10 s");
  assert.deepEqual(discarded(h.made), [null], "the directory waits for the killed step to exit (P21)");
  await h.advance(300);
  assert.deepEqual(discarded(h.made), [DEADLINE_MS + 300]);
});

test("a killed step that never exits gets its directory removed after 1 s", async () => {
  const h = harness(() => "hang", 60_000);
  h.run([step("ffmpeg")], true);
  await h.advance(DEADLINE_MS + 999);
  assert.deepEqual(discarded(h.made), [null]);
  await h.advance(1);
  assert.deepEqual(discarded(h.made), [DEADLINE_MS + 1_000]);
  await h.advance(60_000);
});

test("a stop kills the running step at once, the run comes back stale, and the directory goes once the step has exited (R8, R11)", async () => {
  const h = harness((c) => ({ ms: c.program === "chmod" ? 0 : 6_000, result: ok() }), 300);
  const stop = stopper();
  const out = h.run([step("sips", "1"), step("sips", "2")], true, () => true, true, stop.fired);
  await h.advance(2_000);
  assert.equal(out(), null);
  stop.fire();
  await h.advance(0);
  assert.deepEqual(out(), { ok: false, reason: "stale", unanswered: false, refused: false });
  assert.deepEqual(
    h.calls.map((c) => [c.program, c.killedAt]),
    [["chmod", null], ["sips", 2_000]],
    "the running step is killed; the next one never starts",
  );
  assert.deepEqual(discarded(h.made), [null], "the directory waits for the killed step to exit (P21)");
  await h.advance(300);
  assert.deepEqual(discarded(h.made), [2_300]);
  await h.advance(DEADLINE_MS);
  assert.deepEqual(
    h.calls.map((c) => c.killedAt),
    [null, 2_000],
    "the deadline kills nothing more",
  );
});

test("a stop fired before the run spawns nothing; a stop during the read step does not kill it (R8, R11)", async () => {
  const early = stopper();
  early.fire();
  const h = harness((c) => ({ ms: 10, result: c.program === "sh" ? ok("QUJD") : ok() }));
  let alive = true;
  void early.fired.then(() => (alive = false));
  await h.advance(0);
  const a = h.run([step("ffmpeg")], true, () => alive, true, early.fired);
  await h.advance(100);
  assert.deepEqual(a(), { ok: false, reason: "stale", unanswered: false, refused: false });
  assert.equal(h.calls.length, 0, "nothing spawned");
  assert.deepEqual(discarded(h.made), [0], "its directory still goes");
  const late = stopper();
  const b = h.run([step("ffmpeg")], true, () => true, true, late.fired);
  await h.advance(25);
  assert.equal(h.calls.at(-1)?.program, "sh", "the read step is running");
  late.fire();
  await h.advance(100);
  assert.equal(h.calls.at(-1)?.killedAt, null, "the read step is never killed");
  assert.deepEqual(b(), { ok: true, stdout: "QUJD", stderr: "" });
});

test("a refused spawn never answered: its reason; a refused read step still has its directory removed (INV §7, R11)", async () => {
  const h = harness(() => ({ result: { exit_code: -1, stdout: "", stderr: BLOCKED } }));
  const a = h.run([step("ffmpeg")], false);
  await h.advance(10);
  assert.deepEqual(a(), { ok: false, reason: BLOCKED, unanswered: true, refused: true });
  const h2 = harness((c) => (c.program === "sh" ? { result: { exit_code: -1, stdout: "", stderr: BLOCKED } } : { result: ok() }));
  const b = h2.run([step("ffmpeg")], true);
  await h2.advance(10);
  assert.deepEqual(b(), { ok: false, reason: BLOCKED, unanswered: true, refused: true });
  assert.deepEqual(discarded(h2.made), [0], "the editor removes it: trust cannot refuse that");
});

test("-1 with nothing on stderr is a signal, not a refusal: the host gives -1 for a signal death too (plugin_dispatch.rs)", async () => {
  const h = harness((c) => (c.program === "magick" || c.program === "sh" ? { result: { exit_code: -1, stdout: "", stderr: "" } } : { result: ok() }));
  const a = h.run([step("magick")], true);
  await h.advance(10);
  assert.deepEqual(a(), { ok: false, reason: "magick was killed by a signal", unanswered: true, refused: false });
  const b = h.run([step("ffmpeg")], true);
  await h.advance(10);
  assert.deepEqual(b(), { ok: false, reason: "the read step was killed by a signal", unanswered: true, refused: false });
  assert.deepEqual(discarded(h.made), [0, 10], "both directories go");
});

test("the staging directory is made private once a load; until that works, every run tries again (INV §8 P31)", async () => {
  let refuse = true;
  const h = harness((c) => (c.program === "chmod" && refuse ? { result: { exit_code: -1, stdout: "", stderr: BLOCKED } } : { result: c.program === "sh" ? ok("QUJD") : ok() }));
  const a = h.run([step("ffmpeg")], true);
  await h.advance(10);
  assert.deepEqual(a(), { ok: false, reason: BLOCKED, unanswered: true, refused: true }, "refused like any step");
  assert.deepEqual(h.calls.map((c) => c.program), ["chmod"], "no tool writes before it");
  refuse = false;
  for (let i = 0; i < 3; i++) {
    const r = h.run([step("ffmpeg")], true);
    await h.advance(10);
    assert.equal(r()?.ok, true);
  }
  assert.deepEqual(h.calls.map((c) => c.program), ["chmod", "chmod", "ffmpeg", "sh", "ffmpeg", "sh", "ffmpeg", "sh"]);
  assert.deepEqual(discarded(h.made).every((t) => t !== null), true);
});
