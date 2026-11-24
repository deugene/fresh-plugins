import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  CHUNK_BYTES,
  utf8Length,
  classifyWrite,
  LITERAL,
  OpQueue,
  passable,
  skippedMessage,
  stageAllPlan,
  stageArgs,
  unstageAllPlan,
  unstageArgs,
  type GroupPlan,
} from "../lib/stage.ts";
import type { GitResult } from "../lib/git.ts";
import { parseStatus } from "../lib/status.ts";
import { H, manyUntracked, mod, pathsOf, raw, status, untracked } from "./helpers.ts";

const bytes = (paths: string[]) => paths.reduce((t, p) => t + new TextEncoder().encode(p).length + 1, 0);
/** Each command's argv, checking the path count it carries. */
function argvs(plan: GroupPlan): string[][] {
  for (const c of plan.commands) assert.equal(c.paths, pathsOf(c.args).length, c.args.join(" "));
  return plan.commands.map((c) => c.args);
}

const res = (code: number, stderr = "", timedOut = false): GitResult => ({ code, stdout: "", stderr, timedOut });

const REMOVE = [LITERAL, "update-index", "--remove", "--"];

test("stage and unstage arguments: literal paths, and a rename's original path (R15, INV §9.5)", () => {
  assert.deepEqual(stageArgs({ path: "b.md", marker: "M" }), [[LITERAL, "add", "--", "b.md"]]);
  assert.deepEqual(stageArgs({ path: "a*", marker: "U" }), [[LITERAL, "add", "--", "a*"]]);
  // A Changes rename onto an intent-to-add path (`.R`): the original, which
  // is deleted, is removed first; then the new path is added.
  assert.deepEqual(stageArgs({ path: "new.txt", marker: "R", orig: "was.txt" }), [
    [...REMOVE, "was.txt"],
    [LITERAL, "add", "--", "new.txt"],
  ]);
  assert.deepEqual(unstageArgs({ path: "a.ts", marker: "M" }), [[LITERAL, "reset", "-q", "--", "a.ts"]]);
  assert.deepEqual(unstageArgs({ path: "moved.ts", marker: "R", orig: "old.ts" }), [[LITERAL, "reset", "-q", "--", "moved.ts", "old.ts"]]);
  assert.equal(LITERAL, "--literal-pathspecs");
});

test("a deletion stages with `update-index --remove`, which leaves what is now under its path alone (R15, F1, INV §8 P23)", () => {
  assert.deepEqual(stageArgs({ path: "gone.ts", marker: "D" }), [[...REMOVE, "gone.ts"]]);
  // The recorded state: `foo` deleted and now a directory with `foo/x` and a nested repository.
  const st = status("deleted-dir");
  const foo = st.changes.find((e) => e.path === "foo")!;
  assert.equal(foo.marker, "D");
  assert.deepEqual(stageArgs(foo), [[...REMOVE, "foo"]]);
  // Stage all: the deletion first, in its own command; the nested repository skipped.
  const plan = stageAllPlan(st);
  assert.deepEqual(argvs(plan), [
    [...REMOVE, "foo"],
    [LITERAL, "add", "-A", "--", "foo/x"],
  ]);
  assert.equal(plan.paths, 2);
  assert.deepEqual(plan.skipped, { conflicted: 0, dirs: 1, names: 0 });
});

test("a Changes rename's original path is a deletion: never given to `add`, even under stage all (R15, R16, INV §8 P23 e)", () => {
  // `bar` is `foo` renamed and marked intent-to-add; `foo` is now a directory
  // with an untracked file and a nested repository.
  const records = [`2 .R N... 100644 100644 100644 ${H} ${H} R100 bar`, "foo", untracked("foo/sub/"), untracked("foo/x")];
  const st = parseStatus(raw({ records }));
  const bar = st.changes.find((e) => e.path === "bar")!;
  assert.deepEqual(stageArgs(bar), [
    [...REMOVE, "foo"],
    [LITERAL, "add", "--", "bar"],
  ]);
  const plan = stageAllPlan(st);
  assert.deepEqual(argvs(plan), [
    [...REMOVE, "foo"],
    [LITERAL, "add", "-A", "--", "bar", "foo/x"],
  ]);
  assert.equal(plan.paths, 3);
  assert.deepEqual(plan.skipped, { conflicted: 0, dirs: 1, names: 0 });
});

test("stage all: deletions in 16 KiB `update-index --remove` chunks before the adds, every path once (R16, F1)", () => {
  const records: string[] = [];
  for (let i = 0; i < 600; i++) records.push(mod(".D", `some/fairly/deep/directory/gone-${String(i).padStart(4, "0")}.txt`));
  records.push(...manyUntracked(600, "some/fairly/deep/directory/new-"));
  const plan = stageAllPlan(parseStatus(raw({ records })));
  const commands = argvs(plan);
  const kinds = commands.map((c) => c.slice(1, c.indexOf("--")).join(" "));
  const firstAdd = kinds.indexOf("add -A");
  assert.ok(firstAdd > 1, "more than one removal chunk");
  assert.ok(kinds.slice(0, firstAdd).every((k) => k === "update-index --remove"));
  assert.ok(kinds.slice(firstAdd).every((k) => k === "add -A"));
  for (const c of commands) assert.ok(bytes(pathsOf(c)) <= CHUNK_BYTES);
  const removed = commands.slice(0, firstAdd).flatMap(pathsOf);
  assert.equal(removed.length, 600);
  assert.ok(removed.every((p) => p.includes("/gone-")));
  assert.equal(commands.flatMap(pathsOf).length, 1200);
  assert.equal(plan.paths, 1200);
});

test("a copy touches only its new path; a rename both (R15, R16, F2)", () => {
  // Staged: unstaging a copy leaves its source's own change staged.
  assert.deepEqual(unstageArgs({ path: "copy.txt", marker: "C", orig: "orig.txt" }), [[LITERAL, "reset", "-q", "--", "copy.txt"]]);
  // Changes (a copy onto an intent-to-add path): only the new path.
  assert.deepEqual(stageArgs({ path: "copy.txt", marker: "C", orig: "orig.txt" }), [[LITERAL, "add", "--", "copy.txt"]]);
  const copyOnly = [`2 C. N... 100644 100644 100644 ${H} ${H} C100 copy.txt`, "orig.txt", mod("M.", "other.txt")];
  assert.deepEqual(argvs(unstageAllPlan(parseStatus(raw({ records: copyOnly })))), [[LITERAL, "reset", "-q", "--", "copy.txt", "other.txt"]]);
  const dotC = [`2 .C N... 100644 100644 100644 ${H} ${H} C100 copy.txt`, "orig.txt"];
  assert.deepEqual(argvs(stageAllPlan(parseStatus(raw({ records: dotC })))), [[LITERAL, "add", "-A", "--", "copy.txt"]]);
  // The recorded copy, whose source is staged too: each once.
  assert.deepEqual(argvs(unstageAllPlan(status("copy"))), [[LITERAL, "reset", "-q", "--", "copy.txt", "orig.txt"]]);
});

test("names git can't pass back (U+FFFD from a lossy status) are skipped and counted (R16, F6)", () => {
  const bad = "caf\uFFFD.txt";
  const records = [
    untracked(bad),
    mod(".D", `gone-\uFFFD.txt`),
    mod(".M", "ok.txt"),
    mod("M.", bad),
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 renamed.txt`,
    `was-\uFFFD.txt`,
    mod("M.", "staged.txt"),
  ];
  const st = parseStatus(raw({ records }));
  const stage = stageAllPlan(st);
  assert.deepEqual(argvs(stage), [[LITERAL, "add", "-A", "--", "ok.txt"]]);
  assert.deepEqual(stage.skipped, { conflicted: 0, dirs: 0, names: 2 });
  const unstage = unstageAllPlan(st);
  // A rename whose original is such a name goes too: both or neither.
  assert.deepEqual(argvs(unstage), [[LITERAL, "reset", "-q", "--", "staged.txt"]]);
  assert.deepEqual(unstage.skipped, { conflicted: 0, dirs: 0, names: 2 });
  assert.equal(passable({ path: bad, marker: "U" }), false);
  assert.equal(passable({ path: "renamed.txt", marker: "R", orig: "was-\uFFFD.txt" }), false);
  // A copy names only its new path.
  assert.equal(passable({ path: "copy.txt", marker: "C", orig: "was-\uFFFD.txt" }), true);
  assert.equal(passable({ path: "naïve → é.txt", marker: "M" }), true);
});

test("classifyWrite follows P13: rc 0 is success even with `needs merge`; otherwise git's first line", () => {
  assert.deepEqual(classifyWrite(res(0)), { ok: true });
  assert.deepEqual(classifyWrite(res(0, "uu.txt: needs merge\n")), { ok: true });
  assert.deepEqual(classifyWrite(res(128, "fatal: Unable to create '/r/.git/index.lock': File exists.\n\nAnother git process...\n")), {
    ok: false,
    reason: "Unable to create '/r/.git/index.lock': File exists.",
  });
  assert.deepEqual(classifyWrite(res(128, "fatal: pathspec 'vanished.txt' did not match any files\n")), {
    ok: false,
    reason: "pathspec 'vanished.txt' did not match any files",
  });
  // git's own tag goes: the message around the reason says what failed.
  assert.deepEqual(classifyWrite(res(128, "error: external filter 'f' failed 1\nerror: slow.txt: clean filter 'f' failed\n")), {
    ok: false,
    reason: "external filter 'f' failed 1",
  });
  // With the root git ran in, paths inside it read relative to it.
  const lock = res(128, "fatal: Unable to create '/w/repo/.git/index.lock': File exists.\n");
  assert.deepEqual(classifyWrite(lock, "/w/repo"), { ok: false, reason: "Unable to create '.git/index.lock': File exists." });
  assert.deepEqual(classifyWrite(lock, "/w/repo/"), { ok: false, reason: "Unable to create '.git/index.lock': File exists." });
  // A path outside it stays absolute: a sibling with the same prefix, a linked worktree's git dir.
  assert.deepEqual(classifyWrite(res(128, "fatal: Unable to create '/w/repo2/.git/index.lock': File exists.\n"), "/w/repo"), {
    ok: false,
    reason: "Unable to create '/w/repo2/.git/index.lock': File exists.",
  });
  assert.deepEqual(classifyWrite(res(128, "fatal: Unable to create '/w/main/.git/worktrees/wt/index.lock': File exists.\n"), "/w/wt"), {
    ok: false,
    reason: "Unable to create '/w/main/.git/worktrees/wt/index.lock': File exists.",
  });
  // Nor does a path that only contains the root further in.
  assert.deepEqual(classifyWrite(res(128, "fatal: Unable to create '/x/w/repo/.git/index.lock': File exists.\n"), "/w/repo"), {
    ok: false,
    reason: "Unable to create '/x/w/repo/.git/index.lock': File exists.",
  });
  // A repository at the filesystem root: nothing to strip.
  assert.deepEqual(classifyWrite(res(128, "fatal: Unable to create '/.git/index.lock': File exists.\n"), "/"), {
    ok: false,
    reason: "Unable to create '/.git/index.lock': File exists.",
  });
  // Only a leading tag, and only those two.
  assert.deepEqual(classifyWrite(res(1, "warning: x\n")), { ok: false, reason: "warning: x" });
  assert.deepEqual(classifyWrite(res(128, "fatal: 'error: x' is not a commit\n")), { ok: false, reason: "'error: x' is not a commit" });
  assert.deepEqual(classifyWrite(res(1)), { ok: false, reason: "git exited with 1" });
  // A spawn failure: its error is the reason.
  assert.deepEqual(classifyWrite(res(-1, "Error: spawn git ENOENT")), { ok: false, reason: "Error: spawn git ENOENT" });
});

test("OpQueue: one write at a time, in order; a key is held until a refresh after it is drawn or fails (R15)", async () => {
  const log: string[] = [];
  let done = 0;
  const q = new OpQueue(() => done++);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const a = q.enqueue("c:a", async () => {
    log.push("a start");
    await gate;
    log.push("a end");
  });
  const b = q.enqueue("c:b", async () => {
    log.push("b");
  });
  assert.ok(a && b);
  assert.equal(q.enqueue("c:a", async () => void log.push("a again")), null, "queued or running: dropped");
  assert.equal(q.enqueue("c:b", async () => void log.push("b again")), null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ["a start"]);
  release();
  await b;
  assert.deepEqual(log, ["a start", "a end", "b"]);
  assert.equal(done, 2);
  assert.equal(q.writeSeq, 2);
  // Finished but not yet drawn: still dropped.
  assert.equal(q.enqueue("c:a", async () => undefined), null);
  // A refresh that started before b finished does not release b.
  q.release(1);
  assert.ok(!q.blocked("c:a"));
  assert.ok(q.blocked("c:b"));
  q.release(2);
  assert.ok(!q.blocked("c:b"));
});

test("OpQueue: a throwing op or callback does not stop the queue", async () => {
  const q = new OpQueue(() => {
    throw new Error("boom");
  });
  const a = q.enqueue("x", async () => {
    throw new Error("op failed");
  });
  let ran = false;
  const b = q.enqueue("y", async () => {
    ran = true;
  });
  await a;
  await b;
  assert.ok(ran);
  assert.equal(q.writeSeq, 2);
});

test("stage all over 1,200 untracked files: every path exactly once, no command over 16 KiB of paths (R16)", () => {
  const plan = stageAllPlan(parseStatus(raw({ records: manyUntracked(1200, "some/fairly/deep/directory/file-") })));
  const commands = argvs(plan);
  assert.ok(commands.length > 1, "chunked");
  const all = commands.flatMap(pathsOf);
  assert.equal(all.length, 1200);
  assert.equal(new Set(all).size, 1200);
  assert.equal(plan.paths, 1200);
  for (const c of commands) {
    assert.deepEqual(c.slice(0, 4), [LITERAL, "add", "-A", "--"]);
    assert.ok(bytes(pathsOf(c)) <= CHUNK_BYTES, `${bytes(pathsOf(c))} bytes`);
  }
});

test("merge in progress: stage all skips the UU path; unstage all lists paths, never a bare reset or :/ (R16)", () => {
  const merge = status("merge");
  const stage = stageAllPlan(merge);
  assert.deepEqual(argvs(stage), []);
  assert.deepEqual(stage.skipped, { conflicted: 1, dirs: 0, names: 0 });
  const unstage = unstageAllPlan(merge);
  assert.deepEqual(argvs(unstage), [[LITERAL, "reset", "-q", "--", "s.txt"]]);
  const acc = unstageAllPlan(status("acceptance"));
  assert.deepEqual(argvs(acc), [[LITERAL, "reset", "-q", "--", "a.ts", "moved.ts", "old.ts"]]);
  for (const c of [...argvs(unstage), ...argvs(acc), ...argvs(stageAllPlan(status("acceptance")))]) {
    assert.ok(!c.includes(":/"));
    assert.ok(pathsOf(c).length > 0, "never without paths");
    assert.equal(c[0], LITERAL);
  }
});

test("stage all skips directories, removes a `.R`'s original, and passes `*` as one literal argument (R16)", () => {
  const records = [
    untracked("*"),
    untracked("vendor/lib/"),
    `1 .M S.M. 160000 160000 160000 ${H} ${H} sub`,
    `2 .R N... 100644 100644 100644 ${H} ${H} R100 new.txt`,
    "was.txt",
    mod(".M", "b.md"),
  ];
  const plan = stageAllPlan(parseStatus(raw({ records })));
  assert.deepEqual(argvs(plan), [
    [...REMOVE, "was.txt"],
    [LITERAL, "add", "-A", "--", "*", "b.md", "new.txt"],
  ]);
  assert.deepEqual(plan.skipped, { conflicted: 0, dirs: 2, names: 0 });
  assert.equal(plan.paths, 4);
});

test("chunk keeps a rename pair together and each path once", () => {
  const long = (i: number) => `${"d/".repeat(30)}${"x".repeat(100)}-${i}`;
  const groups = Array.from({ length: 200 }, (_, i) => [long(i), `${long(i)}.orig`]);
  const chunks = chunk(groups);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(bytes(c) <= CHUNK_BYTES);
    for (let i = 0; i < c.length; i += 2) assert.equal(c[i + 1], `${c[i]}.orig`, "pair split");
  }
  assert.equal(chunks.flat().length, 400);
  // A single group over the limit still runs, on its own.
  assert.deepEqual(chunk([["a"], ["b".repeat(50)], ["c"]], 10), [["a"], ["b".repeat(50)], ["c"]]);
  assert.deepEqual(chunk([]), []);
  // Unstage all keeps a staged rename's pair in one command.
  const staged = Array.from({ length: 150 }, (_, i) => [`2 R. N... 100644 100644 100644 ${H} ${H} R100 ${long(i)}`, `${long(i)}.orig`]).flat();
  const un = unstageAllPlan(parseStatus(raw({ records: staged })));
  assert.ok(un.commands.length > 1);
  for (const c of argvs(un)) {
    const ps = pathsOf(c);
    for (let i = 0; i < ps.length; i += 2) assert.equal(ps[i + 1], `${ps[i]}.orig`);
  }
});

test("utf8Length matches the real encoding (no TextEncoder in Fresh's runtime)", () => {
  for (const t of ["", "abc", "naïve", "ünï cødé.md", "→", "😀 x", "dir with space/naïve → renamed.txt", "\u07ff\u0800\uffff"]) {
    assert.equal(utf8Length(t), Buffer.byteLength(t, "utf8"), t);
  }
  // A lone surrogate encodes as U+FFFD, 3 bytes; a pair is one 4-byte code point.
  for (const t of ["\ud83d", "\ude00", "a\ud83db", "\ude00\ud83d", "\ud83d\ud83d\ude00"]) {
    assert.equal(utf8Length(t), Buffer.byteLength(t, "utf8"), JSON.stringify(t));
  }
  assert.equal(utf8Length("\ud83d"), 3);
});

test("skippedMessage: what a group operation left out, with its count and pluralisation (R16)", () => {
  assert.equal(skippedMessage({ conflicted: 0, dirs: 0, names: 0 }), null);
  assert.equal(skippedMessage({ conflicted: 1, dirs: 0, names: 0 }), "skipped 1: 1 with a merge conflict (resolve with git first)");
  assert.equal(skippedMessage({ conflicted: 0, dirs: 1, names: 1 }), "skipped 2: 1 directory (submodule or nested repository), 1 name git can't pass back (not UTF-8)");
  assert.equal(
    skippedMessage({ conflicted: 2, dirs: 3, names: 4 }),
    "skipped 9: 2 with a merge conflict (resolve with git first), 3 directories (submodule or nested repository), 4 names git can't pass back (not UTF-8)",
  );
});
