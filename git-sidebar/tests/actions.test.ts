import { test } from "node:test";
import assert from "node:assert/strict";
import { badName, parseStatus, type Status } from "../lib/status.ts";
import {
  anchorArg,
  buttonLabel,
  menuChoice,
  menuItems,
  menuSpec,
  MINUS,
  NO_ROWS,
  NOTHING_SELECTED,
  NOTHING_STAGED,
  paletteTarget,
  rowAction,
} from "../lib/actions.ts";
import { buildTree, CHANGES_KEY, entryMap, STAGED_KEY, type EntryMap } from "../lib/view.ts";
import { H, raw, recorded, status as fixture, untracked } from "./helpers.ts";
import { commitFileKey, commitKey, GRAPH_KEY, graphRows, LOAD_MORE_KEY, type Files, type GraphRows } from "../lib/graph.ts";
import { parseLog } from "../lib/history.ts";

/** No Graph rows: the status rows' tests. */
const NO_GRAPH: GraphRows = new Map();

/** A status and its entry map, built once. */
const shown = (status: Status): { status: Status; entries: EntryMap } => ({ status, entries: entryMap(status) });
const NONE_SHOWN: EntryMap = new Map();

/** Every row's key with its button label ("" for none), in tree order. */
function labels(status: Status): string[] {
  const entries = entryMap(status);
  return buildTree(status).itemKeys.map((k) => `${k} ${buttonLabel(k, status, entries) ?? ""}`.trim());
}

/** The action and the button label of the row `key`. */
function actionOf(key: string, s: { status: Status; entries: EntryMap }): [ReturnType<typeof rowAction>, string | null] {
  return [rowAction(key, s.status, s.entries), buttonLabel(key, s.status, s.entries)];
}

test("rowAction: Changes M/D/U/A(ita) rows stage, Staged rows unstage (R15)", () => {
  assert.deepEqual(labels(fixture("acceptance")), [
    `g:s ${MINUS}`,
    `s:a.ts ${MINUS}`,
    `s:moved.ts ${MINUS}`,
    "g:c +",
    "c:a.ts +",
    "c:b.md +",
    "c:gone.ts +",
    "c:new/c.txt +",
    "c:new/d.txt +",
    // The Graph group has no button (R3, R30).
    "g:g",
  ]);
  const rmCached = shown(fixture("rm-cached"));
  assert.deepEqual(actionOf("c:n.txt", shown(fixture("intent-to-add"))), [{ kind: "stage" }, "+"]);
  assert.deepEqual(actionOf("s:f.txt", rmCached), [{ kind: "unstage" }, MINUS]);
  assert.deepEqual(actionOf("c:f.txt", rmCached), [{ kind: "stage" }, "+"]);
  assert.deepEqual(actionOf("s:a.txt", shown(fixture("unborn"))), [{ kind: "unstage" }, MINUS]);
});

test("rowAction: conflicted and directory rows have no button, with a reason (R15)", () => {
  const conflict = shown(fixture("conflict"));
  for (const p of ["aa.txt", "du.txt", "uu.txt"]) {
    const [a, label] = actionOf(`c:${p}`, conflict);
    assert.equal(a.kind, "none", p);
    assert.equal(label, null, p);
    assert.match(a.kind === "none" ? (a.reason ?? "") : "", /merge conflict/, p);
  }
  const dirs = shown(parseStatus(raw({ ab: null, records: [`1 .M S.M. 160000 160000 160000 ${H} ${H} sub`, untracked("vendor/lib/")] })));
  assert.deepEqual(actionOf("c:sub", dirs), [{ kind: "none", reason: "sub is a directory (submodule or nested repository)" }, null]);
  assert.deepEqual(actionOf("c:vendor/lib/", dirs), [{ kind: "none", reason: "vendor/lib is a directory (submodule or nested repository)" }, null]);
  // The group still has a button: it lists files (R16), and stage all skips these.
  assert.deepEqual(actionOf(CHANGES_KEY, conflict), [{ kind: "stageAll" }, "+"]);
});

test("rowAction: empty groups and other rows are silent; no status gives nothing (R16)", () => {
  const clean = shown(fixture("clean"));
  assert.deepEqual(actionOf(STAGED_KEY, clean), [{ kind: "none", reason: null }, null]);
  assert.deepEqual(actionOf(CHANGES_KEY, clean), [{ kind: "none", reason: null }, null]);
  const acc = shown(fixture("acceptance"));
  assert.deepEqual(actionOf("more:c", acc), [{ kind: "none", reason: null }, null]);
  assert.deepEqual(actionOf("n:notice", acc), [{ kind: "none", reason: null }, null]);
  assert.deepEqual(actionOf("c:not-listed.txt", acc), [{ kind: "none", reason: null }, null]);
  assert.deepEqual(rowAction("c:b.md", null, NONE_SHOWN), { kind: "none", reason: null });
  assert.deepEqual(rowAction(STAGED_KEY, null, NONE_SHOWN), { kind: "none", reason: null });
  assert.equal(buttonLabel(STAGED_KEY, null, NONE_SHOWN), null);
  // Non-empty groups.
  assert.deepEqual(actionOf(STAGED_KEY, acc), [{ kind: "unstageAll" }, MINUS]);
  assert.deepEqual(actionOf(CHANGES_KEY, acc), [{ kind: "stageAll" }, "+"]);
});

test("menuItems follow A17", () => {
  const acc = shown(fixture("acceptance"));
  const m = (key: string, s: { status: Status; entries: EntryMap } = acc) => menuItems(key, s.status, s.entries, NO_GRAPH).map((i) => i.label);
  assert.deepEqual(m("c:b.md"), ["View Diff", "View File", "Stage"]);
  assert.deepEqual(m("s:moved.ts"), ["View Diff", "View File", "Unstage"]);
  // Staged Changes also offers Commit… while it lists files (R26).
  assert.deepEqual(m(STAGED_KEY), ["Unstage All", "Commit…"]);
  assert.deepEqual(menuItems(STAGED_KEY, acc.status, acc.entries, NO_GRAPH).map((i) => i.choice), ["unstageAll", "commit"]);
  assert.deepEqual(m(CHANGES_KEY), ["Stage All"]);
  assert.deepEqual(menuItems("c:b.md", acc.status, acc.entries, NO_GRAPH).map((i) => i.choice), ["diff", "file", "stage"]);
  // Rows with no action: a conflicted file keeps its views; an empty group, `… N more` and a notice get nothing.
  // A conflicted file: its views, and Resolve Conflict (R25), never Stage.
  const conflict = shown(fixture("conflict"));
  assert.deepEqual(m("c:uu.txt", conflict), ["View Diff", "View File", "Resolve Conflict"]);
  assert.deepEqual(m("c:du.txt", conflict), ["View Diff", "View File", "Resolve Conflict"]);
  assert.deepEqual(menuItems("c:uu.txt", conflict.status, conflict.entries, NO_GRAPH).map((i) => i.choice), ["diff", "file", "resolve"]);
  const ud = shown(parseStatus(raw({ records: [`u UD N... 100644 100644 000000 100644 ${H} ${H} ${H} ud.txt`] })));
  assert.deepEqual(m("c:ud.txt", ud), ["View Diff", "View File", "Resolve Conflict"]);
  // No other row offers it.
  for (const k of ["c:b.md", "c:gone.ts", "s:a.ts", STAGED_KEY, CHANGES_KEY]) assert.ok(!m(k).includes("Resolve Conflict"), k);
  assert.deepEqual(m(STAGED_KEY, shown(fixture("clean"))), [], "no Commit… with nothing staged");
  assert.ok(!m(CHANGES_KEY).includes("Commit…"));
  assert.ok(!m("s:a.ts").includes("Commit…"));
  assert.deepEqual(m("more:c"), []);
  assert.deepEqual(m("n:notice"), []);
  assert.deepEqual(m("c:not-listed.txt"), []);
  assert.deepEqual(menuItems("c:b.md", null, NONE_SHOWN, NO_GRAPH), []);
});

test("paletteTarget (R18): the selected row, the group, or a message", () => {
  const { status: acc, entries } = shown(fixture("acceptance"));
  const target = (cmd: Parameters<typeof paletteTarget>[0], sel: string | null) => paletteTarget(cmd, sel, acc, entries, NO_GRAPH);
  for (const cmd of ["viewDiff", "viewFile", "toggle"] as const) {
    assert.deepEqual(target(cmd, null), { ok: false, message: NOTHING_SELECTED }, cmd);
  }
  assert.deepEqual(target("viewDiff", "c:b.md"), { ok: true, key: "c:b.md" });
  assert.deepEqual(target("viewFile", "s:moved.ts"), { ok: true, key: "s:moved.ts" });
  assert.deepEqual(target("toggle", "s:a.ts"), { ok: true, key: "s:a.ts" });
  // Stage All and Unstage All act on their group whatever is selected.
  for (const sel of [null, "s:a.ts", "c:b.md", STAGED_KEY]) {
    assert.deepEqual(target("stageAll", sel), { ok: true, key: CHANGES_KEY });
    assert.deepEqual(target("unstageAll", sel), { ok: true, key: STAGED_KEY });
  }
  // Rows they do not apply to.
  assert.equal(target("viewDiff", CHANGES_KEY).ok, false);
  assert.equal(target("toggle", CHANGES_KEY).ok, false);
  assert.equal(target("viewFile", "more:c").ok, false);
  const conflict = shown(fixture("conflict"));
  const uu = paletteTarget("toggle", "c:uu.txt", conflict.status, conflict.entries, NO_GRAPH);
  assert.ok(!uu.ok && /merge conflict/.test(uu.message));
  const clean = shown(fixture("clean"));
  assert.deepEqual(paletteTarget("stageAll", null, clean.status, clean.entries, NO_GRAPH), { ok: false, message: "nothing to stage" });
  assert.deepEqual(paletteTarget("unstageAll", null, clean.status, clean.entries, NO_GRAPH), { ok: false, message: "nothing to unstage" });
  // Commit…: Staged Changes whichever row is selected, while it lists a file (R26).
  for (const sel of [null, "c:b.md", CHANGES_KEY]) assert.deepEqual(target("commit", sel), { ok: true, key: STAGED_KEY });
  assert.deepEqual(paletteTarget("commit", null, clean.status, clean.entries, NO_GRAPH), { ok: false, message: NOTHING_STAGED });
  assert.equal(NOTHING_STAGED, "nothing staged to commit");
  // Resolve Conflict: a selected `!` row only (R25, R18).
  const resolveNeeds = { ok: false, message: "Resolve Conflict needs a file with a merge conflict selected" };
  assert.deepEqual(paletteTarget("resolve", "c:uu.txt", conflict.status, conflict.entries, NO_GRAPH), { ok: true, key: "c:uu.txt" });
  assert.deepEqual(target("resolve", "c:b.md"), resolveNeeds);
  assert.deepEqual(target("resolve", CHANGES_KEY), resolveNeeds);
  assert.deepEqual(target("resolve", null), { ok: false, message: NOTHING_SELECTED });
  // Under a notice there is no status.
  for (const cmd of ["viewDiff", "viewFile", "toggle", "stageAll", "unstageAll", "resolve", "commit"] as const) {
    assert.deepEqual(paletteTarget(cmd, "c:b.md", null, NONE_SHOWN, NO_GRAPH), { ok: false, message: NO_ROWS }, cmd);
  }
  assert.equal(NO_ROWS, "the Git section shows no files");
});

test("menuSpec: a column of bare buttons keyed by choice; menuChoice reads them back (R17)", () => {
  const acc = shown(fixture("acceptance"));
  const items = menuItems("c:b.md", acc.status, acc.entries, NO_GRAPH);
  const spec = menuSpec(items);
  assert.equal(spec.kind, "col");
  const buttons = spec.children as { kind: string; label: string; key: string; bare: boolean; focusable: boolean }[];
  assert.deepEqual(buttons.map((b) => [b.kind, b.label, b.key]), [
    ["button", " View Diff ", "menu:diff"],
    ["button", " View File ", "menu:file"],
    ["button", " Stage ", "menu:stage"],
  ]);
  assert.ok(buttons.every((b) => b.bare && b.focusable));
  for (const b of buttons) assert.notEqual(menuChoice(b.key), null);
  for (const c of ["diff", "file", "resolve", "commit", "stage", "unstage", "stageAll", "unstageAll"]) assert.equal(menuChoice(`menu:${c}`), c);
  assert.equal(menuChoice("menu:toString"), null);
  assert.equal(menuChoice("git"), null);
});

test("anchorArg packs the cell below the pointer as y << 16 | x (INV §8 P10)", () => {
  assert.equal(anchorArg(7, 24), 25 * 65536 + 7);
  assert.equal(anchorArg(-3, -1), 65536, "clamped to row 0, then the row below");
});

test("a rename from a name that is not UTF-8: the message names that original path, not the new one (R15)", () => {
  const bad = "caf�.txt";
  const s = shown(parseStatus(raw({ ab: null, records: [`2 R. N... 100644 100644 100644 ${H} ${H} R100 good.txt\0${bad}`] })));
  assert.deepEqual(rowAction("s:good.txt", s.status, s.entries), {
    kind: "none",
    reason: `${bad}: the name is not valid UTF-8, so git can't be passed it back`,
  });
  assert.equal(badName({ path: bad, marker: "U" }), bad);
  assert.equal(badName({ path: "dir/", marker: "U" }), "dir");
});

const A30 = parseLog(recorded("log-a30.z"), 50, "origin/main").commits;
const M = A30.find((c) => c.subject === "M")!;
const GRAPH = graphRows(A30, new Map<string, Files>([[M.id, [{ path: "f1.txt", marker: "A" }]]]));

test("Graph rows: no button, no write, Space and the palette's Stage say nothing of staging them (R30, R32)", () => {
  const acc = shown(fixture("acceptance"));
  for (const key of [GRAPH_KEY, commitKey(M.id), commitFileKey(M.id, "f1.txt"), LOAD_MORE_KEY, `more:hf:${M.id}`]) {
    assert.deepEqual(rowAction(key, acc.status, acc.entries), { kind: "none", reason: null }, key);
    assert.equal(buttonLabel(key, acc.status, acc.entries), null, key);
    const items = menuItems(key, acc.status, acc.entries, GRAPH).map((i) => i.choice);
    assert.ok(!items.some((c) => ["stage", "unstage", "stageAll", "unstageAll", "commit", "resolve"].includes(c)), key);
  }
  assert.equal(paletteTarget("toggle", commitFileKey(M.id, "f1.txt"), acc.status, acc.entries, GRAPH).ok, false);
});

test("Graph menus: Pull and Push on the group, the commit's three items, View Diff and View File on its files, none on Load more (R17, A17)", () => {
  const acc = shown(fixture("acceptance"));
  const labelsOf = (key: string) => menuItems(key, acc.status, acc.entries, GRAPH).map((i) => i.label);
  assert.deepEqual(labelsOf(GRAPH_KEY), ["Pull", "Push"]);
  assert.deepEqual(labelsOf(commitKey(M.id)), ["View Commit", "Copy Commit ID", "Copy Commit Message"]);
  assert.deepEqual(labelsOf(commitFileKey(M.id, "f1.txt")), ["View Diff", "View File"]);
  assert.deepEqual(labelsOf(LOAD_MORE_KEY), []);
  assert.deepEqual(labelsOf(`more:hf:${M.id}`), []);
  // A row no longer listed: no menu.
  assert.deepEqual(labelsOf(commitKey("f".repeat(40))), []);
  // No rows shown: no menu at all.
  assert.deepEqual(menuItems(GRAPH_KEY, null, NONE_SHOWN, GRAPH), []);
});

test("palette: View Commit and the copies act on the selected commit or its file's commit; Pull and Push on the branch (R18, R33–R35)", () => {
  const acc = shown(fixture("acceptance"));
  for (const cmd of ["viewCommit", "copyId", "copyMessage"] as const) {
    assert.deepEqual(paletteTarget(cmd, commitKey(M.id), acc.status, acc.entries, GRAPH), { ok: true, key: commitKey(M.id) });
    assert.deepEqual(paletteTarget(cmd, commitFileKey(M.id, "f1.txt"), acc.status, acc.entries, GRAPH), { ok: true, key: commitKey(M.id) });
    assert.equal(paletteTarget(cmd, "c:b.md", acc.status, acc.entries, GRAPH).ok, false);
    assert.equal(paletteTarget(cmd, null, acc.status, acc.entries, GRAPH).ok, false);
  }
  assert.deepEqual(paletteTarget("viewCommit", "c:b.md", acc.status, acc.entries, GRAPH), { ok: false, message: "View Commit needs a commit selected in the Graph" });
  for (const cmd of ["pull", "push"] as const) {
    assert.deepEqual(paletteTarget(cmd, null, acc.status, acc.entries, GRAPH), { ok: true, key: GRAPH_KEY });
    assert.deepEqual(paletteTarget(cmd, "c:b.md", acc.status, acc.entries, GRAPH), { ok: true, key: GRAPH_KEY });
  }
  assert.deepEqual(paletteTarget("pull", null, null, NONE_SHOWN, NO_GRAPH), { ok: false, message: NO_ROWS });
  // View Diff and View File reach a commit's file.
  for (const cmd of ["viewDiff", "viewFile"] as const) {
    assert.deepEqual(paletteTarget(cmd, commitFileKey(M.id, "f1.txt"), acc.status, acc.entries, GRAPH), { ok: true, key: commitFileKey(M.id, "f1.txt") });
    assert.equal(paletteTarget(cmd, commitKey(M.id), acc.status, acc.entries, GRAPH).ok, false);
  }
});

test("menuChoice round-trips the new choices (R17)", () => {
  for (const c of ["viewCommit", "copyId", "copyMessage", "pull", "push"]) {
    assert.equal(menuChoice(`menu:${c}`), c);
    const spec = menuSpec([{ choice: c as never, label: c }]);
    assert.equal(menuChoice((spec.children[0] as { key: string }).key), c);
  }
});
