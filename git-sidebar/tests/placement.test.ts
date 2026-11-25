import { test } from "node:test";
import assert from "node:assert/strict";
import { isFile, splitCandidates } from "../lib/placement.ts";

test("splitCandidates: the replaced tab's split, the last used one, the first file pane, top-left; each once (R37)", () => {
  const panes = [
    { splitId: 0, kind: "virtual" },
    { splitId: 4, kind: "file" },
    { splitId: 6, kind: "terminal" },
  ];
  assert.deepEqual(splitCandidates({ replacing: 9, last: 4, panes }), [9, 4, 0]);
  assert.deepEqual(splitCandidates({ replacing: null, last: 7, panes }), [7, 4, 0]);
  assert.deepEqual(splitCandidates({ replacing: null, last: null, panes }), [4, 0]);
  // No file anywhere (the only editor split shows a diff, H3): top-left.
  assert.deepEqual(splitCandidates({ replacing: null, last: null, panes: [{ splitId: 6, kind: "terminal" }] }), [6]);
  assert.deepEqual(splitCandidates({ replacing: 4, last: 4, panes: [] }), [4]);
  assert.deepEqual(splitCandidates({ replacing: null, last: null, panes: [] }), []);
});

test("isFile: only a buffer that is not virtual; a terminal has a path but is virtual (H12)", () => {
  assert.equal(isFile({ is_virtual: false }), true);
  assert.equal(isFile({ is_virtual: true }), false, "a terminal or a plugin buffer");
  assert.equal(isFile(null), false, "closed");
});
