import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, type Status } from "../lib/status.ts";
import {
  buildTree,
  CHANGES_KEY,
  entryMap,
  MARKER_COLOR,
  noticeTree,
  placeOf,
  reconcile,
  rowKind,
  signature,
  STAGED_KEY,
  VOLUME_NOTICE,
} from "../lib/view.ts";
import { H, manyUntracked, raw, status as fixture, texts, untracked } from "./helpers.ts";

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

test("every tree uses the layout that lets presses on the selected row through (INV §8 P21)", () => {
  // Plain sidebar trees lay a mark over the selected row that swallows its
  // click, its `+`/`−` and a right-click; `cardBorders` at height 1 does not.
  for (const spec of [buildTree(null), buildTree(fixture("acceptance")), noticeTree("x")]) {
    assert.equal(spec.cardBorders, true);
    assert.equal(spec.itemHeight, 1);
  }
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
  const spec = buildTree(parseStatus(raw({ ab: null, records: manyUntracked(1200) })));
  const changes = spec.nodes.slice(spec.itemKeys.indexOf(CHANGES_KEY));
  assert.equal(changes[0].text.text, "Changes 1200");
  assert.equal(changes.length, 1 + 500 + 1);
  assert.equal(changes.at(-1)!.text.text, "… 700 more");
  assert.equal(spec.itemKeys.at(-1), "more:c");
  assert.equal(rowKind("more:c").kind, "inert");
  assert.equal(rowKind("more:s").kind, "inert");
  // Exactly 500 is not capped.
  const spec500 = buildTree(parseStatus(raw({ ab: null, records: manyUntracked(500) })));
  assert.ok(!spec500.itemKeys.includes("more:c"));
});

test("a file named `~more` in an overflowing group keeps a unique, openable key", () => {
  const spec = buildTree(parseStatus(raw({ ab: null, records: [untracked("~more"), ...manyUntracked(600, "~n")] })));
  assert.equal(new Set(spec.itemKeys).size, spec.itemKeys.length, "item keys unique");
  assert.ok(spec.itemKeys.includes("c:~more"));
  assert.deepEqual(rowKind("c:~more"), { kind: "file", path: "~more" });
});

test("directory rows: name is the last segment, dir its parent; their keys are listed", () => {
  const status = parseStatus(raw({ ab: null, records: [`1 .M S.M. 160000 160000 160000 ${H} ${H} libs/sub`, untracked("vendor/lib/")] }));
  const spec = buildTree(status);
  assert.deepEqual(texts(spec), ["Staged Changes 0", "Changes 2", "M sub  libs", "U lib  vendor"]);
  const dirs = (s: Status) => [...entryMap(s)].filter(([, l]) => l.entry.dir).map(([k]) => k).sort();
  assert.deepEqual(dirs(status), ["c:libs/sub", "c:vendor/lib/"]);
  assert.deepEqual(dirs(fixture("acceptance")), []);
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

test("buttons: labels land in nodes[i].action, group rows included; signature() sees them (R5)", () => {
  const acc = fixture("acceptance");
  const label = (key: string) => (key.startsWith("g:") ? "G" : key.startsWith("s:") ? "-" : "+");
  /** The same labels on file rows only: null for the group rows. */
  const filesOnly = (key: string) => (key.startsWith("g:") ? null : label(key));
  const actions = (l?: (key: string) => string | null) => buildTree(acc, l).nodes.map((n) => n.action ?? null);
  assert.deepEqual(actions(), [null, null, null, null, null, null, null, null, null]);
  assert.ok(buildTree(acc).nodes.every((n) => !("action" in n)), "no field without buttons");
  assert.deepEqual(actions(filesOnly), [null, "-", "-", null, "+", "+", "+", "+", "+"]);
  assert.deepEqual(actions(label), ["G", "-", "-", "G", "+", "+", "+", "+", "+"]);
  // A label of null means no button on that row.
  const some = buildTree(acc, (k) => (k === "c:b.md" ? "+" : null));
  assert.deepEqual(some.nodes.map((n) => n.action ?? null), [null, null, null, null, null, "+", null, null, null]);
  assert.ok(!("action" in some.nodes[0]), "no field on a row without a button");
  // The placeholder never has buttons.
  assert.ok(buildTree(null, label).nodes.every((n) => !("action" in n)));
  // A button appearing changes what the section draws.
  const t = "Git · main ↑1 ↓0";
  assert.notEqual(signature(t, buildTree(acc)), signature(t, buildTree(acc, filesOnly)));
  assert.notEqual(signature(t, buildTree(acc, filesOnly)), signature(t, buildTree(acc, label)));
});

test("entryMap: every file row's key, its entry and its group, past the cap too", () => {
  const acc = fixture("acceptance");
  const map = entryMap(acc);
  assert.deepEqual([...map.keys()], ["s:a.ts", "s:moved.ts", "c:a.ts", "c:b.md", "c:gone.ts", "c:new/c.txt", "c:new/d.txt"]);
  assert.deepEqual(map.get("s:moved.ts"), { entry: { path: "moved.ts", marker: "R", orig: "old.ts" }, group: "staged" });
  assert.equal(map.get("c:a.ts")?.group, "changes");
  assert.equal(entryMap(parseStatus(raw({ ab: null, records: manyUntracked(600) }))).size, 600);
});

test("placeOf: a row's group and its offset in it", () => {
  const keys = buildTree(fixture("acceptance")).itemKeys;
  assert.deepEqual(placeOf(keys, "c:a.ts"), { group: CHANGES_KEY, offset: 0 });
  assert.deepEqual(placeOf(keys, "c:new/d.txt"), { group: CHANGES_KEY, offset: 4 });
  assert.deepEqual(placeOf(keys, "s:moved.ts"), { group: STAGED_KEY, offset: 1 });
  assert.deepEqual(placeOf(keys, CHANGES_KEY), { group: CHANGES_KEY, offset: -1 });
  assert.equal(placeOf(keys, "c:nope"), null);
  assert.deepEqual(placeOf(["n:notice"], "n:notice"), { group: null, offset: -1 });
});

test("reconcile: a gone row's selection stays at its offset in its group, not its global index (R10, critique F1)", () => {
  const before = ["g:s", "s:a.ts", "s:moved.ts", "g:c", "c:b.md", "c:gone.ts", "c:new/c.txt"];
  const place = placeOf(before, "c:b.md");
  // b.md staged: Staged grew by one, so index 4 is now the Changes group row.
  const after = ["g:s", "s:a.ts", "s:b.md", "s:moved.ts", "g:c", "c:gone.ts", "c:new/c.txt"];
  assert.deepEqual(reconcile("c:b.md", place, 4, after), { key: "c:gone.ts", index: 5 });
  // Still listed: its own row, wherever it moved.
  assert.deepEqual(reconcile("c:gone.ts", placeOf(before, "c:gone.ts"), 5, after), { key: "c:gone.ts", index: 5 });
  // The last file of the group went: clamped to the group's last row.
  const last = placeOf(before, "c:new/c.txt");
  assert.deepEqual(reconcile("c:new/c.txt", last, 6, ["g:s", "g:c", "c:b.md"]), { key: "c:b.md", index: 2 });
  // The group's only file went: the group row, so Space on it does nothing (an empty group has no action).
  assert.deepEqual(reconcile("c:b.md", { group: CHANGES_KEY, offset: 0 }, 4, ["g:s", "s:a.ts", "s:b.md", "g:c"]), { key: "g:c", index: 3 });
  // Staged group rows; the `… N more` row counts as a row of its group.
  assert.deepEqual(reconcile("s:x", { group: STAGED_KEY, offset: 9 }, 9, ["g:s", "s:a", "more:s", "g:c"]), { key: "more:s", index: 2 });
  // No place (the selection was a notice): the old index, clamped.
  assert.deepEqual(reconcile("n:notice", { group: null, offset: -1 }, 7, ["g:s", "g:c"]), { key: "g:c", index: 1 });
  assert.deepEqual(reconcile(null, null, 3, ["g:s"]), { key: null, index: -1 });
  assert.deepEqual(reconcile("c:x", null, 3, []), { key: null, index: -1 });
});
