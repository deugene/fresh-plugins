import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entry } from "../lib/status.ts";
import {
  compositeHunks,
  contentToEntries,
  contentToText,
  DIFF_HINT,
  DiffSlot,
  lineCount,
  MAX_DIFF_BYTES,
  openLine,
  paneLabels,
  blobRefusal,
  refusal,
  refusalMessage,
  rowRefusal,
  sides,
  sizeRefusal,
  sourceName,
  tabTitle,
  targetLine,
  type Hunk,
  type Side,
  type View,
} from "../lib/diff.ts";
import { entryMap } from "../lib/view.ts";
import { status as fixture } from "./helpers.ts";

const show = (s: Side): string => (s.kind === "empty" ? "∅" : s.kind === "blob" ? s.spec : `wt:${s.path}`);

/** `key: left | right` for every file row of a fixture (INV §9.4 table). */
function table(name: string): string[] {
  const status = fixture(name);
  return [...entryMap(status)].map(([key, { entry, group }]) => {
    const { left, right } = sides(entry, group, status.oid === null);
    return `${key}: ${show(left)} | ${show(right)}`;
  });
}

test("sides follow the INV §9.4 table over the recorded states (R14)", () => {
  assert.deepEqual(table("mm"), [
    "s:added.txt: ∅ | :0:added.txt",
    "s:f.txt: HEAD:f.txt | :0:f.txt",
    "c:f.txt: :0:f.txt | wt:f.txt",
    "c:other.txt: :0:other.txt | wt:other.txt",
  ]);
  assert.deepEqual(table("rename"), ["s:lib/new.ts: HEAD:src/old.ts | :0:lib/new.ts"]);
  assert.deepEqual(table("copy"), ["s:copy.txt: HEAD:orig.txt | :0:copy.txt", "s:orig.txt: HEAD:orig.txt | :0:orig.txt"]);
  // Conflicts: HEAD against the working tree; DU has no "ours" version.
  assert.deepEqual(table("conflict"), ["c:aa.txt: HEAD:aa.txt | wt:aa.txt", "c:du.txt: ∅ | wt:du.txt", "c:uu.txt: HEAD:uu.txt | wt:uu.txt"]);
  assert.deepEqual(table("intent-to-add"), ["c:n.txt: ∅ | wt:n.txt"]);
  // rm --cached: a staged deletion (right empty), and an untracked file (left empty).
  assert.deepEqual(table("rm-cached"), ["s:f.txt: HEAD:f.txt | ∅", "c:f.txt: ∅ | wt:f.txt"]);
  // Unborn: no HEAD version of anything.
  assert.deepEqual(table("unborn"), ["s:a.txt: ∅ | :0:a.txt", "c:b.txt: ∅ | wt:b.txt"]);
  assert.deepEqual(table("acceptance"), [
    "s:a.ts: HEAD:a.ts | :0:a.ts",
    "s:moved.ts: HEAD:old.ts | :0:moved.ts",
    "c:a.ts: :0:a.ts | wt:a.ts",
    "c:b.md: :0:b.md | wt:b.md",
    "c:gone.ts: :0:gone.ts | wt:gone.ts",
    "c:new/c.txt: ∅ | wt:new/c.txt",
    "c:new/d.txt: ∅ | wt:new/d.txt",
  ]);
});

test("the index side is always stage 0: a path like `1:x` is not read as a stage", () => {
  const e: Entry = { path: "1:x", marker: "M" };
  assert.deepEqual(sides(e, "changes", false).left, { kind: "blob", spec: ":0:1:x" });
  assert.deepEqual(sides(e, "staged", false).right, { kind: "blob", spec: ":0:1:x" });
  assert.deepEqual(sides(e, "staged", false).left, { kind: "blob", spec: "HEAD:1:x" });
});

test("all seven conflict codes: HEAD on the left unless ours lacks the path (DD, DU, UA)", () => {
  const left = (conflict: string, unborn = false) => show(sides({ path: "p", marker: "!", conflict }, "changes", unborn).left);
  assert.deepEqual(
    ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].map((c) => `${c} ${left(c)}`),
    ["DD ∅", "AU HEAD:p", "UD HEAD:p", "UA ∅", "DU ∅", "AA HEAD:p", "UU HEAD:p"],
  );
  assert.equal(left("UU", true), "∅", "no HEAD on an unborn branch");
  for (const c of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    assert.deepEqual(sides({ path: "p", marker: "!", conflict: c }, "changes", false).right, { kind: "worktree", path: "p" });
  }
});

test("other markers: type change and deletions", () => {
  assert.deepEqual(sides({ path: "t", marker: "T" }, "changes", false).left, { kind: "blob", spec: ":0:t" });
  assert.deepEqual(sides({ path: "t", marker: "T" }, "staged", false), {
    left: { kind: "blob", spec: "HEAD:t" },
    right: { kind: "blob", spec: ":0:t" },
  });
  // An unstaged deletion: the working-tree side is read as empty when the file is gone.
  assert.deepEqual(sides({ path: "d", marker: "D" }, "changes", false).right, { kind: "worktree", path: "d" });
  // A Changes rename onto an intent-to-add path: nothing staged for the path.
  assert.deepEqual(sides({ path: "n", marker: "R", orig: "o" }, "changes", false).left, { kind: "empty" });
});

test("refusals: a NUL byte or unreadable text is binary; more than 5 MiB is too large (R14)", () => {
  assert.equal(refusal("plain\ntext\n"), null);
  assert.equal(refusal("a\0b"), "binary");
  assert.equal(refusal(null), "binary");
  // The size is judged before the read, from `fileStat` or `cat-file -s`: the content need not be read.
  assert.equal(sizeRefusal(0), null);
  assert.equal(sizeRefusal(MAX_DIFF_BYTES), null);
  assert.equal(sizeRefusal(MAX_DIFF_BYTES + 1), "too large");
  assert.equal(MAX_DIFF_BYTES, 5 * 1024 * 1024);
});

test("tab titles and pane labels name the comparison (R14)", () => {
  assert.equal(tabTitle("b.md", "changes", { path: "b.md", marker: "M" }), "b.md (staged ↔ working tree)");
  assert.equal(tabTitle("a.ts", "staged", { path: "a.ts", marker: "M" }), "a.ts (HEAD ↔ staged)");
  assert.equal(tabTitle("uu.txt", "changes", { path: "uu.txt", marker: "!", conflict: "UU" }), "uu.txt (HEAD ↔ working tree)");
  assert.deepEqual(paneLabels("changes", { path: "b", marker: "M" }), ["Staged", "Working tree"]);
  assert.deepEqual(paneLabels("staged", { path: "b", marker: "M" }), ["HEAD", "Staged"]);
  assert.deepEqual(paneLabels("changes", { path: "b", marker: "!" }), ["HEAD", "Working tree"]);
});

test("contentToEntries drops one trailing newline, and gives no span for empty text", () => {
  assert.equal(contentToText("a\nb\n"), "a\nb");
  assert.equal(contentToText("a\nb"), "a\nb");
  assert.equal(contentToText(""), "");
  assert.equal(contentToText("\n"), "");
  assert.equal(contentToText("a"), "a");
  assert.equal(contentToText("a\n"), "a");
  assert.equal(contentToText("a\n\n"), "a\n");
  assert.deepEqual(contentToEntries("x\n"), [{ text: "x" }]);
  assert.deepEqual(contentToEntries(""), []);
  assert.deepEqual(contentToEntries("\n"), []);
});

/** A view of buffers `composite`, `left` and `right`, for row `c:a`. */
const view = (composite: number, left: number, right: number): View => ({ composite, left, right, key: "c:a", hunks: [], rightLines: 1 });

test("DiffSlot: a stale build, a joined build, a replace and a user close", () => {
  const slot = new DiffSlot();
  assert.equal(slot.current(), null);
  const a = slot.begin("c:a")!;
  assert.equal(slot.begin("c:a"), null, "the same key joins the pending build");
  const b = slot.begin("c:b")!;
  assert.ok(!slot.isCurrent(a), "a later build makes the earlier stale");
  assert.ok(slot.isCurrent(b));
  slot.done(a);
  assert.equal(slot.begin("c:b"), null, "a stale build ending does not end the current one");
  assert.equal(slot.install(view(1, 2, 3)), null);
  slot.done(b);
  // Done: the same key builds again (a fresh snapshot).
  const c = slot.begin("c:b")!;
  assert.ok(slot.isCurrent(c));
  assert.deepEqual(slot.install(view(4, 5, 6)), view(1, 2, 3));
  assert.deepEqual(slot.current(), view(4, 5, 6), "the view shown now");
  slot.done(c);
  // The replaced view's buffers closing is not the current view's business.
  assert.equal(slot.onClosed(1), null);
  assert.equal(slot.onClosed(2), null);
  // The user closes the tab: drop the composite's state, close the two sources.
  assert.deepEqual(slot.onClosed(4), { composite: 4, rest: [5, 6] });
  assert.equal(slot.current(), null, "closed: no view for Enter to act on");
  assert.equal(slot.onClosed(5), null, "already handled");
  // A source closing takes the rest of the view with it.
  assert.equal(slot.install(view(7, 8, 9)), null, "the closed view is gone: nothing to replace");
  assert.deepEqual(slot.onClosed(9), { composite: 7, rest: [7, 8] });
  // invalidate: every pending build is stale, and the key may start again.
  const d = slot.begin("c:x")!;
  slot.invalidate();
  assert.ok(!slot.isCurrent(d));
  assert.notEqual(slot.begin("c:x"), null);
});

test("a git object's side is binary unless its text is exactly its size in UTF-8 bytes (R14, F5)", () => {
  // Valid multi-byte UTF-8 whose length matches `cat-file -s`.
  assert.equal(blobRefusal("naïve → 😀\n", Buffer.byteLength("naïve → 😀\n")), null);
  assert.equal(blobRefusal("", 0), null);
  // `runOnTarget` decodes lossily: Latin-1 `caf\xe9\n` (5 bytes) comes back with U+FFFD (3 bytes).
  assert.equal(blobRefusal("caf\uFFFD\n", 5), "binary");
  // `spawnHostProcess` gives "" with exit 0 for stdout that is not UTF-8.
  assert.equal(blobRefusal("", 5), "binary");
  // A NUL byte is binary whatever the size.
  assert.equal(blobRefusal("a\0b", 3), "binary");
});

test("a Changes or conflicted row on a symbolic link is refused; a Staged one is not (R14, F7)", () => {
  const s = fixture("symlink");
  const refused = [...entryMap(s)].map(([key, { entry, group }]) => `${key}: ${rowRefusal(entry, group)}`);
  assert.deepEqual(refused, [
    "s:staged-file.txt: null",
    "s:staged-link: null",
    "c:file.txt: symbolic link",
    "c:link: symbolic link",
    // Untracked: `?` records carry no mode, so the link's target is read (README Limits).
    "c:new-link: null",
  ]);
  assert.equal(rowRefusal({ path: "l", marker: "!", conflict: "UU", link: true }, "changes"), "symbolic link");
  assert.equal(refusalMessage("l", "symbolic link"), "l is a symbolic link; no diff shown");
  assert.equal(refusalMessage("b", "binary"), "b is binary; no diff shown");
  assert.equal(refusalMessage("u", "unreadable"), "u is binary or could not be read; no diff shown");
  assert.equal(refusalMessage("t", "too large"), "t is larger than 5 MiB; no diff shown");
});

test("a directory row, or one with a name git can't be passed back, is refused before the link check (R14, F6)", () => {
  // A directory: in either group, and before the link check.
  assert.equal(rowRefusal({ path: "sub", marker: "M", dir: true }, "changes"), "directory");
  assert.equal(rowRefusal({ path: "vendor/lib/", marker: "U", dir: true, link: true }, "changes"), "directory");
  assert.equal(rowRefusal({ path: "sub", marker: "M", dir: true }, "staged"), "directory");
  // A name that is not UTF-8: the path or the original path, for every marker (a copy too).
  const bad = "caf\uFFFD.txt";
  assert.equal(rowRefusal({ path: bad, marker: "M" }, "changes"), "unpassable name");
  assert.equal(rowRefusal({ path: bad, marker: "M", link: true }, "changes"), "unpassable name");
  assert.equal(rowRefusal({ path: "new.txt", marker: "R", orig: bad }, "staged"), "unpassable name");
  assert.equal(rowRefusal({ path: "copy.txt", marker: "C", orig: bad }, "staged"), "unpassable name");
  assert.equal(rowRefusal({ path: "naïve → é.txt", marker: "M" }, "changes"), null);
  assert.equal(rowRefusal({ path: "copy.txt", marker: "C", orig: "orig.txt" }, "staged"), null);
  // The texts are the row actions' (R15).
  assert.equal(refusalMessage("sub", "directory"), "sub is a directory (submodule or nested repository)");
  assert.equal(refusalMessage(bad, "unpassable name"), `${bad}: the name is not valid UTF-8, so git can't be passed it back`);
});

test("compositeHunks: an empty side's phantom line is covered, so no row points at it (INV §8 P22)", () => {
  const plain = [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 }];
  /** The line diff, counting its calls: only needed when both sides have lines. */
  let calls = 0;
  const diff = (hunks: Hunk[]) => () => {
    calls++;
    return hunks;
  };
  // Both sides have lines: the line diff is used as it is.
  assert.deepEqual(compositeHunks("a\nb\n", "a\nc\nd\n", diff(plain)), plain);
  assert.equal(calls, 1);
  calls = 0;
  // Untracked or added: every right line an addition, the left count 1.
  assert.deepEqual(compositeHunks("", "x\ny\n", diff([])), [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 2, ops: "++" }]);
  // A left side that is only a newline is an empty buffer too.
  assert.deepEqual(compositeHunks("\n", "\nz", diff([])), [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 2, ops: "++" }]);
  // Deleted: every left line a deletion, the right count 1.
  assert.deepEqual(compositeHunks("p\nq\nr", "", diff([])), [{ oldStart: 0, oldCount: 3, newStart: 0, newCount: 1, ops: "---" }]);
  // Both empty (an empty new file): one hunk with no rows.
  assert.deepEqual(compositeHunks("", "", diff([])), [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 1, ops: "" }]);
  // No empty-side case asks the host for a line diff.
  assert.equal(calls, 0);
});

test("source names: `*label:path*`, so the name Fresh looks a grammar up by is the file's (R21, INV §8 P26)", () => {
  // As `DetectedLanguage::from_virtual_name`: strip the `*`s, take the text after the last `:`.
  const looked = (name: string) => {
    const inner = name.replace(/^\*/, "").replace(/\*$/, "");
    return inner.slice(inner.lastIndexOf(":") + 1);
  };
  assert.equal(sourceName("Staged", "Makefile"), "*Staged:Makefile*");
  assert.equal(looked(sourceName("Staged", "Makefile")), "Makefile");
  assert.equal(looked(sourceName("Working tree", "src/a.ts")), "src/a.ts");
  assert.equal(looked(sourceName("HEAD", "a.ts")), "a.ts");
  // A path that holds a `:` keeps its last part: the same extension.
  assert.equal(looked(sourceName("Staged", "a:b.ts")), "b.ts");
  // No label holds a `:`, and no space follows it.
  for (const [l, r] of [paneLabels("staged", { path: "x", marker: "M" }), paneLabels("changes", { path: "x", marker: "M" }), paneLabels("changes", { path: "x", marker: "!" })]) {
    for (const label of [l, r]) {
      assert.ok(!label.includes(":"), label);
      assert.ok(!sourceName(label, "x").includes(": "), label);
    }
  }
});

test("targetLine: the right line on the cursor's row, else the next one, else the last (R19, INV §8 P25 c)", () => {
  // `20 lines` with line 3 changed: a present right line, as the host gave `[2,2]`.
  const changed: Hunk[] = [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }];
  assert.equal(targetLine([2, 2], changed, 20), 2);
  // An added line has no left line: `[null,1]`.
  assert.equal(targetLine([null, 1], [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1 }], 2), 1);
  // Paired by position: 3 old lines against 1 new, so the rows at offsets 1
  // and 2 show only a left line, and go to the line after the hunk.
  const positional: Hunk[] = [{ oldStart: 4, oldCount: 3, newStart: 4, newCount: 1 }];
  assert.equal(targetLine([5, null], positional, 10), 5);
  assert.equal(targetLine([6, null], positional, 10), 5);
  // A pure deletion (newCount 0), as the host gave `[9,null]` for line 10 of 20.
  const deleted: Hunk[] = [{ oldStart: 9, oldCount: 1, newStart: 9, newCount: 0 }];
  assert.equal(targetLine([9, null], deleted, 19), 9);
  // A trailing deletion: no right line follows, so the last line (null).
  assert.equal(targetLine([19, null], [{ oldStart: 19, oldCount: 1, newStart: 19, newCount: 0 }], 19), null);
  // An empty right side (a deleted file): its hunk covers the phantom line through `ops`.
  const gone = compositeHunks("a\nb\n", "", () => assert.fail("no line diff for an empty side"));
  assert.equal(targetLine([1, null], gone, lineCount("")), null);
  // Neither pane on the row, or a left line no hunk holds: the last line.
  assert.equal(targetLine([null, null], changed, 20), null);
  assert.equal(targetLine([7, null], changed, 20), null);
});

test("openLine: clamped to the lines the tab shows; empty gives line 1; unknown passes through (R19)", () => {
  assert.equal(openLine(1, 3), 2);
  assert.equal(openLine(9, 3), 3, "past the end: the last line, not the host's line 1");
  assert.equal(openLine(null, 3), 3, "null is the last line");
  assert.equal(openLine(4, 0), 1, "an empty file");
  assert.equal(openLine(null, 0), 1);
  assert.equal(openLine(7, null), 8, "count unknown: unclamped");
  assert.equal(openLine(null, null), null, "count unknown and the last line: no jump");
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\nb\n"), 2, "a final newline adds no line");
  assert.equal(lineCount("a\nb"), 2);
});

test("the diff hint names Fresh's keys and Enter (R20)", () => {
  for (const k of ["n", "]", "p", "[", "Enter", "q", "Esc"]) assert.ok(DIFF_HINT.includes(k), k);
  // The status bar cuts a message after about 70 characters at 140 columns.
  assert.ok(DIFF_HINT.length <= 64, `${DIFF_HINT.length}`);
});
