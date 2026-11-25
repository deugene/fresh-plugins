import { test } from "node:test";
import assert from "node:assert/strict";
import { SingleFlight } from "../lib/render.ts";
import { cells, compose, fitCanvas, type Canvas } from "../lib/paint.ts";
import { fitView, layout, type Area } from "../lib/view.ts";

/** A manual clock: `delay` resolves when `advance` passes its time. */
class Clock {
  now = 0;
  private waits: { at: number; fire: () => void }[] = [];
  delay(ms: number): Promise<void> {
    return new Promise((r) => this.waits.push({ at: this.now + ms, fire: r }));
  }
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await settle();
      const next = this.waits.filter((w) => w.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      this.waits = this.waits.filter((w) => w !== next);
      next.fire();
    }
    this.now = end;
    await settle();
  }
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A flight whose run takes `ms` and renders the view number current when it starts. */
function harness(ms = 250) {
  const clock = new Clock();
  let view = 0;
  let epoch = 0;
  const applied: { view: number; at: number }[] = [];
  const started: number[] = [];
  const flight = new SingleFlight<number>({
    run: async () => {
      const v = view;
      started.push(v);
      await clock.delay(ms);
      return v;
    },
    apply: (v) => applied.push({ view: v, at: clock.now }),
    alive: () => epoch === 0,
    onError: (e) => assert.fail(String(e)),
  });
  const press = () => {
    view++;
    flight.request();
  };
  return { clock, flight, press, applied, started, bump: () => epoch++ };
}

test("five presses within 100 ms end on the last view, two runs later (R9, A12)", async () => {
  const h = harness();
  for (let i = 0; i < 5; i++) {
    h.press();
    await h.clock.advance(20);
  }
  await h.clock.advance(1000);
  assert.deepEqual(h.started, [1, 5]);
  assert.deepEqual(h.applied.map((a) => a.view), [1, 5]);
  assert.ok(h.applied.at(-1)!.at <= 100 + 2 * 250, "ends within two views of the last press");
  assert.equal(h.flight.busy, false);
});

test("a held key (a press every 30 ms) paints every superseded result: painting is never starved (R9)", async () => {
  const h = harness();
  for (let t = 0; t < 1500; t += 30) {
    h.press();
    await h.clock.advance(30);
  }
  const during = h.applied.filter((a) => a.at <= 1500);
  assert.ok(during.length >= 5, `painted ${during.length} times while the key was held`);
  for (let i = 1; i < during.length; i++) assert.ok(during[i].at - during[i - 1].at <= 250);
  await h.clock.advance(1000);
  assert.equal(h.applied.at(-1)!.view, 50, "and ends on the last view");
});

test("an epoch change ends the loop, and its result is not applied", async () => {
  const h = harness();
  h.press();
  h.press();
  await h.clock.advance(100);
  h.bump();
  await h.clock.advance(1000);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.started, [1]);
  h.press();
  await h.clock.advance(1000);
  assert.deepEqual(h.started, [1], "no new run once the tab's epoch is gone");
});

test("a superseded result is clipped to the area at the moment it lands (R6, INV §9.6)", async () => {
  const clock = new Clock();
  let area: Area = { cols: 40, rows: 10 };
  const src = { w: 40, h: 20 };
  const img = { w: 40, h: 20, rgba: new Uint8Array(40 * 20 * 4).fill(200) };
  const painted: number[][] = [];
  const flight = new SingleFlight<Canvas>({
    run: async () => {
      const l = layout(src, area, fitView(src));
      await clock.delay(250);
      return compose(img, l, [0, 0, 0]);
    },
    apply: (c) => {
      const e = cells(fitCanvas(c, area));
      painted.push([e.length, Array.from(e[0].text.replace(/\n$/, "")).length]);
    },
    alive: () => true,
    onError: (e) => assert.fail(String(e)),
  });
  flight.request();
  await clock.advance(100);
  area = { cols: 30, rows: 6 };
  flight.request();
  await clock.advance(1000);
  assert.deepEqual(painted, [[6, 30], [6, 30]]);
});

test("a request made as the loop ends, before its promise settles, starts a new run", async () => {
  let runs = 0;
  let release!: () => void;
  const flight = new SingleFlight<number>({
    run: async () => {
      runs++;
      if (runs === 1) await new Promise<void>((r) => (release = r));
      return runs;
    },
    // A request from a microtask queued by the last apply: it runs after the
    // loop has returned, before anything chained on the loop's promise.
    apply: (v) => {
      if (v === 1) void Promise.resolve().then(() => flight.request());
    },
    alive: () => true,
    onError: (e) => assert.fail(String(e)),
  });
  flight.request();
  release();
  await settle();
  assert.equal(runs, 2);
  assert.equal(flight.busy, false);
});

test("a run that throws stops the loop and reports, with no unhandled rejection", async () => {
  const errors: unknown[] = [];
  const flight = new SingleFlight<number>({ run: async () => Promise.reject(new Error("boom")), apply: () => undefined, alive: () => true, onError: (e) => errors.push(e) });
  flight.request();
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(flight.busy, false);
});
