import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, title, type Entry } from "../lib/status.ts";
import { fixture, mod, raw, untracked, H } from "./helpers.ts";

/** `path marker [← orig]` per row, the shape the assertions read best in. */
const rows = (entries: Entry[]): string[] =>
  entries.map((e) => `${e.path} ${e.marker}${e.orig !== undefined ? ` ← ${e.orig}` : ""}`);

function parsed(name: string) {
  const s = parseStatus(fixture(name));
  return { s, staged: rows(s.staged), changes: rows(s.changes), title: title(s) };
}

test("acceptance fixture gives the spec's A4 rows and A2 title", () => {
  const r = parsed("acceptance");
  assert.deepEqual(r.staged, ["a.ts M", "moved.ts R ← old.ts"]);
  assert.deepEqual(r.changes, ["a.ts M", "b.md M", "gone.ts D", "new/c.txt U", "new/d.txt U"]);
  assert.equal(r.title, "Git · main ↑1 ↓0");
  assert.ok(![...r.staged, ...r.changes].some((x) => x.startsWith("build/")));
});

test("staged and modified (MM) lands in both groups", () => {
  const r = parsed("mm");
  assert.deepEqual(r.staged, ["added.txt A", "f.txt M"]);
  assert.deepEqual(r.changes, ["f.txt M", "other.txt M"]);
});

test("rename keeps the original path and consumes its NUL field", () => {
  const r = parsed("rename");
  assert.deepEqual(r.staged, ["lib/new.ts R ← src/old.ts"]);
  assert.deepEqual(r.changes, []);
});

test("copy shows C with the source path", () => {
  const r = parsed("copy");
  assert.deepEqual(r.staged, ["copy.txt C ← orig.txt", "orig.txt M"]);
  assert.deepEqual(r.changes, []);
});

test("conflicts (UU, AA, DU) go to Changes as !", () => {
  const r = parsed("conflict");
  assert.deepEqual(r.staged, []);
  assert.deepEqual(r.changes, ["aa.txt !", "du.txt !", "uu.txt !"]);
});

test("conflicted entries carry their two-letter state (A4; for R14 and R16)", () => {
  const { s } = parsed("conflict");
  // Wrong field offsets in a `u` record would misread the path or the XY.
  assert.deepEqual(
    s.changes.map((e) => [e.path, e.conflict]),
    [["aa.txt", "AA"], ["du.txt", "DU"], ["uu.txt", "UU"]],
  );
  // Ordinary entries carry no conflict field.
  assert.ok(parsed("acceptance").s.changes.every((e) => !("conflict" in e)));
});

test("a merge in progress: the UU path under Changes as !, the staged file under Staged", () => {
  const r = parsed("merge");
  assert.deepEqual(r.staged, ["s.txt M"]);
  assert.deepEqual(r.changes, ["uu.txt !"]);
  assert.equal(r.s.changes[0].conflict, "UU");
});

test("rm --cached gives D in Staged and U in Changes", () => {
  const r = parsed("rm-cached");
  assert.deepEqual(r.staged, ["f.txt D"]);
  assert.deepEqual(r.changes, ["f.txt U"]);
});

test("intent-to-add (.A) shows A in Changes only", () => {
  const r = parsed("intent-to-add");
  assert.deepEqual(r.staged, []);
  assert.deepEqual(r.changes, ["n.txt A"]);
});

test("unborn branch: title is the branch name", () => {
  const r = parsed("unborn");
  assert.equal(r.s.oid, null);
  assert.equal(r.title, "Git · main");
  assert.deepEqual(r.staged, ["a.txt A"]);
  assert.deepEqual(r.changes, ["b.txt U"]);
});

test("detached HEAD: title is the short commit id", () => {
  const r = parsed("detached");
  assert.equal(r.s.branch, null);
  assert.match(r.title, /^Git · [0-9a-f]{7}$/);
  assert.equal(r.title, `Git · ${r.s.oid!.slice(0, 7)}`);
  assert.deepEqual(r.changes, ["f.txt M"]);
});

test("upstream ahead/behind shows arrows", () => {
  const r = parsed("upstream");
  assert.deepEqual(r.s.ab, { ahead: 2, behind: 1 });
  assert.equal(r.title, "Git · main ↑2 ↓1");
});

test("upstream gone: no arrows", () => {
  const r = parsed("upstream-gone");
  assert.equal(r.s.upstream, "origin/main");
  assert.equal(r.s.ab, null);
  assert.equal(r.title, "Git · main");
});

test("no upstream: no arrows", () => {
  const r = parsed("mm");
  assert.equal(r.s.upstream, null);
  assert.equal(r.title, "Git · main");
});

test("paths with spaces and non-ASCII characters are kept verbatim", () => {
  const r = parsed("unicode");
  assert.deepEqual(r.staged, ["dir with space/naïve → renamed.txt R ← dir with space/naïve file.txt"]);
  assert.deepEqual(r.changes, ["dir with space/naïve → renamed.txt M", "ünï cødé.md U"]);
});

test("clean repository has empty groups", () => {
  const r = parsed("clean");
  assert.deepEqual(r.staged, []);
  assert.deepEqual(r.changes, []);
  assert.equal(r.title, "Git · main");
});

test("rows are sorted by path", () => {
  const s = parseStatus(["# branch.oid 0123456789", "# branch.head main", "? z.txt", "? a/b.txt", "1 .M N... 100644 100644 100644 0 0 m.txt", ""].join("\0"));
  assert.deepEqual(rows(s.changes), ["a/b.txt U", "m.txt M", "z.txt U"]);
});

test("empty output parses to an empty status", () => {
  const s = parseStatus("");
  assert.deepEqual(s, { branch: null, oid: null, upstream: null, ab: null, staged: [], changes: [] });
});

test("an untracked nested repository (`dir/`) and a submodule are directories", () => {
  const records = [`1 .M S.M. 160000 160000 160000 ${H} ${H} sub`, mod("M.", "plain.txt"), untracked("vendor/lib/"), untracked("new.txt")];
  const s = parseStatus(raw({ ab: null, records }));
  assert.deepEqual(s.changes, [
    { path: "new.txt", marker: "U" },
    { path: "sub", marker: "M", dir: true },
    { path: "vendor/lib/", marker: "U", dir: true },
  ]);
  assert.deepEqual(s.staged, [{ path: "plain.txt", marker: "M" }]);
});

test("a working-tree symbolic link (mW 120000) marks the Changes entry only; `?` records carry no mode (R14, F7)", () => {
  const s = parseStatus(fixture("symlink"));
  assert.deepEqual(
    s.changes.map((e) => [e.path, e.marker, e.link === true]),
    [["file.txt", "T", true], ["link", "M", true], ["new-link", "U", false]],
  );
  // Staged rows compare HEAD with the index: no flag, even for a link.
  assert.deepEqual(s.staged.map((e) => [e.path, e.marker, "link" in e]), [["staged-file.txt", "T", false], ["staged-link", "M", false]]);
  // A conflicted link: `u XY sub m1 m2 m3 mW …`.
  const u = parseStatus(raw({ records: [`u UU N... 120000 120000 120000 120000 ${H} ${H} ${H} l`, `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} f`] }));
  assert.deepEqual(u.changes.map((e) => [e.path, e.link === true]), [["f", false], ["l", true]]);
  // Only the worktree mode counts: a link replaced by a file is not one.
  const back = parseStatus(raw({ records: [`1 .T N... 120000 120000 100644 ${H} ${H} t`] }));
  assert.equal(back.changes[0].link, undefined);
});
