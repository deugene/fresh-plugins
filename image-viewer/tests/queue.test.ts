import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowQueue } from "../lib/queue.ts";

function harness() {
  let active = 1;
  const ran: string[] = [];
  const errors: unknown[] = [];
  const q = new WindowQueue({ active: () => active, onError: (e) => errors.push(e) });
  const op = (name: string) => () => ran.push(name);
  return { q, ran, errors, op, setActive: (w: number) => (active = w) };
}

test("an operation for the active window runs at once; for another, when that window is active (INV §2)", () => {
  const h = harness();
  h.q.run(1, "a:hdr", h.op("now"));
  h.q.run(2, "a:hdr", h.op("later"));
  assert.deepEqual(h.ran, ["now"]);
  h.setActive(2);
  h.q.drain(2);
  assert.deepEqual(h.ran, ["now", "later"]);
  h.q.drain(2);
  assert.deepEqual(h.ran, ["now", "later"], "drained once");
});

test("one per kind: a later one replaces the earlier, and moves to the end", () => {
  const h = harness();
  h.q.run(2, "a:hdr", h.op("hdr1"));
  h.q.run(2, "a:img", h.op("img"));
  h.q.run(2, "a:hdr", h.op("hdr2"));
  assert.deepEqual(h.q.waiting(2), ["a:img", "a:hdr"]);
  h.setActive(2);
  h.q.drain(2);
  assert.deepEqual(h.ran, ["img", "hdr2"]);
});

test("one that runs at once drops its stale queued twin (INV §2)", () => {
  const h = harness();
  h.q.run(2, "a:hdr", h.op("stale"));
  h.setActive(2);
  h.q.run(2, "a:hdr", h.op("fresh"));
  h.q.drain(2);
  assert.deepEqual(h.ran, ["fresh"]);
});

test("drain runs only while the window is still active; the rest wait (INV §2)", () => {
  const h = harness();
  h.q.run(2, "a:one", () => {
    h.ran.push("one");
    h.setActive(3);
  });
  h.q.run(2, "a:two", h.op("two"));
  h.setActive(2);
  h.q.drain(2);
  assert.deepEqual(h.ran, ["one"]);
  assert.deepEqual(h.q.waiting(2), ["a:two"]);
  h.setActive(1);
  h.q.drain(2);
  assert.deepEqual(h.ran, ["one"], "an event naming window 2 while 1 is active runs nothing");
  h.setActive(2);
  h.q.drain(2);
  assert.deepEqual(h.ran, ["one", "two"]);
});

test("drop forgets one tab's operations, keeping what `keep` names", () => {
  const h = harness();
  for (const k of ["a:hdr", "a:status", "b:hdr", "a:close"]) h.q.run(2, k, h.op(k));
  h.q.drop(2, "a:", (rest) => rest === "status");
  assert.deepEqual(h.q.waiting(2), ["a:status", "b:hdr"]);
  h.q.drop(2, "b:");
  assert.deepEqual(h.q.waiting(2), ["a:status"]);
});

test("drain skips an operation an earlier one dropped, or ran a newer twin of (INV §2)", () => {
  const h = harness();
  h.q.run(2, "create:0", () => {
    h.q.drop(2, "a:");
    h.q.run(2, "b:hdr", h.op("b new"));
  });
  h.q.run(2, "a:status", h.op("a"));
  h.q.run(2, "b:hdr", h.op("b old"));
  h.setActive(2);
  h.q.drain(2);
  assert.deepEqual(h.ran, ["b new"]);
  assert.deepEqual(h.q.waiting(2), []);
});

test("a throwing operation is reported and the rest still run", () => {
  const h = harness();
  h.q.run(2, "a:x", () => {
    throw new Error("boom");
  });
  h.q.run(2, "a:y", h.op("y"));
  h.setActive(2);
  h.q.drain(2);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.ran, ["y"]);
  h.q.run(2, "a:z", () => {
    throw new Error("now");
  });
  assert.equal(h.errors.length, 2, "and at once too");
});

test("forget drops everything queued for a window that closed", () => {
  const h = harness();
  for (const k of ["a:hdr", "create:0"]) h.q.run(2, k, h.op(k));
  h.q.run(3, "b:hdr", h.op("b"));
  h.q.forget(2);
  assert.deepEqual(h.q.waiting(2), []);
  assert.deepEqual(h.q.waiting(3), ["b:hdr"]);
  h.setActive(2);
  h.q.drain(2);
  assert.deepEqual(h.ran, []);
});
