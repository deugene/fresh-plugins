import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commitDiffTarget,
  commitFileKey,
  commitKey,
  commitOf,
  GRAPH_KEY,
  graphKind,
  graphPart,
  graphRows,
  LANE_KEYS,
  LOAD_MORE_KEY,
  type Files,
} from "../lib/graph.ts";
import { graphGroupOf } from "../lib/graph_keys.ts";
import { parseDiffTree, parseLog, type Commit } from "../lib/history.ts";
import { LANE_COLORS, layout } from "../lib/lanes.ts";
import { ROW_CAP, rowKind } from "../lib/view.ts";
import type { Entry } from "../lib/status.ts";
import { recorded } from "./helpers.ts";

const A30 = parseLog(recorded("log-a30.z"), 50, "origin/main").commits;
const bySubject = (s: string): Commit => A30.find((c) => c.subject === s)!;
const part = (opts: { expanded?: string[]; files?: [string, Files][]; hasMore?: boolean; commits?: Commit[] } = {}) => {
  const commits = opts.commits ?? A30;
  return graphPart(commits, layout(commits), new Set(opts.expanded ?? []), new Map(opts.files ?? []), opts.hasMore ?? false);
};

test("keys: none can collide with a Staged or Changes key; each kind told apart (R30)", () => {
  const id = "a".repeat(40);
  assert.equal(commitKey(id), `h:${id}`);
  assert.equal(commitFileKey(id, "dir/x:y.ts"), `hf:${id}:dir/x:y.ts`);
  assert.deepEqual(graphKind(GRAPH_KEY), { kind: "group" });
  assert.deepEqual(graphKind(`h:${id}`), { kind: "commit", id });
  assert.deepEqual(graphKind(`hf:${id}:dir/x:y.ts`), { kind: "commitFile", id, path: "dir/x:y.ts" });
  assert.deepEqual(graphKind(LOAD_MORE_KEY), { kind: "loadMore" });
  assert.deepEqual(graphKind(`more:hf:${id}`), { kind: "inert" });
  for (const k of ["g:s", "g:c", "s:h:x", "c:hf:x", "more:s", "more:c", "n:notice"]) {
    assert.equal(graphKind(k), null, k);
    assert.equal(graphGroupOf(k), null, k);
  }
  for (const k of [GRAPH_KEY, `h:${id}`, `hf:${id}:p`, LOAD_MORE_KEY, `more:hf:${id}`]) assert.equal(graphGroupOf(k), GRAPH_KEY, k);
  // rowKind keeps `file` for status rows only.
  assert.deepEqual(rowKind(GRAPH_KEY), { kind: "group" });
  assert.equal(rowKind(`h:${id}`).kind, "commit");
  assert.equal(rowKind(`hf:${id}:p`).kind, "commitFile");
  assert.equal(rowKind(LOAD_MORE_KEY).kind, "loadMore");
});

test("one theme key per lane colour, so a colour index never wraps (R31)", () => {
  assert.equal(LANE_KEYS.length, LANE_COLORS);
});

test("graphPart: a row per commit at depth 1 with children, lanes, badges, subject, author dimmed (R30, R31)", () => {
  const { nodes, keys } = part();
  assert.equal(nodes.length, 7);
  assert.deepEqual(keys, A30.map((c) => commitKey(c.id)));
  assert.ok(nodes.every((n) => n.depth === 1 && n.hasChildren === true && n.action === undefined));
  assert.deepEqual(nodes.map((n) => n.text.text), [
    "●  main  c4  fixture",
    "○─╮  origin/main  M  fixture",
    "│ ●  feat  f2  fixture",
    "│ ● f1  fixture",
    "● │ c3  fixture",
    "●─╯  v1a   v1  c2  fixture",
    "● c1  fixture",
  ]);
  const m = nodes[1].text.segments;
  // Lane cells merged by colour, theme keys only.
  assert.deepEqual(m.slice(0, 2), [
    { text: "○", style: { fg: "editor.bracket_rainbow_1" } },
    { text: "─╮", style: { fg: "editor.bracket_rainbow_2" } },
  ]);
  // The upstream's badge and the current branch's have colours of their own.
  const badge = (segs: typeof m, name: string) => segs.find((s) => s.text === ` ${name} `)!.style;
  assert.deepEqual(badge(m, "origin/main"), { fg: "editor.bg", bg: "ui.file_status_renamed_fg", bold: true });
  assert.deepEqual(badge(nodes[0].text.segments, "main"), { fg: "editor.bg", bg: "ui.file_status_added_fg", bold: true });
  assert.deepEqual(badge(nodes[2].text.segments, "feat"), { fg: "editor.bg", bg: "editor.line_number_fg", bold: true });
  assert.deepEqual(m.at(-1), { text: "  fixture", style: { fg: "editor.line_number_fg" } });
});

test("graphPart: an expanded commit lists its files at depth 2, no button, capped; then Load more (R32, R11, R30)", () => {
  const m = bySubject("M");
  const files = parseDiffTree(recorded("difftree-merge.z"));
  const { nodes, keys } = part({ expanded: [commitKey(m.id)], files: [[m.id, files]], hasMore: true });
  const at = keys.indexOf(commitKey(m.id));
  assert.deepEqual(keys.slice(at + 1, at + 3), [commitFileKey(m.id, "f1.txt"), commitFileKey(m.id, "f2.txt")]);
  assert.deepEqual(nodes.slice(at + 1, at + 3).map((n) => [n.text.text, n.depth, n.hasChildren, n.action]), [
    ["A f1.txt", 2, false, undefined],
    ["A f2.txt", 2, false, undefined],
  ]);
  assert.equal(keys.at(-1), LOAD_MORE_KEY);
  assert.deepEqual([nodes.at(-1)!.text.text, nodes.at(-1)!.depth, nodes.at(-1)!.hasChildren], ["Load more", 1, false]);
  // Not expanded, not read yet, or failed: no file rows.
  for (const opts of [{ files: [[m.id, files]] as [string, Files][] }, { expanded: [commitKey(m.id)] }, { expanded: [commitKey(m.id)], files: [[m.id, "failed"]] as [string, Files][] }]) {
    assert.equal(part(opts).keys.length, 7);
  }
  // 1,200 files: 1,000 rows and `… 200 more`.
  const many: Entry[] = Array.from({ length: 1200 }, (_, i) => ({ path: `f${String(i).padStart(4, "0")}`, marker: "A" }));
  const big = part({ expanded: [commitKey(m.id)], files: [[m.id, many]] });
  const fileRows = big.keys.filter((k) => k.startsWith("hf:"));
  assert.equal(fileRows.length, ROW_CAP);
  assert.equal(big.keys[big.keys.indexOf(commitKey(m.id)) + ROW_CAP + 1], `more:hf:${m.id}`);
  assert.equal(big.nodes[big.keys.indexOf(`more:hf:${m.id}`)].text.text, "… 200 more");
  // A deleted file is struck through, as in Changes (R24).
  const d = part({ expanded: [commitKey(m.id)], files: [[m.id, [{ path: "gone", marker: "D" }]]] });
  assert.deepEqual(d.nodes[d.keys.indexOf(commitFileKey(m.id, "gone"))].text.segments[2].style, { fg: "ui.file_status_deleted_fg", strikethrough: true });
});

test("graphRows and commitOf: a commit's key and its files' keys lead to the commit (R18, R33)", () => {
  const m = bySubject("M");
  const files = parseDiffTree(recorded("difftree-merge.z"));
  const rows = graphRows(A30, new Map<string, Files>([[m.id, files]]));
  assert.equal(rows.size, 7 + 2);
  assert.equal(commitOf(commitKey(m.id), rows), m);
  assert.equal(commitOf(commitFileKey(m.id, "f2.txt"), rows), m);
  assert.deepEqual(rows.get(commitFileKey(m.id, "f2.txt"))!.entry, { path: "f2.txt", marker: "A" });
  assert.equal(commitOf(LOAD_MORE_KEY, rows), null);
  assert.equal(commitOf("c:a.ts", rows), null);
  assert.equal(commitOf(commitKey("f".repeat(40)), rows), null);
});

test("commitDiffTarget: first parent against the commit; renames, adds, deletes, roots, refusals (R32, A32)", () => {
  const c2 = bySubject("c2");
  const c1 = bySubject("c1");
  const k = "hf:x";
  const p7 = c2.parents[0].slice(0, 7);
  const i7 = c2.id.slice(0, 7);
  const t = commitDiffTarget(c2, { path: "c2.txt", marker: "M" }, k);
  assert.deepEqual(t, {
    key: k,
    path: "c2.txt",
    left: { kind: "blob", spec: `${c2.parents[0]}:c2.txt` },
    right: { kind: "blob", spec: `${c2.id}:c2.txt` },
    labels: [p7, i7],
    title: `c2.txt (${p7} ↔ ${i7})`,
    refusal: null,
    refusedName: "c2.txt",
  });
  assert.deepEqual(commitDiffTarget(c2, { path: "y", marker: "R", orig: "x" }, k).left, { kind: "blob", spec: `${c2.parents[0]}:x` });
  assert.deepEqual(commitDiffTarget(c2, { path: "n", marker: "A" }, k).left, { kind: "empty" });
  assert.deepEqual(commitDiffTarget(c2, { path: "g", marker: "D" }, k).right, { kind: "empty" });
  const root = commitDiffTarget(c1, { path: "c1.txt", marker: "A" }, k);
  assert.deepEqual(root.left, { kind: "empty" });
  assert.equal(root.title, `c1.txt (empty ↔ ${c1.id.slice(0, 7)})`);
  // Labels hold no `:` (R21).
  assert.ok(t.labels.every((l) => !l.includes(":")));
  assert.equal(commitDiffTarget(c2, { path: "sub", marker: "A", dir: true }, k).refusal, "directory");
  assert.equal(commitDiffTarget(c2, { path: "caf�", marker: "A" }, k).refusal, "unpassable name");
});
