import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  badges,
  commitMessageText,
  filesArgs,
  logArgs,
  messageArgs,
  parseDiffTree,
  parseLog,
  showArgs,
  UPSTREAM_ID_ARGS,
  type Commit,
} from "../lib/history.ts";
import { shortId } from "../lib/git.ts";
import { recorded } from "./helpers.ts";

const log = (name: string, n = 50, upstream: string | null = null) => parseLog(recorded(`log-${name}.z`), n, upstream);
const subjects = (cs: Commit[]) => cs.map((c) => c.subject);
const bySubject = (cs: Commit[], s: string) => cs.find((c) => c.subject === s)!;

test("logArgs: the argv record.sh records with, lock-free, one more than shown, the upstream when asked, `--` after the revisions (R11, R30)", () => {
  assert.deepEqual(logArgs(50, false), [
    "--no-optional-locks",
    "log",
    "--topo-order",
    "--no-show-signature",
    "--no-color",
    "--decorate=full",
    "--decorate-refs-exclude=refs/remotes/*/HEAD",
    "-z",
    "-n",
    "51",
    "--format=%H%x00%P%x00%D%x00%an%x00%s",
    "HEAD",
    "--",
  ]);
  assert.deepEqual(logArgs(100, true).slice(-5), ["101", "--format=%H%x00%P%x00%D%x00%an%x00%s", "HEAD", "@{upstream}", "--"]);
  // record.sh holds the same argv, so the fixtures are what the plugin reads:
  // LOG, then the revisions, then `--`.
  const script = readFileSync(new URL("./fixtures/record.sh", import.meta.url), "utf8");
  const line = script.split("\n").find((l) => l.startsWith("LOG=("))!;
  assert.equal(line, `LOG=(${logArgs(50, false).slice(0, -2).map((a) => (/[*%{]/.test(a) ? `'${a}'` : a)).join(" ")})`);
  assert.ok(script.includes(`"\${LOG[@]}" "$@" -- >`));
});

test("every revision-taking Graph read ends its revisions with `--`: a top-level file named HEAD, or as the id, is not ambiguous (R30, R32, R33)", () => {
  const id = "e".repeat(40);
  for (const argv of [logArgs(50, false), logArgs(50, true), filesArgs(id, false), filesArgs(id, true), showArgs(id), messageArgs(id)]) {
    assert.equal(argv.at(-1), "--", argv.join(" "));
    assert.equal(argv.indexOf("--"), argv.length - 1, argv.join(" "));
  }
});

test("every Graph read is lock-free or a rev-parse (R11)", () => {
  for (const argv of [logArgs(50, true), UPSTREAM_ID_ARGS, filesArgs("a".repeat(40), false), filesArgs("a".repeat(40), true), showArgs("a".repeat(40)), messageArgs("a".repeat(40))]) {
    assert.equal(argv[0], "--no-optional-locks", argv.join(" "));
  }
  assert.deepEqual(UPSTREAM_ID_ARGS, ["--no-optional-locks", "rev-parse", "--verify", "-q", "@{upstream}"]);
});

test("parseLog, A30's history: topological order, parents, badges, no origin/HEAD (R30, A30)", () => {
  const { commits, hasMore } = log("a30", 50, "origin/main");
  assert.equal(hasMore, false);
  assert.deepEqual(subjects(commits), ["c4", "M", "f2", "f1", "c3", "c2", "c1"]);
  const m = bySubject(commits, "M");
  assert.deepEqual(m.parents, [bySubject(commits, "c3").id, bySubject(commits, "f2").id]);
  assert.deepEqual(bySubject(commits, "c4").refs, [{ kind: "current", name: "main" }]);
  assert.deepEqual(m.refs, [{ kind: "upstream", name: "origin/main" }]);
  assert.deepEqual(bySubject(commits, "f2").refs, [{ kind: "local", name: "feat" }]);
  assert.deepEqual(bySubject(commits, "c2").refs, [
    { kind: "tag", name: "v1a" },
    { kind: "tag", name: "v1" },
  ]);
  assert.deepEqual(bySubject(commits, "c1").parents, []);
  assert.ok(commits.every((c) => c.author === "fixture" && /^[0-9a-f]{40}$/.test(c.id)));
  assert.ok(!commits.some((c) => c.refs.some((b) => b.name.endsWith("/HEAD"))));
  // No upstream named: origin/main is a plain remote-tracking badge.
  assert.deepEqual(bySubject(log("a30").commits, "M").refs, [{ kind: "remote", name: "origin/main" }]);
});

test("parseLog: no commit above any of its children, in every recording (R30)", () => {
  for (const name of ["line", "a30", "cross", "octopus", "diverged", "roots", "shallow", "detached", "long"]) {
    const { commits } = log(name);
    const row = new Map(commits.map((c, i) => [c.id, i]));
    for (const [i, c] of commits.entries()) for (const p of c.parents) if (row.has(p)) assert.ok(row.get(p)! > i, `${name}: ${c.subject}`);
  }
});

test("parseLog: detached HEAD, shallow boundary, octopus, diverged, two roots (R30, A30, A31)", () => {
  assert.deepEqual(log("detached").commits[0].refs, [{ kind: "head", name: "HEAD" }]);
  const shallow = log("shallow").commits;
  assert.deepEqual(shallow.at(-1)!.parents, [], "drawn as a root");
  assert.deepEqual(shallow.at(-1)!.refs, [], "`grafted` is not a ref");
  assert.deepEqual(shallow[0].refs, [
    { kind: "current", name: "main" },
    { kind: "remote", name: "origin/main" },
  ]);
  assert.equal(log("octopus").commits[0].parents.length, 4);
  const div = log("diverged", 50, "origin/main").commits;
  assert.deepEqual(subjects(div), ["local2", "local1", "remote1", "base"]);
  assert.deepEqual(bySubject(div, "remote1").refs, [{ kind: "upstream", name: "origin/main" }]);
  assert.equal(log("roots").commits.filter((c) => c.parents.length === 0).length, 2);
});

test("parseLog: pages of n, and whether more exist (R30)", () => {
  const first = log("long", 50);
  assert.equal(first.commits.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(first.commits[0].subject, "n60");
  // The recording holds 51; asking for more than that finds no more.
  const all = log("long", 100);
  assert.equal(all.commits.length, 51);
  assert.equal(all.hasMore, false);
  assert.deepEqual(parseLog("", 50, null), { commits: [], hasMore: false });
});

test("parseLog: a subject or author holding the unit or record separator keeps its commit; a cut-off last record is dropped (R30, INV §8 P43 a)", () => {
  const raw = recorded("log-line.z").replace("fixture\0c5\0", "fix\x1fture\0c\x1f5\x1e\0");
  const { commits } = parseLog(raw, 50, null);
  assert.deepEqual(subjects(commits), ["c\x1f5\x1e", "c4", "c3", "c2", "c1"]);
  assert.equal(commits[0].author, "fix\x1fture");
  assert.deepEqual(commits[0].parents, [commits[1].id]);
  assert.deepEqual(subjects(parseLog(raw.slice(0, -1), 50, null).commits), ["c\x1f5\x1e", "c4", "c3", "c2"]);
});

test("badges: only refs; a remote's HEAD and anything else dropped (R30, INV §8 P39 e)", () => {
  assert.deepEqual(badges("", null), []);
  assert.deepEqual(badges("grafted", null), []);
  assert.deepEqual(badges("refs/stash", null), []);
  assert.deepEqual(badges("HEAD, refs/remotes/origin/HEAD, refs/remotes/up/main", "up/main"), [
    { kind: "head", name: "HEAD" },
    { kind: "upstream", name: "up/main" },
  ]);
  // A branch named like a tag is still a branch.
  assert.deepEqual(badges("refs/heads/tag: x", null), [{ kind: "local", name: "tag: x" }]);
});

test("filesArgs: against the first parent, or the empty tree for a root (R32, INV §8 P39 f)", () => {
  const id = "b".repeat(40);
  assert.deepEqual(filesArgs(id, false), ["--no-optional-locks", "diff-tree", "-r", "-z", "--raw", "-M", `${id}^1`, id, "--"]);
  assert.deepEqual(filesArgs(id, true), ["--no-optional-locks", "diff-tree", "-r", "-z", "--raw", "-M", "--root", "--no-commit-id", id, "--"]);
  // record.sh records with the same argv.
  const script = readFileSync(new URL("./fixtures/record.sh", import.meta.url), "utf8");
  assert.ok(script.includes(`DT=(${filesArgs(id, false).slice(0, -3).join(" ")})\n`));
  assert.ok(script.includes(`"$id^1" "$id" -- >`));
  assert.ok(script.includes(`--root --no-commit-id "$(git -C "$d" rev-parse HEAD)" -- >`));
});

test("parseDiffTree: every recorded kind of change (R32, A32)", () => {
  const dt = (name: string) => parseDiffTree(recorded(`difftree-${name}.z`));
  assert.deepEqual(dt("add"), [{ path: "dir/added.txt", marker: "A" }]);
  assert.deepEqual(dt("rename"), [
    { path: "dir/after.txt", marker: "R", orig: "before.txt" },
    { path: "one.txt", marker: "M" },
  ]);
  assert.deepEqual(dt("copy"), [
    { path: "copy.txt", marker: "C", orig: "orig.txt" },
    { path: "orig.txt", marker: "M" },
  ]);
  // The plugin's -M finds no copies: an add.
  assert.deepEqual(dt("copy-m"), [
    { path: "copy.txt", marker: "A" },
    { path: "orig.txt", marker: "M" },
  ]);
  assert.deepEqual(dt("delete"), [{ path: "two.txt", marker: "D" }]);
  assert.deepEqual(dt("gitlink"), [{ path: "sub", marker: "A", dir: true }]);
  assert.deepEqual(dt("symlink"), [{ path: "link", marker: "A" }]);
  assert.deepEqual(dt("typechange"), [
    { path: "sub", marker: "D", dir: true },
    { path: "typechange", marker: "T" },
  ]);
  assert.deepEqual(dt("merge"), [
    { path: "f1.txt", marker: "A" },
    { path: "f2.txt", marker: "A" },
  ]);
  const root = dt("root");
  assert.ok(root.length === 6 && root.every((e) => e.marker === "A"));
  assert.deepEqual(parseDiffTree(""), []);
});

test("showArgs, `--root` whatever log.showRoot says, and the recorded show of a merge and of a root commit (R33, A33)", () => {
  assert.deepEqual(showArgs("c".repeat(40)), [
    "--no-optional-locks",
    "show",
    "--no-color",
    "--no-show-signature",
    "--format=fuller",
    "--stat",
    "--patch",
    "--first-parent",
    "--root",
    "c".repeat(40),
    "--",
  ]);
  // record.sh shows with the same options.
  const script = readFileSync(new URL("./fixtures/record.sh", import.meta.url), "utf8");
  assert.ok(script.includes(`SHOW=(${showArgs("c").slice(0, -2).join(" ")})\n`));
  const merge = recorded("show-merge.txt");
  assert.match(merge, /^commit [0-9a-f]{40}\nMerge: [0-9a-f]{7} [0-9a-f]{7}\n/);
  assert.match(merge, /AuthorDate: .*\nCommit: .*\nCommitDate: /);
  assert.match(merge, /\n 2 files changed, 2 insertions\(\+\)\n/);
  assert.match(merge, /\n\+\+\+ b\/f1\.txt\n/);
  const root = recorded("show-root.txt");
  assert.match(root, /--- \/dev\/null\n\+\+\+ b\/c1\.txt\n@@ -0,0 \+1 @@\n\+c1\n/);
});

test("messageArgs, the message and the short id (R33)", () => {
  assert.deepEqual(messageArgs("d".repeat(40)), ["--no-optional-locks", "log", "-1", "--no-show-signature", "--format=%B", "d".repeat(40), "--"]);
  assert.equal(commitMessageText("subject\n\nbody line\n\n"), "subject\n\nbody line");
  assert.equal(shortId("0123456789abcdef"), "0123456");
});
