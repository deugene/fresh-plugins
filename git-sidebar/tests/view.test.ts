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
  revealKey,
  rowKind,
  signature,
  STAGED_KEY,
  VOLUME_NOTICE,
} from "../lib/view.ts";
import { GRAPH_KEY } from "../lib/graph.ts";
import { H, manyUntracked, mod, raw, status as fixture, texts, untracked } from "./helpers.ts";

test("groups: Staged first, Changes second with true counts, then Graph with none (R3)", () => {
  const spec = buildTree(fixture("acceptance"));
  const groups = spec.nodes.filter((n) => n.depth === 0).map((n) => n.text.text);
  assert.deepEqual(groups, ["Staged Changes 2", "Changes 5", "Graph"]);
  assert.equal(spec.itemKeys[0], STAGED_KEY);
  assert.equal(spec.itemKeys.at(-1), GRAPH_KEY);
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
    "Graph",
  ]);
  assert.deepEqual(spec.itemKeys, [
    "g:s", "s:a.ts", "s:moved.ts", "g:c", "c:a.ts", "c:b.md", "c:gone.ts", "c:new/c.txt", "c:new/d.txt", "g:g",
  ]);
});

test("empty groups are present with count 0", () => {
  const spec = buildTree(fixture("clean"));
  assert.deepEqual(texts(spec), ["Staged Changes 0", "Changes 0", "Graph"]);
});

test("every tree uses the layout that lets presses on the selected row through (INV §8 P21)", () => {
  // Plain sidebar trees lay a mark over the selected row that swallows its
  // click, its `+`/`−` and a right-click; `cardBorders` at height 1 does not.
  for (const spec of [buildTree(null), buildTree(fixture("acceptance")), noticeTree("x")]) {
    assert.equal(spec.cardBorders, true);
    assert.equal(spec.itemHeight, 1);
  }
});

test("placeholder before the first status: the three groups, no counts, no rows", () => {
  const spec = buildTree(null);
  assert.deepEqual(texts(spec), ["Staged Changes", "Changes", "Graph"]);
  assert.deepEqual(spec.itemKeys, [STAGED_KEY, CHANGES_KEY, GRAPH_KEY]);
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

test("1,200 untracked files: 1,000 rows plus `… 200 more` with the true count (R11)", () => {
  const spec = buildTree(parseStatus(raw({ ab: null, records: manyUntracked(1200) })));
  const changes = spec.nodes.slice(spec.itemKeys.indexOf(CHANGES_KEY), spec.itemKeys.indexOf(GRAPH_KEY));
  assert.equal(changes[0].text.text, "Changes 1200");
  assert.equal(changes.length, 1 + 1000 + 1);
  assert.equal(changes.at(-1)!.text.text, "… 200 more");
  assert.equal(spec.itemKeys.at(-2), "more:c");
  assert.equal(rowKind("more:c").kind, "inert");
  assert.equal(rowKind("more:s").kind, "inert");
  // Exactly 1,000 is not capped.
  const spec1000 = buildTree(parseStatus(raw({ ab: null, records: manyUntracked(1000) })));
  assert.ok(!spec1000.itemKeys.includes("more:c"));
  assert.equal(spec1000.itemKeys.length, 3 + 1000);
});

test("a file named `~more` in an overflowing group keeps a unique, openable key", () => {
  const spec = buildTree(parseStatus(raw({ ab: null, records: [untracked("~more"), ...manyUntracked(1100, "~n")] })));
  assert.equal(new Set(spec.itemKeys).size, spec.itemKeys.length, "item keys unique");
  assert.ok(spec.itemKeys.includes("c:~more"));
  assert.deepEqual(rowKind("c:~more"), { kind: "file", path: "~more" });
});

test("directory rows: name is the last segment, dir its parent; their keys are listed", () => {
  const status = parseStatus(raw({ ab: null, records: [`1 .M S.M. 160000 160000 160000 ${H} ${H} libs/sub`, untracked("vendor/lib/")] }));
  const spec = buildTree(status);
  assert.deepEqual(texts(spec), ["Staged Changes 0", "Changes 2", "M sub  libs", "U lib  vendor", "Graph"]);
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
  assert.deepEqual(actions(), [null, null, null, null, null, null, null, null, null, null]);
  assert.ok(buildTree(acc).nodes.every((n) => !("action" in n)), "no field without buttons");
  assert.deepEqual(actions(filesOnly), [null, "-", "-", null, "+", "+", "+", "+", "+", null]);
  // The Graph group never asks for a label: it has no button (R3).
  assert.deepEqual(actions(label), ["G", "-", "-", "G", "+", "+", "+", "+", "+", null]);
  // A label of null means no button on that row.
  const some = buildTree(acc, (k) => (k === "c:b.md" ? "+" : null));
  assert.deepEqual(some.nodes.map((n) => n.action ?? null), [null, null, null, null, null, "+", null, null, null, null]);
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

test("reconcile: a gone row's selection stays at its offset in its group, not its global index (R10, spec decisions)", () => {
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

test("a deleted file's name is struck through in both groups; nothing else is (R24)", () => {
  const struck = (spec: ReturnType<typeof buildTree>) =>
    spec.itemKeys.flatMap((k, i) => (spec.nodes[i].text.segments.some((s) => s.style?.strikethrough === true) ? [k] : []));
  // Changes ` D gone.ts` in the acceptance fixture, Staged `D f.txt` from `git rm --cached`.
  const acc = buildTree(fixture("acceptance"));
  assert.deepEqual(struck(acc), ["c:gone.ts"]);
  const gone = acc.nodes[acc.itemKeys.indexOf("c:gone.ts")].text.segments;
  assert.deepEqual(gone, [
    { text: "D", style: { fg: "ui.file_status_deleted_fg" } },
    { text: " " },
    { text: "gone.ts", style: { fg: "ui.file_status_deleted_fg", strikethrough: true } },
  ]);
  assert.deepEqual(struck(buildTree(fixture("rm-cached"))), ["s:f.txt"]);
  // Its directory segment is not struck through.
  const nested = buildTree(parseStatus(raw({ records: [`1 .D N... 100644 100644 000000 ${H} ${H} src/old.ts`] })));
  const segs = nested.nodes[nested.itemKeys.indexOf("c:src/old.ts")].text.segments;
  assert.deepEqual(
    segs.map((s) => [s.text, s.style?.strikethrough === true]),
    [["D", false], [" ", false], ["old.ts", true], ["  src", false]],
  );
  // No M, A, R, C, T, U or `!` row, a deleting conflict (DU, UD) included.
  const others = [
    "acceptance", "copy", "conflict", "merge", "mm", "rename", "intent-to-add", "unborn", "symlink", "unicode",
  ].map((name) => buildTree(fixture(name)));
  others.push(buildTree(parseStatus(raw({ records: [`u UD N... 100644 100644 000000 100644 ${H} ${H} ${H} ud.txt`, mod("T.", "t.sh")] }))));
  for (const spec of others) {
    for (const k of struck(spec)) assert.equal(spec.nodes[spec.itemKeys.indexOf(k)].text.segments[0].text, "D", k);
  }
  assert.ok(texts(buildTree(fixture("conflict"))).includes("! du.txt"));
  // The signature sees the style.
  const plain = { ...acc, nodes: acc.nodes.map((n) => ({ ...n, text: { ...n.text, segments: n.text.segments.map((s) => (s.style ? { ...s, style: { fg: s.style.fg } } : s)) } })) };
  assert.notEqual(signature("t", acc), signature("t", plain));
});

test("revealKey: the file's Changes row, else its Staged row; null when not listed, collapsed, not drawn or already selected (R23)", () => {
  const acc = fixture("acceptance");
  const spec = buildTree(acc);
  const entries = entryMap(acc);
  const both = new Set([STAGED_KEY, CHANGES_KEY]);
  const reveal = (p: string, expanded: ReadonlySet<string> = both, keys = spec.itemKeys, e = entries, selected: string | null = null) =>
    revealKey(p, "/repo", e, keys, expanded, selected);
  assert.equal(reveal("/repo/b.md"), "c:b.md");
  assert.equal(reveal("/repo/new/c.txt"), "c:new/c.txt", "a nested path");
  // Listed in both groups: the Changes row.
  assert.equal(reveal("/repo/a.ts"), "c:a.ts");
  // Staged only.
  assert.equal(reveal("/repo/moved.ts"), "s:moved.ts");
  // One of the file's rows already selected: it stays, the Staged one too,
  // which the Changes row would replace (R23 "Both groups").
  assert.equal(reveal("/repo/a.ts", both, spec.itemKeys, entries, "s:a.ts"), null);
  assert.equal(reveal("/repo/a.ts", both, spec.itemKeys, entries, "c:a.ts"), null);
  assert.equal(reveal("/repo/moved.ts", both, spec.itemKeys, entries, "s:moved.ts"), null);
  // Another row selected, a group row included: the file's row as usual.
  assert.equal(reveal("/repo/a.ts", both, spec.itemKeys, entries, "s:moved.ts"), "c:a.ts");
  assert.equal(reveal("/repo/a.ts", both, spec.itemKeys, entries, STAGED_KEY), "c:a.ts");
  // Not listed, outside the root, a sibling root, the root itself.
  assert.equal(reveal("/repo/README.md"), null);
  assert.equal(reveal("/elsewhere/b.md"), null);
  assert.equal(reveal("/repo2/b.md"), null);
  assert.equal(reveal("/repo"), null);
  assert.equal(revealKey("/repo/b.md", "/repo/", entries, spec.itemKeys, both, null), "c:b.md", "a root with a trailing slash");
  assert.equal(revealKey("/b.md", "/", entries, spec.itemKeys, both, null), "c:b.md", "a repository at the filesystem root");
  // Changes collapsed: the group that lists the file decides, even with a Staged row drawn.
  assert.equal(reveal("/repo/b.md", new Set([STAGED_KEY])), null);
  assert.equal(reveal("/repo/a.ts", new Set([STAGED_KEY])), null, "not its Staged row instead");
  assert.equal(reveal("/repo/moved.ts", new Set([CHANGES_KEY])), null);
  // Past the 1,000-row cap: listed but not drawn.
  const many = parseStatus(raw({ ab: null, records: manyUntracked(1200) }));
  const manySpec = buildTree(many);
  assert.equal(revealKey("/repo/f0400.txt", "/repo", entryMap(many), manySpec.itemKeys, both, null), "c:f0400.txt");
  assert.equal(revealKey("/repo/f0999.txt", "/repo", entryMap(many), manySpec.itemKeys, both, null), "c:f0999.txt");
  assert.equal(revealKey("/repo/f1000.txt", "/repo", entryMap(many), manySpec.itemKeys, both, null), null);
});

test("reconcile keeps a vanished Graph row's selection inside the Graph (R10, R30)", () => {
  const keys = ["g:s", "g:c", "c:a", "g:g", "h:1", "hf:1:x", "hf:1:y", "h:2", "more:h"];
  // hf:1:y is gone (the commit collapsed): its place in the Graph.
  const place = placeOf(keys, "hf:1:y");
  assert.deepEqual(place, { group: "g:g", offset: 2 });
  const after = ["g:s", "g:c", "c:a", "c:b", "g:g", "h:1", "h:2", "more:h"];
  assert.deepEqual(reconcile("hf:1:y", place, 6, after), { key: "more:h", index: 7 });
  // A commit row that is still listed keeps its key, wherever it moved.
  assert.deepEqual(reconcile("h:2", placeOf(keys, "h:2"), 7, after), { key: "h:2", index: 6 });
  // Every commit gone (an unborn branch): the group row.
  assert.deepEqual(reconcile("h:1", placeOf(keys, "h:1"), 4, ["g:s", "g:c", "g:g"]), { key: "g:g", index: 2 });
});

test("the Graph's rows follow the status rows; revealKey never picks one (R3, R23)", () => {
  const acc = fixture("acceptance");
  const spec = buildTree(acc, undefined, { nodes: [{ text: { text: "● x", segments: [{ text: "● x" }] }, depth: 1, hasChildren: true }], keys: ["h:1"] });
  assert.deepEqual(spec.itemKeys.slice(-2), [GRAPH_KEY, "h:1"]);
  // A commit lists a.ts too, but only status rows are revealed.
  const keys = [...spec.itemKeys, "hf:1:a.ts"];
  assert.equal(revealKey("/repo/a.ts", "/repo", entryMap(acc), keys, new Set([STAGED_KEY, CHANGES_KEY, GRAPH_KEY, "h:1"]), "hf:1:a.ts"), "c:a.ts");
});
