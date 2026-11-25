import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphState } from "../lib/graph_state.ts";
import type { Handle, Runner } from "../lib/git.ts";
import { commitKey, GRAPH_KEY, graphKind, LOAD_MORE_KEY } from "../lib/graph.ts";
import { parseLog } from "../lib/history.ts";
import { parseStatus } from "../lib/status.ts";
import { raw, recorded, status as fixture } from "./helpers.ts";

type Result = { code: number; stdout: string; stderr: string };

/** A runner that answers each git argv from `answer`, records every argv,
 *  and lets a test hold a run open (`hold`). */
function scripted(answer: (args: string[]) => Result) {
  const calls: string[][] = [];
  let held: ((r: Result) => void) | null = null;
  let holdNext = false;
  const runner: Runner = {
    runOnTarget: (_p: string, args: string[]) => {
      calls.push(args);
      const r = answer(args);
      const settled = holdNext ? new Promise<Result>((res) => (held = res)) : Promise.resolve(r);
      holdNext = false;
      const h: Handle = { then: (a, b) => settled.then(a, b), kill: async () => true };
      return h;
    },
    spawnHostProcess: () => {
      throw new Error("not in local mode");
    },
    delay: () => new Promise<void>(() => {}),
  };
  return {
    runner,
    calls,
    hold: () => (holdNext = true),
    release: (r: Result) => held?.(r),
  };
}

const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: "" });
const A30_LOG = recorded("log-a30.z");
const LONG_LOG = recorded("log-long.z");
const UP = "1".repeat(40);
const A30 = parseLog(A30_LOG, 50, "origin/main").commits;
const bySubject = (s: string): string => A30.find((c) => c.subject === s)!.id;

/** The repository's answers: the log, the upstream's id, and files. */
function repo(opts: { log?: string; upstream?: string | null; logCode?: number; files?: Result } = {}) {
  return (args: string[]): Result => {
    if (args[1] === "rev-parse") return opts.upstream === null ? { code: 1, stdout: "", stderr: "" } : ok(`${opts.upstream ?? UP}\n`);
    if (args[1] === "log") return opts.logCode ? { code: opts.logCode, stdout: "", stderr: "fatal: bad" } : ok(opts.log ?? A30_LOG);
    if (args[1] === "diff-tree") return opts.files ?? ok(recorded("difftree-merge.z"));
    return { code: 127, stdout: "", stderr: "unexpected" };
  };
}

const STATUS = parseStatus(raw({ ab: "+1 -0" }));
const logs = (calls: string[][]) => calls.filter((a) => a[1] === "log");

/** The ids of the commits `g` lists, by its rows' keys. */
const listedIds = (g: GraphState): string[] =>
  g.part(new Set()).keys.flatMap((k) => {
    const kind = graphKind(k);
    return kind?.kind === "commit" ? [kind.id] : [];
  });

function make(answer = repo(), live = () => true) {
  const s = scripted(answer);
  const said: string[] = [];
  const g = new GraphState({ runner: s.runner, live, say: (m) => said.push(m) });
  return { g, s, said };
}

test("the log runs once per trigger; the upstream's id is read each time (R11, R30)", async () => {
  const { g, s } = make();
  assert.equal(await g.afterStatus(STATUS, "local", "/repo", 0, true), true);
  assert.equal(g.size, 7);
  assert.equal(await g.afterStatus(STATUS, "local", "/repo", 0, true), false);
  assert.equal(logs(s.calls).length, 1);
  assert.equal(s.calls.filter((a) => a[1] === "rev-parse").length, 2);
  // The log names the upstream only when it exists (`ab`).
  assert.deepEqual(logs(s.calls)[0].slice(-3), ["HEAD", "@{upstream}", "--"]);
});

test("a branch switch at the same commit, or the upstream moving with the counts the same, reads the log again (R30)", async () => {
  let upstream = UP;
  const { g, s } = make((args) => repo({ upstream })(args));
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  await g.afterStatus(parseStatus(raw({ ab: "+1 -0", branch: "other" })), "local", "/repo", 0, true);
  assert.equal(logs(s.calls).length, 2);
  upstream = "2".repeat(40);
  await g.afterStatus(parseStatus(raw({ ab: "+1 -0", branch: "other" })), "local", "/repo", 0, true);
  assert.equal(logs(s.calls).length, 3);
  // A new HEAD, and new counts, too.
  await g.afterStatus(parseStatus(raw({ ab: "+2 -0", branch: "other" })), "local", "/repo", 0, true);
  assert.equal(logs(s.calls).length, 4);
  // No upstream: no rev-parse, and the log names HEAD only.
  const none = make();
  await none.g.afterStatus(parseStatus(raw({ ab: null })), "local", "/repo", 0, true);
  assert.deepEqual(none.s.calls.map((a) => a[1]), ["log"]);
  assert.deepEqual(logs(none.s.calls)[0].slice(-2), ["HEAD", "--"]);
});

test("while the Graph group is collapsed no git runs; expanding it forces a read (R11)", async () => {
  const { g, s } = make();
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  s.calls.length = 0;
  assert.equal(await g.afterStatus(STATUS, "local", "/repo", 0, false), false);
  assert.deepEqual(s.calls, []);
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  assert.equal(logs(s.calls).length, 1, "forced although nothing moved");
});

test("an unborn branch empties the Graph with no git (R30)", async () => {
  const { g, s } = make();
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  s.calls.length = 0;
  assert.equal(await g.afterStatus(fixture("unborn"), "local", "/repo", 0, true), true);
  assert.equal(g.size, 0);
  assert.deepEqual(g.part(new Set()).keys, []);
  assert.deepEqual(s.calls, []);
  assert.equal(await g.afterStatus(fixture("unborn"), "local", "/repo", 0, true), false, "already empty");
});

test("a failed log keeps the last good Graph and records no trigger (R10)", async () => {
  let logCode = 0;
  const { g, s } = make((args) => repo({ logCode })(args));
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  logCode = 128;
  g.forceNext();
  assert.equal(await g.afterStatus(STATUS, "local", "/repo", 0, true), false);
  assert.equal(g.size, 7);
  // Tried again on the next status, although nothing moved.
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  assert.equal(logs(s.calls).length, 3);
});

test("an empty log on a born branch is a failed log: output that is not UTF-8 through spawnHostProcess (R10, INV §8 P17)", async () => {
  let log = A30_LOG;
  const { g, s } = make((args) => repo({ log })(args));
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  assert.equal(g.size, 7);
  // A Latin-1 author: rc 0 and "" (P17). The last good Graph stays.
  log = "";
  g.forceNext();
  assert.equal(await g.afterStatus(STATUS, "local", "/repo", 0, true), false);
  assert.equal(g.size, 7);
  // No trigger recorded: the next status reads again although nothing moved.
  log = A30_LOG;
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  assert.equal(logs(s.calls).length, 3);
  assert.equal(g.size, 7);
});

test("no git once the step is stale: before the upstream read, and between it and the log (R28)", async () => {
  let alive = false;
  const { g, s } = make(repo(), () => alive);
  assert.equal(await g.afterStatus(STATUS, "local", "/repo", 0, true), false);
  assert.deepEqual(s.calls, []);
  alive = true;
  s.hold();
  const p = g.afterStatus(STATUS, "local", "/repo", 0, true);
  await Promise.resolve();
  alive = false;
  s.release(ok(`${UP}\n`));
  assert.equal(await p, false);
  assert.deepEqual(s.calls.map((a) => a[1]), ["rev-parse"], "no log after a stale rev-parse");
});

test("Load more: one page more, a second ask ignored while loading, then the first new commit selected (R30)", async () => {
  const { g, s } = make(repo({ log: LONG_LOG }));
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  assert.equal(g.size, 50);
  assert.equal(g.part(new Set()).keys.at(-1), LOAD_MORE_KEY);
  assert.equal(g.loadMore(), true);
  assert.equal(g.loadMore(), false, "a double click loads one page");
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  assert.deepEqual(logs(s.calls).map((a) => a[a.indexOf("-n") + 1]), ["51", "101"]);
  assert.equal(g.size, 51);
  assert.equal(g.takeSelection(), g.part(new Set()).keys[50]);
  assert.equal(g.takeSelection(), null, "once");
  // No Load more row now, and nothing more to load.
  assert.ok(!g.part(new Set()).keys.includes(LOAD_MORE_KEY));
  assert.equal(g.loadMore(), false);
});

test("Load more during a log read: that read used the old page, so the next one loads exactly one more and selects its first new commit (R30)", async () => {
  // No upstream: the log is the first run, so `hold` holds it.
  const noUpstream = parseStatus(raw({ ab: null }));
  const { g, s } = make(repo({ log: LONG_LOG }));
  await g.afterStatus(noUpstream, "local", "/repo", 0, true);
  assert.equal(g.size, 50);
  // A refresh with its log in flight (a forced one: the window active again).
  g.forceNext();
  s.hold();
  const p = g.afterStatus(noUpstream, "local", "/repo", 0, true);
  // Load more is clicked while it reads, with the old page count.
  assert.equal(g.loadMore(), true);
  s.release(ok(LONG_LOG));
  await p;
  assert.equal(g.size, 50, "the read in flight asked for the old page");
  assert.equal(g.takeSelection(), null, "nothing selected from it");
  assert.equal(g.loadMore(), false, "still loading: a second click loads no third page");
  // The refresh Load more asked for reads with the new page, although the
  // trigger did not move.
  await g.afterStatus(noUpstream, "local", "/repo", 0, true);
  assert.deepEqual(logs(s.calls).map((a) => a[a.indexOf("-n") + 1]), ["51", "51", "101"]);
  assert.equal(g.size, 51);
  assert.equal(g.takeSelection(), g.part(new Set()).keys[50]);
  // Done: nothing more is read while nothing moves.
  await g.afterStatus(noUpstream, "local", "/repo", 0, true);
  assert.equal(logs(s.calls).length, 3);
});

test("files: read lazily once, a second expand while reading joins it, a failure says git's reason (R32)", async () => {
  let files: Result = ok(recorded("difftree-merge.z"));
  const { g, s, said } = make((args) => repo({ files })(args));
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  const id = bySubject("M");
  const p1 = g.ensureFiles(id, "local", "/repo", 0);
  const p2 = g.ensureFiles(id, "local", "/repo", 0);
  assert.deepEqual(await Promise.all([p1, p2]), [true, false]);
  assert.equal(s.calls.filter((a) => a[1] === "diff-tree").length, 1);
  assert.deepEqual(s.calls.find((a) => a[1] === "diff-tree")!.slice(-3), [`${id}^1`, id, "--"], "a merge against its first parent");
  assert.equal(await g.ensureFiles(id, "local", "/repo", 0), false, "read already");
  const part = g.part(new Set([commitKey(id)]));
  assert.deepEqual(part.keys.slice(part.keys.indexOf(commitKey(id)) + 1, part.keys.indexOf(commitKey(id)) + 3), [`hf:${id}:f1.txt`, `hf:${id}:f2.txt`]);
  // A failure: no rows, git's reason; expanding again retries.
  files = { code: 128, stdout: "", stderr: "fatal: bad object" };
  const root = bySubject("c1");
  assert.equal(await g.ensureFiles(root, "local", "/repo", 0), true);
  assert.deepEqual(said, [`could not list the files of ${root.slice(0, 7)}: bad object`]);
  assert.ok(s.calls.find((a) => a.at(-2) === root && a[1] === "diff-tree")!.includes("--root"), "a root commit against the empty tree");
  files = ok(recorded("difftree-root.z"));
  assert.equal(await g.ensureFiles(root, "local", "/repo", 0), true);
  // Not listed: nothing to read.
  assert.equal(await g.ensureFiles("f".repeat(40), "local", "/repo", 0), false);
});

test("prune: unlisted commits lose their expansion and files; unexpanded ones their files (R32)", async () => {
  const { g } = make();
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  const [first, second] = listedIds(g);
  await g.ensureFiles(first, "local", "/repo", 0);
  await g.ensureFiles(second, "local", "/repo", 0);
  const expanded = new Set([GRAPH_KEY, commitKey(first), commitKey("f".repeat(40))]);
  assert.equal(g.prune(expanded), true, "an expansion dropped");
  assert.deepEqual([...expanded], [GRAPH_KEY, commitKey(first)]);
  assert.equal(g.prune(expanded), false, "nothing more to drop");
  assert.deepEqual(g.unread(expanded), []);
  assert.deepEqual(g.unread(new Set([commitKey(second)])), [second], "its files were dropped");
});

test("every Graph argv is lock-free or a rev-parse (R11)", async () => {
  const { g, s } = make(repo({ log: LONG_LOG }));
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  g.loadMore();
  await g.afterStatus(STATUS, "local", "/repo", 0, true);
  await g.ensureFiles(listedIds(g)[0], "local", "/repo", 0);
  assert.ok(s.calls.length >= 4);
  for (const a of s.calls) assert.equal(a[0], "--no-optional-locks", a.join(" "));
});
