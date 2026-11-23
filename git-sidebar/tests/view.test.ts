import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, type Status } from "../lib/status.ts";
import {
  buildTree,
  CHANGES_KEY,
  directoryKeys,
  MARKER_COLOR,
  noticeTree,
  rowKind,
  signature,
  STAGED_KEY,
  VOLUME_NOTICE,
} from "../lib/view.ts";
import { fixture as recorded, H, raw, texts, untracked } from "./helpers.ts";

const fixture = (name: string): Status => parseStatus(recorded(name));

test("groups: Staged first, Changes second, with true counts", () => {
  const spec = buildTree(fixture("acceptance"));
  const groups = spec.nodes.filter((n) => n.depth === 0).map((n) => n.text.text);
  assert.deepEqual(groups, ["Staged Changes 2", "Changes 5"]);
  assert.equal(spec.itemKeys[0], STAGED_KEY);
  assert.ok(spec.nodes.every((n) => (n.depth === 0) === n.hasChildren));
  // Seeds are neutral: the plugin sets them on every spec it sends.
  assert.deepEqual(spec.expandedKeys, []);
  assert.equal(spec.selectedIndex, -1);
  assert.equal(spec.toggleOnClick, true);
});

test("acceptance rows: marker, name, dir and original path", () => {
  const spec = buildTree(fixture("acceptance"));
  assert.deepEqual(texts(spec), [
    "Staged Changes 2",
    "M a.ts",
    "R moved.ts  ← old.ts",
    "Changes 5",
    "M a.ts",
    "M b.md",
    "D gone.ts",
    "U c.txt  new",
    "U d.txt  new",
  ]);
  assert.deepEqual(spec.itemKeys, [
    "g:s", "s:a.ts", "s:moved.ts", "g:c", "c:a.ts", "c:b.md", "c:gone.ts", "c:new/c.txt", "c:new/d.txt",
  ]);
});

test("empty groups are present with count 0", () => {
  const spec = buildTree(fixture("clean"));
  assert.deepEqual(texts(spec), ["Staged Changes 0", "Changes 0"]);
});

test("placeholder before the first status: both groups, no counts, no rows", () => {
  const spec = buildTree(null);
  assert.deepEqual(texts(spec), ["Staged Changes", "Changes"]);
  assert.deepEqual(spec.itemKeys, [STAGED_KEY, CHANGES_KEY]);
});

test("colours are theme keys only, never RGB", () => {
  const spec = buildTree(fixture("conflict"));
  const all = [fixture("acceptance"), fixture("copy"), fixture("conflict"), fixture("rm-cached")]
    .flatMap((s) => buildTree(s).nodes)
    .concat(spec.nodes)
    .flatMap((n) => n.text.segments);
  for (const seg of all) {
    if (seg.style) assert.equal(typeof seg.style.fg, "string", JSON.stringify(seg));
  }
  const used = new Set(all.flatMap((s) => (s.style ? [s.style.fg] : [])));
  for (const key of used) assert.match(key, /^(ui\.file_status_[a-z]+_fg|editor\.line_number_fg)$/);
  assert.equal(MARKER_COLOR.M, "ui.file_status_modified_fg");
  assert.equal(MARKER_COLOR.T, "ui.file_status_modified_fg");
  assert.equal(MARKER_COLOR.A, "ui.file_status_added_fg");
  assert.equal(MARKER_COLOR.D, "ui.file_status_deleted_fg");
  assert.equal(MARKER_COLOR.R, "ui.file_status_renamed_fg");
  assert.equal(MARKER_COLOR.C, "ui.file_status_renamed_fg");
  assert.equal(MARKER_COLOR.U, "ui.file_status_untracked_fg");
  assert.equal(MARKER_COLOR["!"], "ui.file_status_conflicted_fg");
});

test("marker and name share the status colour; dir and orig are de-emphasised", () => {
  const spec = buildTree(fixture("acceptance"));
  const moved = spec.nodes[spec.itemKeys.indexOf("s:moved.ts")].text.segments;
  assert.deepEqual(moved, [
    { text: "R", style: { fg: "ui.file_status_renamed_fg" } },
    { text: " " },
    { text: "moved.ts", style: { fg: "ui.file_status_renamed_fg" } },
    { text: "  ← old.ts", style: { fg: "editor.line_number_fg" } },
  ]);
  const c = spec.nodes[spec.itemKeys.indexOf("c:new/c.txt")].text.segments;
  assert.deepEqual(c.at(-1), { text: "  new", style: { fg: "editor.line_number_fg" } });
});

test("keys are unique when a path is in both groups", () => {
  for (const name of ["acceptance", "mm", "rm-cached", "unicode"]) {
    const keys = buildTree(fixture(name)).itemKeys;
    assert.equal(new Set(keys).size, keys.length, name);
  }
  const keys = buildTree(fixture("rm-cached")).itemKeys;
  assert.ok(keys.includes("s:f.txt") && keys.includes("c:f.txt"));
});

test("1,200 untracked files: 500 rows plus `… 700 more` with the true count", () => {
  const raw = ["# branch.oid abc", "# branch.head main"];
  for (let i = 0; i < 1200; i++) raw.push(`? f${String(i).padStart(4, "0")}.txt`);
  const spec = buildTree(parseStatus(raw.join("\0") + "\0"));
  const changes = spec.nodes.slice(spec.itemKeys.indexOf(CHANGES_KEY));
  assert.equal(changes[0].text.text, "Changes 1200");
  assert.equal(changes.length, 1 + 500 + 1);
  assert.equal(changes.at(-1)!.text.text, "… 700 more");
  assert.equal(spec.itemKeys.at(-1), "more:c");
  assert.equal(rowKind("more:c").kind, "inert");
  assert.equal(rowKind("more:s").kind, "inert");
  // Exactly 500 is not capped.
  const raw500 = raw.slice(0, 2 + 500);
  const spec500 = buildTree(parseStatus(raw500.join("\0") + "\0"));
  assert.ok(!spec500.itemKeys.includes("more:c"));
});

test("a file named `~more` in an overflowing group keeps a unique, openable key", () => {
  const raw = ["# branch.oid abc", "# branch.head main", "? ~more"];
  for (let i = 0; i < 600; i++) raw.push(`? ~n${String(i).padStart(4, "0")}.txt`);
  const spec = buildTree(parseStatus(raw.join("\0") + "\0"));
  assert.equal(new Set(spec.itemKeys).size, spec.itemKeys.length, "item keys unique");
  assert.ok(spec.itemKeys.includes("c:~more"));
  assert.deepEqual(rowKind("c:~more"), { kind: "file", path: "~more" });
});

test("directory rows: name is the last segment, dir its parent; their keys are listed", () => {
  const status = parseStatus(raw({ ab: null, records: [`1 .M S.M. 160000 160000 160000 ${H} ${H} libs/sub`, untracked("vendor/lib/")] }));
  const spec = buildTree(status);
  assert.deepEqual(texts(spec), ["Staged Changes 0", "Changes 2", "M sub  libs", "U lib  vendor"]);
  assert.deepEqual([...directoryKeys(status)].sort(), ["c:libs/sub", "c:vendor/lib/"]);
  assert.equal(directoryKeys(fixture("acceptance")).size, 0);
});

test("notice spec has exactly one inert row", () => {
  const spec = noticeTree(VOLUME_NOTICE);
  assert.equal(spec.nodes.length, 1);
  assert.equal(spec.nodes[0].text.text, VOLUME_NOTICE);
  assert.equal(spec.nodes[0].hasChildren, false);
  assert.equal(rowKind(spec.itemKeys[0]).kind, "inert");
});

test("signature: equal for identical input, different when the title or any row changes", () => {
  const a = fixture("acceptance");
  const base = signature("Git · main ↑1 ↓0", buildTree(a));
  assert.equal(base, signature("Git · main ↑1 ↓0", buildTree(fixture("acceptance"))));
  assert.notEqual(base, signature("Git · main ↑2 ↓0", buildTree(a)));
  const marker = structuredClone(a);
  marker.changes[1].marker = "D";
  assert.notEqual(base, signature("Git · main ↑1 ↓0", buildTree(marker)));
  const moved = structuredClone(a);
  moved.changes.push({ path: "zz.txt", marker: "U" });
  assert.notEqual(base, signature("Git · main ↑1 ↓0", buildTree(moved)));
  const regroup = structuredClone(a);
  regroup.staged.push(regroup.changes.splice(1, 1)[0]);
  assert.notEqual(base, signature("Git · main ↑1 ↓0", buildTree(regroup)));
  // Expansion and selection only seed a mount: they are not what the section draws.
  assert.equal(base, signature("Git · main ↑1 ↓0", { ...buildTree(a), expandedKeys: [STAGED_KEY], selectedIndex: 4 }));
});

test("rowKind", () => {
  assert.deepEqual(rowKind("g:s"), { kind: "group" });
  assert.deepEqual(rowKind("c:new/c.txt"), { kind: "file", path: "new/c.txt" });
  assert.deepEqual(rowKind("s:dir with space/x y.txt"), { kind: "file", path: "dir with space/x y.txt" });
  assert.equal(rowKind("n:notice").kind, "inert");
});
