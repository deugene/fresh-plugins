import { test } from "node:test";
import assert from "node:assert/strict";
import { fnv1a, panelIdFor, windowKey } from "../lib/windows.ts";

test("a workspace's key is its stable id, or its folder for a legacy workspace (R28, INV §11.2)", () => {
  assert.equal(windowKey("ws-18eb070c450a98d8-0", "/repo"), "ws-18eb070c450a98d8-0");
  assert.equal(windowKey("", "/repo"), "root:/repo");
});

test("fnv1a is the 32-bit FNV-1a, unsigned", () => {
  // Reference values of 32-bit FNV-1a.
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("foobar"), 0xbf9cf968);
});

test("panel ids are stable integers that skip the toolbar, the legacy id and the menu (R28, INV §11.1)", () => {
  const keys = ["ws-18eb070c450a98d8-0", "ws-18eb070f67c3dda0-1", "root:/repo", "", "x".repeat(4096)];
  for (const key of keys) {
    const id = panelIdFor(key, new Set());
    assert.ok(Number.isInteger(id), `${id} is an integer`);
    // Above 0 (the toolbar), 1 (LEGACY_PANEL) and 2 (the menu).
    assert.ok(id >= 3 && id < 2 ** 32, `${id} in range`);
  }
  // The same on every launch: the ids the live probe used (INV §8 P31).
  assert.equal(panelIdFor("ws-18eb070c450a98d8-0", new Set()), 1164453195);
  assert.equal(panelIdFor("ws-18eb070f67c3dda0-1", new Set()), 1903869748);
});

test("a hash collision steps to the next free id (R28)", () => {
  const id = panelIdFor("ws-a", new Set());
  assert.equal(panelIdFor("ws-a", new Set([id])), id + 1);
  assert.equal(panelIdFor("ws-a", new Set([id, id + 1])), id + 2);
  // Ids other sections hold elsewhere change nothing.
  assert.equal(panelIdFor("ws-a", new Set([id - 1, id + 1])), id);
});
