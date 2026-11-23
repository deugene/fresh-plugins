import { test } from "node:test";
import assert from "node:assert/strict";
import { Scheduler, SingleTimer } from "../lib/scheduler.ts";

interface SimResult {
  busy: number;
  elapsed: number;
  maxUrgentLatency: number;
  maxStartGap: number;
  runs: number;
  maxArmed: number;
}

/** Drives the scheduler the way the plugin does — one host timer, re-armed
 *  after every request, tick and finish — on a 1 ms simulated clock. */
function simulate(opts: { durationMs: number; urgentEveryMs: number | null; totalMs: number }): SimResult {
  const sched = new Scheduler();
  const timers = new Map<number, number>(); // id -> fire time
  let nextId = 1;
  let now = 0;
  let maxArmed = 0;
  const timer = new SingleTimer(
    (ms) => {
      const id = nextId++;
      timers.set(id, now + ms);
      maxArmed = Math.max(maxArmed, timers.size);
      return id;
    },
    (id) => {
      timers.delete(id);
    },
  );
  const arm = () => timer.arm(sched.nextDue(), now);

  let runEnd: number | null = null;
  let runStart = 0;
  let busy = 0;
  let runs = 0;
  let lastStart: number | null = null;
  let maxStartGap = 0;
  const waiting: number[] = []; // urgent requests not yet covered by a started run
  let covered: number[] = []; // requests the in-flight run answers
  let maxUrgentLatency = 0;

  sched.requestUrgent(0);
  waiting.push(0);
  arm();
  for (now = 0; now <= opts.totalMs; now++) {
    if (runEnd !== null && now === runEnd) {
      sched.finish(now, now - runStart);
      busy += now - runStart;
      for (const r of covered) maxUrgentLatency = Math.max(maxUrgentLatency, now - r);
      covered = [];
      runEnd = null;
      arm();
    }
    if (opts.urgentEveryMs !== null && now > 0 && now % opts.urgentEveryMs === 0) {
      sched.requestUrgent(now);
      waiting.push(now);
      arm();
    }
    for (const [id, at] of timers) {
      if (at !== now) continue;
      timers.delete(id);
      timer.fired();
      if (sched.tryStart(now)) {
        assert.equal(runEnd, null, "two runs in flight");
        runs++;
        runStart = now;
        runEnd = now + opts.durationMs;
        if (lastStart !== null) maxStartGap = Math.max(maxStartGap, now - lastStart);
        lastStart = now;
        covered = waiting.splice(0);
      }
      arm();
    }
  }
  // A run still in flight at the end counts for the time it has been busy.
  if (runEnd !== null) busy += opts.totalMs - runStart;
  return { busy, elapsed: opts.totalMs, maxUrgentLatency, maxStartGap, runs, maxArmed };
}

const TEN_MINUTES = 600_000;

for (const d of [100, 200, 1000, 5000, 10_000]) {
  test(`urgent requests every 50 ms for 600 s at d=${d} ms: busy <= 25%, one timer, one run at a time`, () => {
    const r = simulate({ durationMs: d, urgentEveryMs: 50, totalMs: TEN_MINUTES });
    assert.ok(r.busy / r.elapsed <= 0.25 + 1e-9, `busy ${(r.busy / r.elapsed).toFixed(4)}`);
    assert.ok(r.maxArmed <= 1, `armed ${r.maxArmed}`);
    assert.ok(r.runs > 0);
  });
}

test("worst urgent latency at d=200 ms is under 2 s (R8)", () => {
  const r = simulate({ durationMs: 200, urgentEveryMs: 50, totalMs: TEN_MINUTES });
  assert.ok(r.maxUrgentLatency <= 2000, `latency ${r.maxUrgentLatency}`);
});

test("background poll gap at d=100 ms is at most 2.3 s (R9)", () => {
  const r = simulate({ durationMs: 100, urgentEveryMs: null, totalMs: 60_000 });
  assert.ok(r.maxStartGap <= 2300, `gap ${r.maxStartGap}`);
  assert.ok(r.maxStartGap >= 2000, `gap ${r.maxStartGap}`);
  assert.ok(r.busy / r.elapsed <= 0.25);
});

test("slow git (1 s and 5 s) keeps polling at 25% or less (A11b)", () => {
  for (const d of [1000, 5000]) {
    const r = simulate({ durationMs: d, urgentEveryMs: null, totalMs: TEN_MINUTES });
    assert.ok(r.busy / r.elapsed <= 0.25 + 1e-9, `d=${d} busy ${(r.busy / r.elapsed).toFixed(4)}`);
  }
});

test("a burst of urgent requests while idle costs one run", () => {
  const s = new Scheduler();
  s.requestUrgent(0);
  assert.ok(s.tryStart(100));
  s.finish(150, 50);
  for (let t = 200; t < 260; t += 10) s.requestUrgent(t);
  // Due at max(first request + 100, lastEnd + 3d) = max(300, 300).
  assert.equal(s.nextDue(), 300);
  assert.ok(!s.tryStart(299));
  assert.ok(s.tryStart(300));
  assert.equal(s.nextDue(), null, "nothing due while in flight");
  s.finish(350, 50);
  // Only the poll remains.
  assert.equal(s.nextDue(), 350 + 2000);
});

test("a request made during a run is answered by the next run, after the gap", () => {
  const s = new Scheduler();
  s.requestUrgent(0);
  assert.ok(s.tryStart(100));
  s.requestUrgent(150);
  s.finish(300, 200);
  assert.equal(s.nextDue(), 300 + 600);
});

test("polling off: only urgent requests run", () => {
  const s = new Scheduler();
  s.setPolling(false);
  s.requestUrgent(0);
  assert.ok(s.tryStart(100));
  s.finish(120, 20);
  assert.equal(s.nextDue(), null);
  s.requestUrgent(500);
  assert.equal(s.nextDue(), 600);
  s.cancel();
  assert.equal(s.nextDue(), null);
});

test("SingleTimer keeps at most one timer and does not re-arm for the same time", () => {
  const live = new Set<number>();
  let n = 0;
  const sets: number[] = [];
  const t = new SingleTimer(
    (ms) => {
      sets.push(ms);
      live.add(++n);
      return n;
    },
    (id) => live.delete(id),
  );
  t.arm(1000, 0);
  t.arm(1000, 10);
  assert.equal(sets.length, 1);
  t.arm(500, 10);
  assert.deepEqual(sets, [1000, 490]);
  assert.equal(live.size, 1);
  t.arm(null, 20);
  assert.equal(live.size, 0);
});

test("a run that spans hours (a laptop sleep) is followed by a gap of at most 60 s", () => {
  const s = new Scheduler();
  s.requestUrgent(0);
  assert.ok(s.tryStart(100));
  const eightHours = 8 * 3600_000;
  const lastEnd = 100 + eightHours;
  s.finish(lastEnd, eightHours);
  const poll = s.nextDue()!;
  assert.ok(poll <= lastEnd + 60_000, `poll due ${poll - lastEnd} ms after the run`);
  s.requestUrgent(lastEnd + 1000);
  const urgent = s.nextDue()!;
  assert.ok(urgent <= lastEnd + 60_000, `urgent due ${urgent - lastEnd} ms after the run`);
  assert.ok(!s.tryStart(urgent - 1));
  assert.ok(s.tryStart(urgent));
});

test("a wall clock stepped back an hour holds no run back", () => {
  const s = new Scheduler();
  s.requestUrgent(0);
  assert.ok(s.tryStart(100));
  const end = 3600_000;
  s.finish(end, 50);
  const back = end - 3600_000 + 2000;
  // The poll's timer fires on time, by the stepped-back clock.
  assert.ok(!s.tryStart(back));
  assert.ok(s.nextDue()! <= back + 2000, `poll due ${s.nextDue()! - back} ms out`);
  // An urgent request is answered at once, not an hour out.
  s.requestUrgent(back);
  assert.ok(s.nextDue()! <= back + 2000, `urgent due ${s.nextDue()! - back} ms out`);
  assert.ok(s.tryStart(s.nextDue()!));
});
