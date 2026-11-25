import { test } from "node:test";
import assert from "node:assert/strict";
import {
  centreLine,
  diffLayout,
  facingLine,
  GREEN,
  headerEntries,
  headerPanel,
  lineTotal,
  onePaneHunks,
  paint,
  paneSides,
  RED,
  stepHunk,
  viewHunks,
} from "../lib/diff_view.ts";
import { compareTexts } from "./fake_editor.ts";

/** What the host answers for two texts, as the fake computes it. */
const cmp = compareTexts;

test("the fake's compareBuffers gives what Fresh 0.5.9 gave live (INV §8 P42 b, i)", () => {
  const brief = (a: string, b: string) =>
    compareTexts(a, b).hunks.map((h) => ({
      l: [h.left.start, h.left.count, h.left.from, h.left.to, h.left.jump, h.left.lines, h.left.spans],
      r: [h.right.start, h.right.count, h.right.from, h.right.to, h.right.jump, h.right.lines, h.right.spans],
      eol: h.eolOnly,
    }));
  assert.deepEqual(brief("a\n", "a\n\n"), [{ l: [1, 0, 2, 2, 0, [], []], r: [1, 1, 2, 3, 2, [[2, 2]], []], eol: false }]);
  assert.deepEqual(brief("a\nb\n", "a\nb\nc\n"), [{ l: [2, 0, 4, 4, 2, [], []], r: [2, 1, 4, 6, 4, [[4, 5]], []], eol: false }]);
  assert.deepEqual(brief("a", "a\n"), [{ l: [0, 1, 0, 1, 0, [[0, 1]], [null]], r: [0, 1, 0, 2, 0, [[0, 1]], [null]], eol: true }]);
  assert.deepEqual(brief("", "one\ntwo\nthree\nfour\nfive\n").map((h) => [h.l.slice(0, 5), h.r.slice(0, 5)]), [
    [
      [0, 0, 0, 0, 0],
      [0, 5, 0, 24, 0],
    ],
  ]);
  assert.deepEqual(compareTexts("s\n", "s\n").hunks, []);
  const r = compareTexts("a\n", "a\n\n");
  assert.deepEqual([r.leftLines, r.rightLines, r.leftLen, r.rightLen], [1, 2, 2, 3]);
});

test("paneSides: one pane when a side is zero bytes, the right one when both are; else two (R38 One side, INV §8 P42 b)", () => {
  assert.equal(paneSides(0, 5), "right", "added or untracked");
  assert.equal(paneSides(5, 0), "left", "deleted, or a file emptied");
  assert.equal(paneSides(0, 0), "right", "both empty");
  assert.equal(paneSides(1, 1), "both");
  // A file that is one newline is not empty: it has a line.
  assert.equal(paneSides(1, 0), "left");
  assert.equal(lineTotal(""), 0);
  assert.equal(lineTotal("\n"), 1);
  assert.equal(lineTotal("a\nb\n"), 2, "split_inclusive: a final newline ends the last line (H17)");
  assert.equal(lineTotal("a\nb"), 2);
});

test("diffLayout: two panes each under a header, or one; headers name the side (R38, INV §8 P42 a, l)", () => {
  assert.deepEqual(JSON.parse(diffLayout(3, 4)), {
    type: "split",
    direction: "h",
    ratio: 0.5,
    first: { type: "split", direction: "v", ratio: 0.05, first: { type: "fixed", id: "leftHeader", height: 1 }, second: { type: "scrollable", id: "left", bufferId: 3 } },
    second: { type: "split", direction: "v", ratio: 0.05, first: { type: "fixed", id: "rightHeader", height: 1 }, second: { type: "scrollable", id: "right", bufferId: 4 } },
  });
  assert.deepEqual(JSON.parse(diffLayout(null, 4)), {
    type: "split",
    direction: "v",
    ratio: 0.05,
    first: { type: "fixed", id: "header", height: 1 },
    second: { type: "scrollable", id: "right", bufferId: 4 },
  });
  assert.equal(JSON.parse(diffLayout(3, null)).second.id, "left");
  assert.throws(() => diffLayout(null, null));
  assert.equal(headerPanel("left", "both"), "leftHeader");
  assert.equal(headerPanel("right", "both"), "rightHeader");
  assert.equal(headerPanel("right", "right"), "header");
  assert.deepEqual(headerEntries("Working tree"), [{ text: " Working tree" }]);
});

test("paint: a modified line is tinted, its changed part highlighted, marked - and + and on both scrollbars (R38, R39)", () => {
  const p = paint(cmp("a\nb\nc\n", "a\nB\nc\n"));
  assert.deepEqual(p.left, {
    lines: [[2, 3]],
    lineBg: "editor.diff_remove_bg",
    spans: [[2, 3]],
    spanBg: "editor.diff_remove_highlight_bg",
    fillers: [],
    fillerBg: "editor.diff_add_bg",
    gutter: [1],
    gutterSymbol: "-",
    gutterColor: RED,
    markers: [{ position: 2, end: 3, color: RED }],
  });
  assert.deepEqual(p.right.lines, [[2, 3]]);
  assert.equal(p.right.lineBg, "editor.diff_add_bg");
  assert.equal(p.right.spanBg, "editor.diff_add_highlight_bg");
  assert.equal(p.right.fillerBg, "editor.diff_remove_bg");
  assert.deepEqual([p.right.gutter, p.right.gutterSymbol, p.right.gutterColor], [[1], "+", GREEN]);
  assert.deepEqual(p.right.markers, [{ position: 2, end: 3, color: GREEN }]);
  assert.deepEqual(p.anchors, [[2, 2]]);
});

test("paint: lines added mid-file face blank rows under the line before the gap, with a green seam mark on the left (R38, R39)", () => {
  const p = paint(cmp("a\nb\n", "a\nx\nb\n"));
  assert.deepEqual(p.left.fillers, [{ anchor: 0, above: false, count: 1 }]);
  assert.deepEqual(p.left.lines, []);
  assert.deepEqual(p.left.gutter, []);
  assert.deepEqual(p.left.markers, [{ position: 2, color: GREEN }], "one cell, in the colour of the side with the lines");
  assert.deepEqual(p.right.lines, [[2, 3]]);
  assert.deepEqual(p.right.spans, [], "an added line has no counterpart to differ from");
  assert.deepEqual(p.right.markers, [{ position: 2, end: 3, color: GREEN }]);
  assert.deepEqual(p.right.fillers, []);
  assert.deepEqual(p.anchors, [[1, 2]]);
});

test("paint: a deleted line faces a blank row on the right, with a red seam mark there (R38, R39)", () => {
  const p = paint(cmp("a\nb\nc\n", "a\nc\n"));
  assert.deepEqual(p.right.fillers, [{ anchor: 0, above: false, count: 1 }]);
  assert.deepEqual(p.right.markers, [{ position: 2, color: RED }]);
  assert.deepEqual(p.left.markers, [{ position: 2, end: 3, color: RED }]);
  assert.deepEqual(p.left.gutter, [1]);
  assert.deepEqual(p.anchors, [[2, 1]]);
});

test("paint: lines added at the top face blank rows above byte 0 (R38)", () => {
  const p = paint(cmp("b\nc\n", "a1\na2\nb\nc\n"));
  assert.deepEqual(p.left.fillers, [{ anchor: 0, above: true, count: 2 }]);
  assert.deepEqual(p.left.markers, [{ position: 0, color: GREEN }]);
  assert.deepEqual(p.right.lines, [
    [0, 2],
    [3, 5],
  ]);
  assert.deepEqual(p.right.markers, [{ position: 0, end: 5, color: GREEN }], "a streak over both lines");
  assert.deepEqual(p.anchors, [[0, 2]]);
});

test("paint: an empty changed line still gets a byte; a final-newline change tints without a span (R14 final newline, INV §8 P42 i)", () => {
  // "a\n" → "a\n\n": the added line is empty.
  let p = paint(cmp("a\n", "a\n\n"));
  assert.deepEqual(p.right.lines, [[2, 3]]);
  assert.deepEqual(p.right.gutter, [1]);
  assert.deepEqual(p.right.markers, [{ position: 2, color: GREEN }], "one byte: a one-cell mark");
  assert.deepEqual(p.left.fillers, [{ anchor: 0, above: false, count: 1 }]);
  // "a" → "a\n": an eolOnly hunk.
  p = paint(cmp("a", "a\n"));
  assert.deepEqual(p.left.lines, [[0, 1]]);
  assert.deepEqual(p.right.lines, [[0, 1]]);
  assert.deepEqual([p.left.spans, p.right.spans], [[], []]);
  assert.deepEqual(p.left.markers, [{ position: 0, color: RED }]);
  assert.deepEqual(p.right.markers, [{ position: 0, end: 1, color: GREEN }]);
});

test("paint: equal texts draw nothing; several hunks each get their marks and an anchor (R38, R39, A39)", () => {
  const same = paint(cmp("x\n", "x\n"));
  assert.deepEqual([same.left.lines, same.left.markers, same.right.markers, same.anchors], [[], [], [], []]);
  const L = "1\n2\n3\n4\n5\n6\n7\n";
  const R = "1\nX\n3\n4\n5\n7\n8\n";
  const p = paint(cmp(L, R));
  assert.deepEqual(p.left.markers, [
    { position: 2, end: 3, color: RED },
    { position: 10, end: 11, color: RED },
    { position: 13, color: GREEN },
  ]);
  assert.deepEqual(p.right.markers, [
    { position: 2, end: 3, color: GREEN },
    { position: 10, color: RED },
    { position: 12, end: 13, color: GREEN },
  ]);
  assert.deepEqual(p.left.gutter, [1, 5]);
  assert.deepEqual(p.right.gutter, [1, 6]);
  assert.deepEqual(p.right.fillers, [{ anchor: 8, above: false, count: 1 }]);
  assert.deepEqual(p.left.fillers, [{ anchor: 12, above: false, count: 1 }]);
  assert.deepEqual(p.anchors, [
    [2, 2],
    [6, 5],
    [7, 7],
  ]);
});

test("stepHunk: the next or previous change by the cursor's byte, null at either end; centreLine (R20, R29)", () => {
  const hunks = viewHunks(cmp("1\n2\n3\n4\n5\n6\n7\n", "1\nX\n3\n4\n5\n7\n8\n"));
  assert.deepEqual(
    hunks.map((h) => [h.left.jump, h.right.jump]),
    [
      [2, 2],
      [10, 8],
      [12, 12],
    ],
  );
  assert.equal(stepHunk(hunks, "left", 0, 1), 0);
  assert.equal(stepHunk(hunks, "left", 2, 1), 1, "on a change: the next one");
  assert.equal(stepHunk(hunks, "left", 12, 1), null, "no wrap-around");
  assert.equal(stepHunk(hunks, "left", 12, -1), 1);
  assert.equal(stepHunk(hunks, "left", 2, -1), null);
  assert.equal(stepHunk(hunks, "left", 5, -1), 0, "inside or past a change: back to its start");
  assert.equal(stepHunk(hunks, "right", 8, 1), 2);
  assert.equal(stepHunk([], "right", 0, 1), null);
  // Two insertions around one line share the left jump 0: from the hunk
  // the cursors were last put on, the one beside it.
  const tied = viewHunks(cmp("x\n", "a\nx\nb\n"));
  assert.deepEqual(
    tied.map((h) => h.left.jump),
    [0, 0],
  );
  assert.equal(stepHunk(tied, "left", 0, 1, 0), 1, "n: the second insertion, not the end");
  assert.equal(stepHunk(tied, "left", 0, 1, 1), null);
  assert.equal(stepHunk(tied, "left", 0, -1, 1), 0);
  assert.equal(stepHunk(tied, "left", 0, -1, 0), null);
  assert.equal(stepHunk(tied, "right", tied[0].right.jump, 1, 0), 1);
  // The cursor moved off the last hunk's jump: by the byte again.
  assert.equal(stepHunk(hunks, "left", 0, 1, 2), 0);
  assert.equal(centreLine(hunks[0].left), 1);
  assert.equal(centreLine(hunks[1].right), 4, "no lines on this side: the line before the gap");
  assert.equal(centreLine({ start: 0, count: 0, jump: 0 }), 0);
});

test("facingLine: the right pane's own line; the left's by position in a hunk, the next right line past it, else shifted (R19, A19)", () => {
  const hunks = viewHunks(cmp("1\n2\n3\n4\n5\n6\n7\n", "1\nX\n3\n4\n5\n7\n8\n"));
  assert.equal(facingLine(hunks, "right", 4, 7), 4);
  assert.equal(facingLine(hunks, "left", 0, 7), 0);
  assert.equal(facingLine(hunks, "left", 1, 7), 1, "a changed line faces its counterpart");
  assert.equal(facingLine(hunks, "left", 2, 7), 2);
  assert.equal(facingLine(hunks, "left", 5, 7), 5, "a removed line: the next right line");
  assert.equal(facingLine(hunks, "left", 6, 7), 5, "after a removal, one line up");
  assert.equal(facingLine(hunks, "left", 7, 7), null, "past the right side's lines: the last line");
  // More removed than added: lines past the added ones go to the line after the hunk.
  const positional = viewHunks(cmp("a\nb\nc\nd\ne\n", "a\nX\ne\n"));
  assert.equal(facingLine(positional, "left", 1, 3), 1);
  assert.equal(facingLine(positional, "left", 3, 3), 2);
  assert.equal(facingLine(positional, "left", 4, 3), 2);
});

test("a one-pane diff: one hunk over the side, no next change, Enter on the left side faces no line (R38 One side, R19, R20)", () => {
  const added = onePaneHunks("right", 3);
  assert.deepEqual(added, [{ left: { start: 0, count: 0, jump: 0 }, right: { start: 0, count: 3, jump: 0 } }]);
  assert.equal(stepHunk(added, "right", 0, 1), null, "n: no next change");
  assert.equal(stepHunk(added, "right", 7, -1), 0, "p from below: back to the top");
  assert.equal(facingLine(added, "right", 2, 3), 2);
  const deleted = onePaneHunks("left", 2);
  assert.equal(facingLine(deleted, "left", 1, 0), null, "a deleted file: no right line");
  // An emptied file: right empty, the file still there with no lines.
  assert.equal(facingLine(onePaneHunks("left", 4), "left", 3, 0), null);
  assert.deepEqual(onePaneHunks("right", 0), [], "both sides empty: nothing to move to");
});
