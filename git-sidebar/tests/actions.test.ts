import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, type Status } from "../lib/status.ts";
import {
  anchorArg,
  badName,
  buttonLabel,
  menuChoice,
  menuItems,
  menuSpec,
  MINUS,
  NO_ROWS,
  NOTHING_SELECTED,
  paletteTarget,
  rowAction,
} from "../lib/actions.ts";
import { buildTree, CHANGES_KEY, entryMap, STAGED_KEY, type EntryMap } from "../lib/view.ts";
import { H, raw, status as fixture, untracked } from "./helpers.ts";

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
  const m = (key: string, s: { status: Status; entries: EntryMap } = acc) => menuItems(key, s.status, s.entries).map((i) => i.label);
  assert.deepEqual(m("c:b.md"), ["View Diff", "View File", "Stage"]);
  assert.deepEqual(m("s:moved.ts"), ["View Diff", "View File", "Unstage"]);
  assert.deepEqual(m(STAGED_KEY), ["Unstage All"]);
  assert.deepEqual(m(CHANGES_KEY), ["Stage All"]);
  assert.deepEqual(menuItems("c:b.md", acc.status, acc.entries).map((i) => i.choice), ["diff", "file", "stage"]);
  // Rows with no action: a conflicted file keeps its views; an empty group, `… N more` and a notice get nothing.
  assert.deepEqual(m("c:uu.txt", shown(fixture("conflict"))), ["View Diff", "View File"]);
  assert.deepEqual(m(STAGED_KEY, shown(fixture("clean"))), []);
  assert.deepEqual(m("more:c"), []);
  assert.deepEqual(m("n:notice"), []);
  assert.deepEqual(m("c:not-listed.txt"), []);
  assert.deepEqual(menuItems("c:b.md", null, NONE_SHOWN), []);
});

test("paletteTarget (R18): the selected row, the group, or a message", () => {
  const { status: acc, entries } = shown(fixture("acceptance"));
  const target = (cmd: Parameters<typeof paletteTarget>[0], sel: string | null) => paletteTarget(cmd, sel, acc, entries);
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
  const uu = paletteTarget("toggle", "c:uu.txt", conflict.status, conflict.entries);
  assert.ok(!uu.ok && /merge conflict/.test(uu.message));
  const clean = shown(fixture("clean"));
  assert.deepEqual(paletteTarget("stageAll", null, clean.status, clean.entries), { ok: false, message: "nothing to stage" });
  assert.deepEqual(paletteTarget("unstageAll", null, clean.status, clean.entries), { ok: false, message: "nothing to unstage" });
  // Under a notice there is no status.
  for (const cmd of ["viewDiff", "viewFile", "toggle", "stageAll", "unstageAll"] as const) {
    assert.deepEqual(paletteTarget(cmd, "c:b.md", null, NONE_SHOWN), { ok: false, message: NO_ROWS }, cmd);
  }
  assert.equal(NO_ROWS, "the Git section shows no files");
});

test("menuSpec: a column of bare buttons keyed by choice; menuChoice reads them back (R17)", () => {
  const acc = shown(fixture("acceptance"));
  const items = menuItems("c:b.md", acc.status, acc.entries);
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
  for (const c of ["diff", "file", "stage", "unstage", "stageAll", "unstageAll"]) assert.equal(menuChoice(`menu:${c}`), c);
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
