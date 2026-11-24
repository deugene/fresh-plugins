import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deferred, FakeEditor, panelOf, type ProcCall, type ProcOutcome, type ProcResult } from "./fake_editor.ts";
import { rowKind, UNKNOWN_NOTICE, VOLUME_NOTICE, type TreeSpec } from "../lib/view.ts";
import { NOT_SHOWN, NOTHING_SELECTED } from "../lib/actions.ts";
import { DIFF_HINT } from "../lib/diff.ts";
import { COMMIT_BUSY } from "../lib/stage.ts";
import { fixture, GS_VOLUME, H, inspectResult, manyUntracked, mod, pathsOf, pwdResult, raw, texts, untracked } from "./helpers.ts";

const ACCEPTANCE = fixture("acceptance");
const BIND_PWD = pwdResult("/workspaces/repo");
const BIND_INSPECT = inspectResult({ Type: "bind", Source: "/repo", Destination: "/workspaces/repo" });
const VOLUME_PWD = pwdResult("/workspaces/gs");
const VOLUME_INSPECT = inspectResult({ Type: "bind", Source: "/Users", Destination: "/Users" }, GS_VOLUME);

let fake: FakeEditor;
let rejections: unknown[] = [];
const onRejection = (e: unknown) => rejections.push(e);
let loads = 0;

/** A repository at /repo (or `root`) whose `git status` prints `state.status`. */
interface Repo {
  status: string;
  code: number;
  /** Its top level, as `rev-parse --show-toplevel` prints it (default /repo). */
  root?: string;
  revParseCode?: number;
  /** `pwd` in the container: its workspace folder. */
  pwd?: ProcOutcome;
  inspect?: ProcOutcome;
  statusOutcome?: () => ProcOutcome;
  /** `git cat-file` objects by spec (`:0:<p>`, `HEAD:<p>`); others are
   *  absent (rc 128). */
  blobs?: Record<string, string>;
  /** `cat-file -s` sizes that differ from the content's length. */
  blobSizes?: Record<string, number>;
  /** A write (`--literal-pathspecs …`, or `commit …`): its result, by default rc 0. */
  onWrite?: (c: ProcCall) => ProcOutcome | void;
  /** What the summary read after a commit (`log -1 … HEAD`) gives: by
   *  default `abc1234` and the last commit's message, with rc 0. */
  headLog?: ProcOutcome;
}

/** The acceptance fixture's objects the diffs read. */
const ACC_BLOBS: Record<string, string> = {
  ":0:a.ts": "export const a = 3;\n",
  "HEAD:a.ts": "export const a = 1;\nexport const a2 = 2;\n",
  ":0:b.md": "# b\n",
  ":0:gone.ts": "export const gone = 1;\n",
  "HEAD:old.ts": 'export const old = "old";\n// keep the content so git sees a rename\n',
  ":0:moved.ts": 'export const old = "old";\n// keep the content so git sees a rename\n',
};

/** The fake object id of a blob spec: `rev-parse <spec>` prints it, and
 *  `cat-file` reads by it. */
const oidOf = (spec: string): string => createHash("sha1").update(spec).digest("hex");
/** The spec an object id stands for in `repo` (the argument itself if none). */
const specOf = (repo: Repo, arg: string): string => Object.keys(repo.blobs ?? {}).find((s) => oidOf(s) === arg) ?? arg;

function repoScript(repo: Repo): (c: ProcCall) => ProcOutcome {
  let lastMessage = "";
  return (c) => {
    if (c.program === "docker") return repo.inspect ?? { code: 1, stdout: "", stderr: "no such container" };
    if (c.program === "pwd") return repo.pwd ?? BIND_PWD;
    if (c.program !== "git") return { code: 127, stdout: "", stderr: "unknown program" };
    // A commit is a write too, without the flag (INV §8 P30).
    if (c.args[0] === "commit") lastMessage = c.args[3] ?? "";
    if (c.args[0] === "--literal-pathspecs" || c.args[0] === "commit") return repo.onWrite?.(c) ?? { code: 0, stdout: "", stderr: "" };
    if (c.args[1] === "log") return repo.headLog ?? { code: 0, stdout: `abc1234\n${lastMessage}\n`, stderr: "" };
    if (c.args[0] === "rev-parse" && c.args[1] !== "--show-toplevel") {
      const spec = c.args[1];
      return repo.blobs?.[spec] === undefined ? { code: 128, stdout: "", stderr: `fatal: path '${spec}' does not exist` } : { code: 0, stdout: `${oidOf(spec)}\n`, stderr: "" };
    }
    const cat = c.args.indexOf("cat-file");
    if (cat >= 0) {
      const spec = specOf(repo, c.args.at(-1)!);
      const blob = repo.blobs?.[spec];
      if (blob === undefined) return { code: 128, stdout: "", stderr: `fatal: path '${spec}' does not exist` };
      if (c.args[cat + 1] === "-s") return { code: 0, stdout: `${repo.blobSizes?.[spec] ?? Buffer.byteLength(blob)}\n`, stderr: "" };
      return { code: 0, stdout: blob, stderr: "" };
    }
    if (c.args[0] === "rev-parse") {
      const code = repo.revParseCode ?? repo.code;
      return code === 0 ? { code: 0, stdout: `${repo.root ?? "/repo"}\n`, stderr: "" } : { code, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (repo.statusOutcome) return repo.statusOutcome();
    return repo.code === 0 ? { code: 0, stdout: repo.status, stderr: "" } : { code: repo.code, stdout: "", stderr: "fatal" };
  };
}

/** The repository the last `load` scripted. */
let currentRepo: Repo = { status: "", code: 0 };

async function load(repo: Repo, opts: { git?: boolean; script?: (c: ProcCall) => ProcOutcome } = {}): Promise<void> {
  currentRepo = repo;
  fake.script = opts.script ?? repoScript(repo);
  if (opts.git !== false) fake.files.add("/repo/.git");
  await import(`../git_sidebar.ts?load=${++loads}`);
  await fake.flush();
}

function mounts() {
  return fake.named("mountSidebarSection").map((c) => ({
    spec: c.args[1] as TreeSpec,
    title: c.args[2] as string,
    rows: c.args[3],
    opts: c.args[4],
  }));
}
const lastMount = () => mounts().at(-1)!;
/** Unmounts of a section's panel (the active window's by default): not the
 *  legacy id-1 panel load clears, nor the menu. */
const sectionUnmounts = (panel = fake.panel) => fake.named("unmountFloatingWidget").filter((c) => c.args[0] === panel);
const mutations = () => fake.named("widgetMutate").map((c) => c.args[1] as { kind: string; keys?: string[]; index?: number });

function assertEveryMountHasOptions(window = 1): void {
  for (const m of mounts()) assert.deepEqual(m.opts, { closable: false, startBlurred: true, scope: { window } }, m.title);
}
/** Every spec sent to the host: mounts and in-place updates. */
const sentSpecs = () =>
  fake.calls.filter((x) => x.name === "mountSidebarSection" || x.name === "updateFloatingWidget").map((c) => c.args[1] as TreeSpec);
/** The spec drawn now: the latest mount or in-place update. */
const lastShown = () => sentSpecs().at(-1)!;
const hasFileRows = (spec: TreeSpec) => spec.itemKeys.some((k) => rowKind(k).kind === "file");

const FOCUS = "Git Sidebar: Focus";
/** The palette commands listed now, sorted. */
const listedNow = () => [...fake.palette()].filter(([, listed]) => listed).map(([name]) => name).sort();

/** A click on a row body, as the host reports it for a file row. */
const click = (index: number, key: string) => fake.widget("select", { index, key, via: "click" });
const statuses = () => fake.named("setStatus").map((c) => c.args[0] as string);
/** The argv of every git write (`--literal-pathspecs …`, or `commit …`) so far. */
const writeCalls = () => fake.gitCalls().filter((p) => p.args[0] === "--literal-pathspecs" || p.args[0] === "commit");
const writes = () => writeCalls().map((p) => p.args);
/** Every `cat-file` read so far, each object id shown as the spec it was
 *  resolved from. */
const catFiles = () =>
  fake
    .gitCalls()
    .filter((p) => p.args.includes("cat-file"))
    .map((p) => ({ ...p, args: p.args.map((a) => (/^[0-9a-f]{40}$/.test(a) ? specOf(currentRepo, a) : a)) }));
/** The blob specs resolved to object ids so far (`rev-parse <spec>`). */
const resolved = () =>
  fake
    .gitCalls()
    .filter((p) => p.args[0] === "rev-parse" && p.args[1] !== "--show-toplevel")
    .map((p) => p.args[1]);
const vbufOpts = () => fake.named("createVirtualBuffer").map((c) => c.args[0] as { name: string; entries: { text: string }[]; [k: string]: unknown });
const compositeOpts = () =>
  fake.named("createCompositeBuffer").map((c) => c.args[0] as { name: string; mode: string; sources: { bufferId: number; label: string; editable: boolean }[]; layout: { type: string } });
const shownBuffers = () => fake.named("showBuffer").map((c) => c.args[0] as number);
/** Each source's text, left then right, of every view built. */
const sourceTexts = () => vbufOpts().map((o) => o.entries.map((e) => e.text).join(""));

/** Every git run is a lock-free read, a write with literal paths (R11,
 *  R15), or a commit, which names no paths and must not export the flag to
 *  hooks (R26, INV §8 P30). With windows, no git or docker starts outside
 *  the active window's folder (R28); `pwd` runs in the container, with no
 *  cwd. */
function assertProcsAllowed(): void {
  for (const p of fake.allProcs.filter((x) => x.program === "git")) {
    assert.ok(["--no-optional-locks", "rev-parse", "--literal-pathspecs", "commit"].includes(p.args[0]), p.args.join(" "));
    if (p.args[0] === "commit") assert.ok(!p.args.includes("--literal-pathspecs"), p.args.join(" "));
  }
  if (fake.windows !== null) {
    for (const p of fake.allProcs.filter((x) => x.program !== "pwd")) {
      const inRoot = p.windowRoot !== null && (p.cwd === p.windowRoot || p.cwd.startsWith(`${p.windowRoot}/`));
      assert.ok(inRoot, `${p.program} ${p.args.join(" ")} in ${p.cwd} while window ${p.window} (${p.windowRoot}) was active`);
    }
  }
}

/** A fresh editor for a second scenario within one test. The first
 *  scenario's runs are checked as `afterEach` checks the last one's. */
function restartFake(): void {
  fake.uninstall();
  assertProcsAllowed();
  fake = new FakeEditor();
  fake.install();
}

beforeEach(() => {
  fake = new FakeEditor();
  fake.install();
  rejections = [];
  process.on("unhandledRejection", onRejection);
});

afterEach(() => {
  process.off("unhandledRejection", onRejection);
  fake.uninstall();
  assert.deepEqual(rejections, [], "unhandled rejections");
  assertProcsAllowed();
});

test("load: placeholder mounted at once, then the real title; both options on every mount", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  // Synchronous mount at load (INV §8 P2): before any git call.
  assert.equal(mounts().length, 1);
  assert.equal(lastMount().title, "Git");
  assert.deepEqual(texts(lastMount().spec), ["Staged Changes", "Changes"]);
  assert.deepEqual(lastMount().spec.expandedKeys, ["g:s", "g:c"], "both groups expanded");
  assert.equal(fake.gitCalls().length, 0);
  await fake.advance(200);
  assert.equal(mounts().length, 2);
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  assert.deepEqual(texts(lastMount().spec).filter((t) => !t.startsWith(" ")).slice(0, 1), ["Staged Changes 2"]);
  assert.ok(texts(lastMount().spec).includes("Changes 5"));
  assert.equal(lastMount().rows, 0);
  assertEveryMountHasOptions();
  assert.equal(sectionUnmounts().length, 0);
  assert.deepEqual(fake.loudCalls(), []);
});

test("no section in a non-repository; nothing logged above debug; no retries", async () => {
  await load({ status: "", code: 128 }, { git: false });
  await fake.advance(30_000);
  assert.equal(mounts().length, 0);
  // The one widget call takes down a section a previous instance of the
  // plugin left mounted across a reload (a no-op when there is none).
  // The legacy panel at load (R28), then the placeholder taken down (R1).
  assert.deepEqual(
    fake.widgetCalls().map((c) => [c.name, c.args[0]]),
    [
      ["unmountFloatingWidget", 1],
      ["unmountFloatingWidget", fake.panel],
    ],
  );
  assert.deepEqual(fake.loudCalls(), []);
  assert.equal(fake.gitCalls().length, 1, "one rev-parse, then quiet until the authority changes");
});

test("no section when git cannot run (code -1), even where .git exists", async () => {
  await load({ status: "", code: -1 });
  await fake.advance(30_000);
  // The placeholder is the only mount, and it is taken down again.
  assert.equal(mounts().length, 1);
  assert.equal(sectionUnmounts().length, 1);
  assert.deepEqual(fake.loudCalls(), []);
  assert.equal(fake.gitCalls().length, 1);
});

test("a save refreshes; an identical result makes zero widget calls", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.emit("after_file_save", { buffer_id: 1, path: "/repo/b.md" });
  await fake.advance(1000);
  assert.equal(fake.gitCalls().length, 1);
  assert.deepEqual(fake.widgetCalls(), []);
  // 30 s of polling with nothing changing: still no widget calls (R10).
  await fake.advance(30_000);
  assert.ok(fake.gitCalls().length >= 10);
  assert.deepEqual(fake.widgetCalls(), []);
  // A change updates in place under the same title.
  repo.status = raw({ records: [mod(".M", "b.md")] });
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.named("updateFloatingWidget").length, 1);
  assert.equal(fake.named("mountSidebarSection").length, 0);
});

test("other triggers refresh within 2 s at d=200 ms", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  for (const ev of ["after_file_revert", "focus_gained", "after_file_explorer_change"]) {
    repo.status = raw({ records: [untracked(`${ev}.txt`)] });
    repo.statusOutcome = () => ({ result: { code: 0, stdout: repo.status, stderr: "" }, ms: 200 });
    fake.clear();
    await fake.emit(ev, {});
    await fake.advance(2000);
    const shown = fake.named("updateFloatingWidget").at(-1)?.args[1] as TreeSpec | undefined;
    assert.ok(shown && texts(shown).includes(`U ${ev}.txt`), ev);
  }
});

test("selection stays on its key when a row is inserted above it", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  // acceptance keys: g:s s:a.ts s:moved.ts g:c c:a.ts c:b.md ...
  await fake.widget("select", { index: 5, key: "c:b.md" });
  fake.clear();
  // Stage a file that sorts above: every Changes row moves down by one.
  repo.status = ACCEPTANCE.replace("# branch.ab +1 -0\0", `# branch.ab +1 -0\0${mod("A.", "0.txt")}\0`);
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.named("updateFloatingWidget").length, 1);
  assert.deepEqual(mutations(), [{ kind: "setSelectedIndex", widgetKey: "git", index: 6 }]);
});

test("selected file gone: the host's index is kept and its row adopted", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  await fake.widget("select", { index: 5, key: "c:b.md" });
  fake.clear();
  repo.status = ACCEPTANCE.replace(/1 \.M [^\0]* b\.md\0/, "");
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.deepEqual(mutations(), [], "no selection push");
  // The row now at index 5 (gone.ts) is the selection: inserting above it moves it.
  repo.status = repo.status.replace("# branch.ab +1 -0\0", `# branch.ab +1 -0\0${mod("A.", "0.txt")}\0`);
  fake.clear();
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.deepEqual(mutations(), [{ kind: "setSelectedIndex", widgetKey: "git", index: 6 }]);
});

test("branch change: remount with all options, then push expansion and selection, never focus", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  await fake.widget("expand", { index: 3, key: "g:c", expanded: false });
  await fake.widget("select", { index: 1, key: "s:a.ts" });
  fake.clear();
  repo.status = ACCEPTANCE.replace("# branch.head main", "# branch.head other").replace(/# branch\.upstream[^\0]*\0# branch\.ab[^\0]*\0/, "");
  await fake.emit("focus_gained", {});
  await fake.advance(1000);
  const m = mounts();
  assert.equal(m.length, 1);
  assert.equal(m[0].title, "Git · other");
  assert.equal(m[0].spec.selectedIndex, 1);
  assert.deepEqual(m[0].spec.expandedKeys, ["g:s"]);
  assertEveryMountHasOptions();
  const names = fake.widgetCalls().map((c) => c.name);
  // No "focus": the host's focus shows a hidden explorer column and expands
  // a collapsed section (INV §8 P27), and the section never takes the
  // keyboard by itself (R1, R22).
  assert.deepEqual(names, ["mountSidebarSection", "widgetMutate", "widgetMutate"]);
  assert.deepEqual(mutations(), [
    { kind: "setExpandedKeys", widgetKey: "git", keys: ["g:s"] },
    { kind: "setSelectedIndex", widgetKey: "git", index: 1 },
  ]);
  assert.equal(fake.named("floatingPanelControl").length, 0);
});

test("a failed run keeps the last result; a timed-out run is killed", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  repo.code = 128; // e.g. index.lock held with a non-optional lock, or a broken repo
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.gitCalls().length, 1);
  assert.deepEqual(fake.widgetCalls(), []);
  repo.code = 0;
  repo.statusOutcome = () => "hang";
  await fake.emit("after_file_save", {});
  await fake.advance(9_000);
  assert.equal(fake.kills, 0);
  await fake.advance(2_000);
  assert.equal(fake.kills, 1);
  assert.deepEqual(fake.widgetCalls(), []);
  assert.deepEqual(fake.loudCalls(), []);
  // After the 10 s run the gap is 30 s; the next good result still shows.
  repo.statusOutcome = undefined;
  repo.status = raw({ records: [untracked("later.txt")] });
  await fake.advance(35_000);
  assert.equal(fake.named("updateFloatingWidget").length, 1);
});

test("Enter on a file row opens its diff, never the file; Space stages it; Enter toggles a group (R7, R14, R15)", async () => {
  await load({ status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS });
  await fake.advance(200);
  fake.files.add("/repo/b.md");
  fake.contents.set("/repo/b.md", "# b\nchanged\n");
  fake.clear();
  // gone.ts is deleted: its diff has an empty right side, and no buffer opens the file.
  await fake.widget("activate", { index: 6, key: "c:gone.ts" });
  await fake.advance(50);
  assert.deepEqual(sourceTexts(), ["export const gone = 1;", ""]);
  await fake.widget("activate", { index: 5, key: "c:b.md" });
  await fake.advance(50);
  assert.deepEqual(sourceTexts().slice(2), ["# b", "# b\nchanged"]);
  assert.equal(fake.named("openFile").length, 0);
  // Each diff names its keys (R20), and nothing else is said.
  assert.deepEqual(statuses(), [DIFF_HINT, DIFF_HINT]);
  fake.clear();
  // Space on a file row stages it, and opens no buffer or file (R7, R15).
  await fake.widget("activate", { index: 5, key: "c:b.md", via: "space" });
  await fake.advance(50);
  assert.deepEqual(writes(), [["--literal-pathspecs", "add", "--", "b.md"]]);
  assert.equal(fake.named("createVirtualBuffer").length + fake.named("openFile").length, 0);
  fake.clear();
  await fake.widget("activate", { index: 3, key: "g:c" });
  await fake.widget("activate", { index: 3, key: "g:c" });
  assert.deepEqual(mutations(), [
    { kind: "setExpandedKeys", widgetKey: "git", keys: ["g:s"] },
    { kind: "setExpandedKeys", widgetKey: "git", keys: ["g:s", "g:c"] },
  ]);
  fake.clear();
  await fake.widget("activate", { index: 0, key: "more:c" });
  await click(0, "more:c");
  assert.deepEqual(fake.calls.filter((c) => c.name !== "fileExists"), []);
});

test("with no user op, every git argument list starts with --no-optional-locks or is rev-parse (R11)", async () => {
  await load({ status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS });
  await fake.advance(20_000);
  await fake.emit("after_file_save", {});
  // Viewing a diff reads only.
  await click(5, "c:b.md");
  await fake.advance(5_000);
  const calls = fake.gitCalls();
  assert.ok(calls.length > 5);
  for (const c of calls) assert.ok(c.args[0] === "--no-optional-locks" || c.args[0] === "rev-parse", c.args.join(" "));
});

test("writes appear only after a button or Space (R11, R15)", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  await fake.advance(200);
  await fake.widget("select", { index: 5, key: "c:b.md" });
  await fake.widget("activate", { index: 5, key: "c:b.md" });
  await fake.advance(5_000);
  assert.deepEqual(writes(), []);
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(50);
  assert.deepEqual(writes(), [["--literal-pathspecs", "add", "--", "b.md"]]);
});

test("container with a bind mount: git runs only on the host, in the host root", async () => {
  fake.label = "Container:abc";
  await load({ status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT });
  await fake.advance(10_000);
  assert.ok(fake.procs.some((p) => p.program === "docker" && p.via === "host" && p.args.join(" ") === "inspect abc --format {{json .Mounts}}"));
  // Only `pwd` runs in the container, with no cwd (so in its workspace).
  assert.deepEqual(fake.procs.filter((p) => p.via === "target").map((p) => [p.program, p.cwd]), [["pwd", ""]]);
  assert.ok(fake.gitCalls().length > 1);
  for (const p of fake.procs) if (p.program !== "pwd") assert.equal(p.via, "host", `${p.program} ${p.args[0]}`);
  for (const p of fake.gitCalls()) assert.equal(p.cwd, "/repo");
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
});

test("container with a bind mount: exit_code 128 gives no section", async () => {
  fake.label = "Container:abc";
  await load({ status: "", code: 128, inspect: BIND_INSPECT });
  await fake.advance(10_000);
  assert.equal(sectionUnmounts().length, 1);
  assert.equal(mounts().length, 1);
  assert.deepEqual(fake.loudCalls(), []);
});

test("authority_changed re-detects the mode and refreshes; detach goes back to runOnTarget", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT };
  await load(repo);
  await fake.advance(200);
  assert.ok(fake.gitCalls().every((p) => p.via === "target"));
  fake.clear();
  fake.label = "Container:abc";
  repo.status = raw({ records: [mod("A.", "b.md")] });
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(1000);
  assert.ok(fake.procs.some((p) => p.program === "docker"));
  assert.ok(fake.gitCalls().length >= 1 && fake.gitCalls().every((p) => p.via === "host"));
  assert.equal(fake.named("updateFloatingWidget").length, 1, "same title, rows updated within 5 s");
  assert.equal(sectionUnmounts().length, 0);
  fake.clear();
  fake.label = "";
  await fake.emit("authority_changed", { label: "" });
  await fake.advance(1000);
  assert.ok(!fake.procs.some((p) => p.program === "docker"));
  assert.ok(fake.gitCalls().length >= 1 && fake.gitCalls().every((p) => p.via === "target"));
  assertEveryMountHasOptions();
});

test("volume workspace: one notice row, no git at all, nothing polled", async () => {
  fake.label = "Container:vol";
  await load({ status: ACCEPTANCE, code: 0, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD });
  await fake.advance(30_000);
  assert.equal(fake.gitCalls().length, 0);
  assert.equal(lastMount().title, "Git");
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
  assertEveryMountHasOptions();
  assert.equal(fake.armedTimers(), 0);
  // Events do not start git either.
  await fake.emit("after_file_save", {});
  await fake.advance(5_000);
  assert.equal(fake.gitCalls().length, 0);
  // Detach: the host's rows come back.
  fake.label = "";
  await fake.emit("authority_changed", { label: "" });
  await fake.advance(1_000);
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  assert.equal(sectionUnmounts().length, 0);
});

test("attaching to a volume container never shows the host's rows", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  fake.label = "Container:vol";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(5_000);
  assert.equal(fake.gitCalls().length, 0);
  assert.equal(lastMount().title, "Git");
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
});

test("a first run that times out keeps the placeholder and is retried; a later success shows rows", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, statusOutcome: () => "hang" };
  await load(repo);
  await fake.advance(11_000);
  assert.equal(fake.kills, 1, "the first status timed out");
  assert.equal(mounts().length, 1);
  assert.equal(lastMount().title, "Git");
  assert.equal(sectionUnmounts().length, 0);
  // A run that fails with an ordinary code does not give up either.
  repo.statusOutcome = () => ({ code: 1, stdout: "", stderr: "transient" });
  await fake.advance(40_000);
  assert.equal(sectionUnmounts().length, 0);
  repo.statusOutcome = undefined;
  await fake.advance(5_000);
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  assert.ok(hasFileRows(lastShown()));
  assert.equal(sectionUnmounts().length, 0);
  assert.deepEqual(fake.loudCalls(), []);
});

test("every mount is scoped to the window active at load, as its workspace's panel; its folder is read once, from listWindows (R28)", async () => {
  fake.window = 7;
  fake.windows = [{ id: 7, stable_id: "ws-7", root: "/repo" }];
  assert.equal(fake.panel, panelOf("ws-7"));
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD };
  await load(repo);
  await fake.advance(200);
  // `getCwd` names another folder by now: the section keeps its window's.
  fake.cwd = "/elsewhere";
  repo.status = ACCEPTANCE.replace("# branch.head main", "# branch.head other");
  await fake.emit("focus_gained", {});
  await fake.advance(1000);
  assert.equal(lastMount().title, "Git · other ↑1 ↓0");
  // Attaching re-detects against the window's folder (/repo): still bind.
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(1000);
  assert.equal(lastMount().title, "Git · other ↑1 ↓0");
  assert.ok(fake.gitCalls().some((p) => p.via === "host"));
  assert.equal(mounts().length, 3);
  assertEveryMountHasOptions(7);
  for (const c of fake.named("mountSidebarSection")) assert.equal(c.args[0], fake.panel);
  assert.equal(fake.named("getCwd").length, 0);
  for (const p of fake.procs) if (p.program !== "pwd") assert.equal(p.cwd, "/repo", `${p.program} ${p.args[0]}`);
});

test("cancel (the window closed): no git and no mounts ever again", async () => {
  const pending = deferred();
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  // A run in flight when the window closes.
  repo.statusOutcome = () => pending.outcome;
  await fake.emit("after_file_save", {});
  await fake.advance(500);
  assert.equal(fake.gitCalls().length, 3);
  await fake.widget("cancel");
  fake.clear();
  pending.resolve({ code: 0, stdout: raw({ records: [untracked("late.txt")] }), stderr: "" });
  await fake.advance(30_000);
  for (const ev of ["after_file_save", "focus_gained", "after_file_explorer_change", "after_file_revert"]) await fake.emit(ev, {});
  await fake.emit("authority_changed", { label: "" });
  await fake.emit("trust_changed", { level: "trusted" });
  await fake.advance(60_000);
  assert.deepEqual(fake.procs, []);
  assert.deepEqual(fake.widgetCalls(), []);
  assert.equal(fake.armedTimers(), 0);
});

test("selected row gone and the list shorter: the clamped index is pushed", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  // Last row: c:new/d.txt at 8.
  await fake.widget("select", { index: 8, key: "c:new/d.txt" });
  fake.clear();
  repo.status = ACCEPTANCE.replace("? new/c.txt\0", "").replace("? new/d.txt\0", "");
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.named("updateFloatingWidget").length, 1);
  assert.equal(lastShown().selectedIndex, 6);
  assert.deepEqual(mutations(), [{ kind: "setSelectedIndex", widgetKey: "git", index: 6 }]);
});

test("seeds: every spec carries the current selection and expansion; every mount pushes them", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  // The placeholder mount pushes the expansion too.
  assert.deepEqual(mutations(), [{ kind: "setExpandedKeys", widgetKey: "git", keys: ["g:s", "g:c"] }]);
  await fake.advance(200);
  await fake.widget("expand", { index: 0, key: "g:s", expanded: false });
  await fake.widget("select", { index: 5, key: "c:b.md" });
  fake.clear();
  repo.status = ACCEPTANCE.replace("? new/d.txt\0", "? new/d.txt\0? z.txt\0");
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.named("updateFloatingWidget").length, 1);
  assert.equal(lastShown().selectedIndex, 5);
  assert.deepEqual(lastShown().expandedKeys, ["g:c"]);
  assert.deepEqual(mutations(), [], "the index did not move");
});

test("detaching from a volume container into a non-git folder removes the notice and stops", async () => {
  fake.label = "Container:vol";
  await load({ status: "", code: 128, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD }, { git: false });
  await fake.advance(1000);
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
  fake.clear();
  fake.label = "";
  await fake.emit("authority_changed", { label: "" });
  await fake.advance(1000);
  assert.equal(fake.gitCalls().length, 1, "one rev-parse");
  assert.equal(sectionUnmounts().length, 1);
  fake.clear();
  await fake.advance(60_000);
  assert.deepEqual(fake.procs, []);
  assert.deepEqual(fake.widgetCalls(), []);
  assert.deepEqual(fake.loudCalls(), []);
});

test("trust_changed retries after a blocked first run", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: -1 };
  await load(repo);
  await fake.advance(1000);
  assert.equal(sectionUnmounts().length, 1, "no section");
  assert.equal(fake.gitCalls().length, 1);
  repo.code = 0;
  await fake.emit("trust_changed", { level: "trusted" });
  await fake.advance(1000);
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  assert.ok(hasFileRows(lastShown()));
  assertEveryMountHasOptions();
});

test("trust_changed during a first run: the stale run's failure does not cancel the retry", async () => {
  const blocked = deferred();
  let first = true;
  const repo: Repo = {
    status: ACCEPTANCE,
    code: 0,
    statusOutcome: () => {
      if (!first) return { code: 0, stdout: ACCEPTANCE, stderr: "" };
      first = false;
      return blocked.outcome;
    },
  };
  await load(repo);
  await fake.advance(200);
  assert.deepEqual(fake.gitCalls().map((p) => p.args[0]), ["rev-parse", "--no-optional-locks"], "status in flight");
  await fake.emit("trust_changed", { level: "trusted" });
  // The run started before the trust change comes back blocked.
  blocked.resolve({ code: -1, stdout: "", stderr: "denied by workspace trust" });
  await fake.advance(1000);
  assert.equal(sectionUnmounts().length, 0);
  assert.equal(fake.gitCalls().length, 3, "the retry ran");
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  assert.ok(hasFileRows(lastShown()));
  assertEveryMountHasOptions();
});

test("an unchanged status output is not parsed or rebuilt; a changed one updates", async (t) => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  // Every tree compared is first turned into a signature.
  const stringify = t.mock.method(JSON, "stringify");
  const signatures = () =>
    stringify.mock.calls.filter((c) => {
      const v: unknown = c.arguments[0];
      return typeof v === "object" && v !== null && "title" in v && "keys" in v && "nodes" in v;
    }).length;
  fake.clear();
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.gitCalls().length, 1);
  assert.equal(signatures(), 0, "no tree built");
  assert.deepEqual(fake.widgetCalls(), []);
  repo.status = raw({ records: [untracked("new.txt")] });
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.ok(signatures() > 0);
  assert.equal(fake.named("updateFloatingWidget").length, 1);
  assert.deepEqual(texts(lastShown()), ["Staged Changes 0", "Changes 1", "U new.txt"]);
});

test("authority_changed: a click waits for the mode; palette View File still opens the file (root kept)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD, blobs: ACC_BLOBS };
  await load(repo);
  await fake.advance(200);
  fake.files.add("/repo/b.md");
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  fake.clear();
  // Before the refresh the attach asked for has run.
  await click(5, "c:b.md");
  await fake.advance(0);
  assert.deepEqual(statuses(), ["finding out where git runs; try again in a moment"]);
  assert.deepEqual(catFiles(), []);
  await fake.command("Git Sidebar: View File");
  assert.deepEqual(fake.named("openFile").map((c) => c.args[0]), ["/repo/b.md"]);
});

test("directory rows (nested repository, submodule) give a status message, never a buffer", async () => {
  const records = [`1 .M S.M. 160000 160000 160000 ${H} ${H} sub`, "? vendor/lib/"];
  await load({ status: raw({ records }), code: 0 });
  await fake.advance(200);
  fake.files.add("/repo/sub");
  fake.files.add("/repo/vendor/lib/");
  fake.files.add("/repo/vendor/lib");
  assert.deepEqual(lastShown().itemKeys, ["g:s", "g:c", "c:sub", "c:vendor/lib/"]);
  assert.deepEqual(texts(lastShown()).slice(2), ["M sub", "U lib  vendor"]);
  fake.clear();
  // Click, Enter and View File: a message each, and no git, buffer or file.
  await click(2, "c:sub");
  await fake.widget("activate", { index: 3, key: "c:vendor/lib/" });
  await fake.command("Git Sidebar: View File");
  await fake.advance(50);
  assert.equal(fake.named("openFile").length + fake.named("createVirtualBuffer").length, 0);
  assert.deepEqual(catFiles(), []);
  assert.deepEqual(statuses(), [
    "sub is a directory (submodule or nested repository)",
    "vendor/lib is a directory (submodule or nested repository)",
    "vendor/lib is a directory (submodule or nested repository)",
  ]);
});

test("a root file named `~more` in an overflowing group has its own key and opens", async () => {
  const records = [untracked("~more"), ...manyUntracked(600, "~n")];
  await load({ status: raw({ records }), code: 0 });
  await fake.advance(200);
  const keys = lastShown().itemKeys;
  assert.equal(new Set(keys).size, keys.length, "item keys unique");
  assert.equal(keys[2], "c:~more");
  fake.files.add("/repo/~more");
  fake.contents.set("/repo/~more", "m\n");
  await click(2, "c:~more");
  await fake.advance(50);
  assert.deepEqual(sourceTexts(), ["", "m"], "untracked: empty left side");
  await fake.command("Git Sidebar: View File");
  assert.deepEqual(fake.named("openFile").map((c) => c.args[0]), ["/repo/~more"]);
});

test("a widget call that returns false is retried on the next refresh", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  // An in-place update the host refuses.
  repo.status = raw({ records: [untracked("one.txt")] });
  fake.returns.set("updateFloatingWidget", [false]);
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.named("updateFloatingWidget").length, 1);
  fake.clear();
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.named("updateFloatingWidget").length, 1, "same status, sent again");
  assert.ok(texts(lastShown()).includes("U one.txt"));
  // A remount the host refuses.
  repo.status = repo.status.replace("# branch.head main", "# branch.head other");
  fake.returns.set("mountSidebarSection", [false]);
  fake.clear();
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(mounts().length, 1);
  assert.deepEqual(mutations(), [], "nothing pushed after a refused mount");
  assert.ok(fake.named("debug").some((c) => String(c.args[0]).includes("mountSidebarSection returned false")));
  fake.clear();
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(mounts().length, 1, "mounted again");
  assert.equal(lastMount().title, "Git · other ↑1 ↓0");
});

test("container detection that fails shows the retry notice, never host rows, and retries", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: { code: 1, stdout: "", stderr: "daemon busy" }, pwd: BIND_PWD };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(500);
  assert.deepEqual(texts(lastShown()), [UNKNOWN_NOTICE]);
  assert.equal(fake.gitCalls().length, 0);
  // The pwd failing is unknown too.
  repo.pwd = { code: -1, stdout: "", stderr: "exec failed" };
  await fake.advance(3000);
  assert.deepEqual(texts(lastShown()), [UNKNOWN_NOTICE]);
  assert.equal(fake.gitCalls().length, 0);
  // Detection succeeds on a later tick: host rows come back.
  repo.pwd = BIND_PWD;
  repo.inspect = BIND_INSPECT;
  await fake.advance(3000);
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  assert.ok(hasFileRows(lastShown()));
  assert.ok(fake.gitCalls().every((p) => p.via === "host"));
  assert.equal(sectionUnmounts().length, 0);
});

test("a local run in flight across an attach to a volume container never draws host rows", async () => {
  const pending = deferred();
  let first = true;
  const repo: Repo = {
    status: ACCEPTANCE,
    code: 0,
    inspect: VOLUME_INSPECT,
    pwd: VOLUME_PWD,
    statusOutcome: () => {
      if (!first) return { code: 0, stdout: ACCEPTANCE, stderr: "" };
      first = false;
      return pending.outcome;
    },
  };
  await load(repo);
  await fake.advance(200);
  assert.deepEqual(fake.gitCalls().map((p) => p.args[0]), ["rev-parse", "--no-optional-locks"], "status in flight");
  fake.label = "Container:vol";
  await fake.emit("authority_changed", { label: fake.label });
  // The stale local status arrives after the attach.
  pending.resolve({ code: 0, stdout: ACCEPTANCE, stderr: "" });
  await fake.advance(5_000);
  for (const spec of sentSpecs()) assert.ok(!hasFileRows(spec), JSON.stringify(spec.itemKeys));
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
  assert.equal(fake.gitCalls().length, 2);
});

test("attaching from a non-git folder with container detection failing shows no section", async () => {
  const repo: Repo = { status: "", code: 128, inspect: { code: 1, stdout: "", stderr: "daemon busy" }, pwd: BIND_PWD };
  await load(repo, { git: false });
  await fake.advance(1000);
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(10_000);
  assert.equal(mounts().length, 0);
  assert.deepEqual(fake.loudCalls(), []);
});

test("a trust change keeps a container mode already found: rows stay when git is then blocked", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD };
  fake.label = "Container:abc";
  await load(repo);
  await fake.advance(200);
  assert.ok(hasFileRows(lastShown()));
  fake.clear();
  repo.code = -1;
  repo.pwd = { code: -1, stdout: "", stderr: "denied by workspace trust" };
  await fake.emit("trust_changed", { level: "blocked" });
  await fake.advance(5_000);
  assert.ok(!fake.procs.some((p) => p.program === "pwd" || p.program === "docker"), "no re-detection");
  assert.deepEqual(fake.widgetCalls(), [], "the last good rows stay");
});

test("a notice in between keeps the selected file: it is selected again when the rows come back", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: { code: 1, stdout: "", stderr: "not ready" }, pwd: BIND_PWD };
  await load(repo);
  await fake.advance(200);
  await fake.widget("select", { index: 5, key: "c:b.md" });
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(500);
  assert.deepEqual(texts(lastShown()), [UNKNOWN_NOTICE]);
  fake.clear();
  repo.inspect = BIND_INSPECT;
  await fake.advance(3000);
  assert.ok(hasFileRows(lastShown()));
  assert.equal(lastShown().selectedIndex, 5);
  assert.deepEqual(mutations().at(-1), { kind: "setSelectedIndex", widgetKey: "git", index: 5 });
});

test("a deleted file whose path is now a directory: an empty right side, and View File says so", async () => {
  await load({ status: raw({ records: [mod(".D", "docs"), untracked("docs/x.md")] }), code: 0, blobs: { ":0:docs": "was a file\n" } });
  await fake.advance(200);
  fake.dirs.add("/repo/docs");
  fake.clear();
  // Not refused as binary: the right side is empty (INV §9.4).
  await click(2, "c:docs");
  await fake.advance(50);
  assert.deepEqual(sourceTexts(), ["was a file", ""]);
  assert.deepEqual(statuses(), [DIFF_HINT]);
  // An empty side needs no line diff: the host is not sent the other side for it.
  assert.equal(fake.named("computeLineDiff").length, 0);
  await fake.command("Git Sidebar: View File");
  assert.equal(fake.named("openFile").length, 0);
  assert.deepEqual(statuses(), [DIFF_HINT, "docs is a directory"]);
});

test("View File on a name that is not UTF-8 says so, not that the file is deleted (R7, F6)", async () => {
  const bad = "caf\uFFFD.txt";
  await load({ status: raw({ records: [untracked(bad)] }), code: 0 });
  await fake.advance(200);
  fake.clear();
  await fake.widget("select", { index: 2, key: `c:${bad}` });
  await fake.command("Git Sidebar: View File");
  assert.equal(fake.named("openFile").length, 0);
  assert.deepEqual(statuses(), [`${bad}: the name is not valid UTF-8, so git can't be passed it back`]);
});

test("a workspace below the repository root mounts the placeholder at load", async () => {
  fake.cwd = "/repo/sub/dir";
  await load({ status: ACCEPTANCE, code: 0 });
  assert.equal(mounts().length, 1);
  assert.equal(lastMount().title, "Git");
});

// ---------------------------------------------------------------------------
// R14: the diff on a click or Enter
// ---------------------------------------------------------------------------

/** b.md and a.ts on disk under `root`, as the acceptance fixture has them. */
function acceptanceOnDisk(root = "/repo"): void {
  fake.files.add(`${root}/b.md`);
  fake.contents.set(`${root}/b.md`, "# b\nchanged\n");
  fake.files.add(`${root}/a.ts`);
  fake.contents.set(`${root}/a.ts`, "export const a = 4;\n");
}

/** The acceptance repository with b.md on disk as the fixture has it. */
async function loadAcceptance(extra: Partial<Repo> = {}): Promise<Repo> {
  const repo: Repo = { status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS, ...extra };
  await load(repo);
  await fake.advance(200);
  acceptanceOnDisk();
  fake.clear();
  return repo;
}

test("a click on a file row opens one read-only side-by-side diff, never the file (R14, R7)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.deepEqual(catFiles().map((p) => p.args), [
    ["--no-optional-locks", "cat-file", "-s", ":0:b.md"],
    ["--no-optional-locks", "cat-file", "blob", ":0:b.md"],
  ]);
  // Both by the one object id rev-parse gave: the size and the text are the same blob's.
  assert.deepEqual(resolved(), [":0:b.md"]);
  assert.ok(fake.gitCalls().filter((p) => p.args.includes("cat-file")).every((p) => p.args.at(-1) === oidOf(":0:b.md")));
  assert.equal(fake.named("createVirtualBuffer").length, 2);
  assert.equal(fake.named("createCompositeBuffer").length, 1);
  assert.equal(fake.named("openFile").length, 0);
  // Read-only sources, hidden from the tabs; the trailing newline dropped.
  for (const o of vbufOpts()) {
    assert.equal(o.readOnly, true);
    assert.equal(o.editingDisabled, true);
    assert.equal(o.hiddenFromTabs, true);
  }
  assert.deepEqual(sourceTexts(), ["# b", "# b\nchanged"]);
  // No space after the `:`: Fresh picks the grammar from the text after it (R21, INV §8 P26).
  assert.deepEqual(vbufOpts().map((o) => o.name), ["*Staged:b.md*", "*Working tree:b.md*"]);
  const c = compositeOpts()[0];
  assert.equal(c.name, "b.md (staged ↔ working tree)");
  assert.equal(c.mode, "git-sidebar-diff");
  assert.equal(c.layout.type, "side-by-side");
  assert.deepEqual(c.sources.map((x) => [x.label, x.editable]), [["Staged", false], ["Working tree", false]]);
  assert.ok(fake.named("defineMode").length === 0, "the mode is defined once, at load");
  // Shown once; the composite and its two sources are the plugin's only buffers.
  assert.equal(shownBuffers().length, 1);
  assert.equal(fake.openBuffers().size, 3);
  assert.ok(fake.openBuffers().has(shownBuffers()[0]));
  // The hint, once the view is shown (R20).
  assert.deepEqual(statuses(), [DIFF_HINT]);
  assert.ok(fake.calls.findIndex((x) => x.name === "setStatus") > fake.calls.findIndex((x) => x.name === "showBuffer"));
});

test("the diff mode is defined at load, read-only, binding Enter only: Fresh's n, p, ], [, q and Esc fall through (R19, R20)", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  assert.deepEqual(fake.named("defineMode").map((c) => c.args), [["git-sidebar-diff", [["Enter", "gitSidebar_diffEnter"]], true]]);
});

test("Enter opens the same diff as a click; a Staged row compares HEAD with the index (R14)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  await fake.widget("activate", { index: 5, key: "c:b.md" });
  await fake.advance(50);
  const [first, second] = [vbufOpts().slice(0, 2), vbufOpts().slice(2)];
  assert.deepEqual(second, first);
  fake.clear();
  await click(1, "s:a.ts");
  await fake.advance(50);
  assert.deepEqual(sourceTexts(), ["export const a = 1;\nexport const a2 = 2;", "export const a = 3;"]);
  assert.equal(compositeOpts()[0].name, "a.ts (HEAD ↔ staged)");
  // A rename's left side is the original path's HEAD version. The two sides
  // are read at once; each reads its size before its content.
  fake.clear();
  await click(2, "s:moved.ts");
  await fake.advance(50);
  assert.deepEqual(catFiles().map((p) => p.args.slice(2)), [
    ["-s", "HEAD:old.ts"],
    ["-s", ":0:moved.ts"],
    ["blob", "HEAD:old.ts"],
    ["blob", ":0:moved.ts"],
  ]);
  // Identical sides: an empty hunk list, never null (the host draws nothing with null).
  const last = fake.named("createCompositeBuffer").at(-1)!.args[0] as { hunks: unknown; initialFocusHunk?: number };
  assert.deepEqual(last.hunks, []);
  assert.ok(!("initialFocusHunk" in last));
});

test("a replace keeps one diff view: the old composite and its sources are closed (R14, INV §9.4, P9 c)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  const firstView = fake.openBuffers();
  assert.equal(firstView.size, 3);
  await click(4, "c:a.ts");
  await fake.advance(50);
  // closeCompositeBuffer leaves the buffer open (as in Fresh): only the
  // extra closeBuffer on the composite brings the set back to three.
  assert.equal(fake.openBuffers().size, 3);
  for (const id of firstView) assert.ok(!fake.openBuffers().has(id), `buffer ${id} of the first view closed`);
  const closed = fake.named("closeBuffer").map((c) => c.args);
  for (const id of firstView) assert.deepEqual(closed.find((a) => a[0] === id), [id, true]);
  assert.ok(fake.named("closeCompositeBuffer").length === 1);
  // Shown first, then the old one closed.
  const order = fake.calls.map((c) => c.name).filter((n) => n === "showBuffer" || n === "closeCompositeBuffer");
  assert.deepEqual(order, ["showBuffer", "showBuffer", "closeCompositeBuffer"]);
});

test("a second click while the first diff is still being built: one view shown, the first build's buffers closed", async () => {
  await loadAcceptance();
  let release!: () => void;
  fake.compositeGate = new Promise<void>((r) => (release = r));
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(fake.named("createCompositeBuffer").length, 1, "first composite pending");
  fake.compositeGate = null;
  await click(4, "c:a.ts");
  await fake.advance(50);
  release();
  await fake.advance(50);
  assert.equal(shownBuffers().length, 1);
  assert.equal(fake.openBuffers().size, 3);
  assert.ok(fake.openBuffers().has(shownBuffers()[0]));
  assert.deepEqual(sourceTexts().slice(2), ["export const a = 3;", "export const a = 4;"]);
});

test("a later click on a refused row stops an earlier diff still being built: no view opens after its message (R14)", async () => {
  await load({ status: raw({ records: [mod(".M", "b.md"), untracked("vendor/lib/")] }), code: 0, blobs: { ":0:b.md": "# b\n" } });
  await fake.advance(200);
  // keys: g:s g:c c:b.md c:vendor/lib/
  fake.files.add("/repo/b.md");
  fake.contents.set("/repo/b.md", "# b\nchanged\n");
  fake.clear();
  let release!: () => void;
  fake.compositeGate = new Promise<void>((r) => (release = r));
  await click(2, "c:b.md");
  await fake.advance(50);
  assert.equal(fake.named("createCompositeBuffer").length, 1, "first composite pending");
  await click(3, "c:vendor/lib/");
  release();
  fake.compositeGate = null;
  await fake.advance(50);
  assert.deepEqual(statuses(), ["vendor/lib is a directory (submodule or nested repository)"]);
  assert.equal(shownBuffers().length, 0);
  assert.equal(fake.openBuffers().size, 0, "the first build's buffers are closed");
});

test("select, select, activate on one row (a double-click): one set of git reads, one view (R14)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await click(5, "c:b.md");
  await fake.widget("activate", { index: 5, key: "c:b.md" });
  await fake.advance(50);
  assert.equal(catFiles().length, 2);
  assert.equal(shownBuffers().length, 1);
  assert.equal(fake.openBuffers().size, 3);
  // Once built, a later click builds a fresh snapshot.
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(catFiles().length, 4);
  assert.equal(fake.openBuffers().size, 3);
});

test("closing the diff tab leaves no buffer behind (R14)", async () => {
  await loadAcceptance();
  const before = fake.openBuffers();
  await click(5, "c:b.md");
  await fake.advance(50);
  await fake.closeTab(shownBuffers()[0]);
  await fake.advance(50);
  assert.deepEqual(fake.openBuffers(), before);
  // Nothing more is closed when an unrelated buffer closes.
  fake.clear();
  await fake.emit("buffer_closed", { buffer_id: 9999, window_id: 1 });
  assert.equal(fake.named("closeBuffer").length, 0);
});

test("refused diffs: binary, over 5 MiB, unreadable; a message and no buffer (R14)", async () => {
  const records = [untracked("img.png"), untracked("nul.txt"), untracked("big.txt"), mod("M.", "huge.bin"), untracked("old.bin")];
  await load({ status: raw({ records }), code: 0, blobs: { "HEAD:huge.bin": "x", ":0:huge.bin": "y" }, blobSizes: { ":0:huge.bin": 6 * 1024 * 1024 } });
  await fake.advance(200);
  // keys: g:s s:huge.bin g:c c:big.txt c:img.png c:nul.txt c:old.bin
  for (const f of ["img.png", "nul.txt", "big.txt", "old.bin"]) fake.files.add(`/repo/${f}`);
  // Not valid UTF-8: what 0.5.9 really returns, and what its type file says.
  fake.contents.set("/repo/img.png", undefined);
  fake.contents.set("/repo/old.bin", null);
  fake.contents.set("/repo/nul.txt", "a\0b");
  fake.sizes.set("/repo/big.txt", 6 * 1024 * 1024);
  fake.clear();
  await click(4, "c:img.png");
  await fake.advance(50);
  await click(5, "c:nul.txt");
  await fake.advance(50);
  await click(3, "c:big.txt");
  await fake.advance(50);
  await click(1, "s:huge.bin");
  await fake.advance(50);
  await click(6, "c:old.bin");
  await fake.advance(50);
  // `readFile` gives no text for a file that is not UTF-8, and gives no
  // reason: it could as well be unreadable.
  assert.deepEqual(statuses(), [
    "img.png is binary or could not be read; no diff shown",
    "nul.txt is binary; no diff shown",
    "big.txt is larger than 5 MiB; no diff shown",
    "huge.bin is larger than 5 MiB; no diff shown",
    "old.bin is binary or could not be read; no diff shown",
  ]);
  assert.ok(!fake.named("debug").some((c) => String(c.args[0]).includes("threw")), "nothing threw");
  // The big file is not read, and the big blob's content is never asked for
  // (the two sides are read at once, each its size first).
  assert.ok(!fake.named("readFile").some((c) => c.args[0] === "/repo/big.txt"));
  assert.deepEqual(catFiles().map((p) => p.args.slice(2)), [["-s", "HEAD:huge.bin"], ["-s", ":0:huge.bin"], ["blob", "HEAD:huge.bin"]]);
  assert.equal(fake.named("createVirtualBuffer").length, 0);
  assert.equal(fake.openBuffers().size, 0);
});

test("a working-tree file gone between its stat and its read diffs against an empty side, not as binary (R14)", async () => {
  await load({ status: raw({ records: [untracked("new.txt")] }), code: 0 });
  await fake.advance(200);
  fake.files.add("/repo/new.txt");
  fake.contents.set("/repo/new.txt", "text\n");
  fake.clear();
  // The stat finds the file; the read finds nothing, and neither does a second stat.
  fake.returns.set("fileStat", [{ isFile: true, isDir: false, size: 5, readonly: false }, null]);
  fake.returns.set("readFile", [undefined]);
  await click(2, "c:new.txt");
  await fake.advance(50);
  assert.deepEqual(statuses(), [DIFF_HINT]);
  assert.deepEqual(sourceTexts(), ["", ""]);
});

test("a composite the host refuses (a throw or rejection) leaves no source buffer behind (R14)", async () => {
  await loadAcceptance();
  let fail!: (e: Error) => void;
  fake.compositeGate = new Promise<void>((_, r) => (fail = r));
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(fake.openBuffers().size, 2, "sources made, composite pending");
  fail(new Error("options do not match the type"));
  await fake.advance(50);
  assert.equal(fake.openBuffers().size, 0);
  assert.equal(shownBuffers().length, 0);
  assert.ok(fake.named("debug").some((c) => String(c.args[0]).includes("openDiff threw")), "logged");
  assert.deepEqual(rejections, []);
});

test("a git object that cannot be read gives git's reason and no buffer", async () => {
  await loadAcceptance({ blobs: {} });
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.deepEqual(statuses(), ["could not read b.md: path ':0:b.md' does not exist"]);
  assert.equal(fake.named("createVirtualBuffer").length, 0);
});

test("authority_changed in the middle of a build leaves no buffers", async () => {
  await loadAcceptance();
  let release!: () => void;
  fake.compositeGate = new Promise<void>((r) => (release = r));
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(fake.openBuffers().size, 2, "sources made, composite pending");
  // An attach: the label changes.
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  release();
  await fake.advance(50);
  assert.equal(shownBuffers().length, 0);
  assert.equal(fake.openBuffers().size, 0);
  // Also when the change lands while git is reading.
  fake.compositeGate = null;
  fake.clear();
  await fake.advance(1000);
  await click(5, "c:b.md");
  await fake.emit("authority_changed", { label: "" });
  await fake.advance(50);
  assert.equal(fake.named("createVirtualBuffer").length, 0);
});

test("in a bind-mounted dev container, every git read of a diff runs on the host (R13)", async () => {
  fake.label = "Container:abc";
  await loadAcceptance({ inspect: BIND_INSPECT, pwd: BIND_PWD });
  await click(5, "c:b.md");
  await click(1, "s:a.ts");
  await fake.advance(50);
  // b.md's first read (its object id), overtaken by the second click, then
  // a.ts's: two ids, then each side's size and content.
  assert.deepEqual(resolved(), [":0:b.md", "HEAD:a.ts", ":0:a.ts"]);
  assert.equal(catFiles().length, 4);
  for (const p of fake.gitCalls().filter((c) => !c.args.includes("status"))) {
    assert.equal(p.via, "host");
    assert.equal(p.cwd, "/repo");
  }
  assert.equal(shownBuffers().length, 1);
});

test("volume workspace: a click, Enter or palette command runs no git (R13)", async () => {
  fake.label = "Container:vol";
  await load({ status: ACCEPTANCE, code: 0, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD, blobs: ACC_BLOBS });
  await fake.advance(1000);
  fake.clear();
  await click(0, "c:b.md");
  await fake.widget("activate", { index: 0, key: "c:b.md" });
  await fake.command("Git Sidebar: View Diff");
  await fake.command("Git Sidebar: View File");
  await fake.advance(1000);
  assert.deepEqual(fake.gitCalls(), []);
  assert.equal(fake.named("createVirtualBuffer").length + fake.named("openFile").length, 0);
  assert.ok(statuses().length >= 3);
});

// ---------------------------------------------------------------------------
// R18 (first half), R7: View File and View Diff from the palette
// ---------------------------------------------------------------------------

test("palette: View File and View Diff act on the selected row; nothing selected gives a message (R18, R7)", async () => {
  await loadAcceptance();
  assert.ok(fake.palette().has("Git Sidebar: View Diff") && fake.palette().has("Git Sidebar: View File"));
  // Nothing selected yet.
  await fake.command("Git Sidebar: View File");
  await fake.command("Git Sidebar: View Diff");
  assert.deepEqual(statuses(), [`${NOTHING_SELECTED}`, `${NOTHING_SELECTED}`]);
  assert.deepEqual(fake.gitCalls(), []);
  fake.clear();
  await fake.widget("select", { index: 5, key: "c:b.md" });
  await fake.command("Git Sidebar: View File");
  assert.deepEqual(fake.named("openFile").map((c) => c.args[0]), ["/repo/b.md"]);
  await fake.command("Git Sidebar: View Diff");
  await fake.advance(50);
  assert.equal(shownBuffers().length, 1);
  // gone.ts: "deleted", and no buffer.
  fake.clear();
  await fake.widget("select", { index: 6, key: "c:gone.ts" });
  await fake.command("Git Sidebar: View File");
  assert.equal(fake.named("openFile").length, 0);
  assert.deepEqual(statuses(), ["gone.ts is deleted"]);
});

test("palette context: on while rows are shown, off under a notice, after giving up and at the end (R18)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD };
  await load(repo);
  assert.equal(fake.contextOn("git-sidebar-rows"), false, "the placeholder has no rows");
  await fake.advance(200);
  assert.equal(fake.contextOn("git-sidebar-rows"), true);
  assert.ok([...fake.palette().values()].every((listed) => listed));
  fake.label = "Container:vol";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(1000);
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
  // Under the notice only Focus is listed (R22, A18).
  assert.deepEqual(listedNow(), [FOCUS]);
  fake.label = "";
  await fake.emit("authority_changed", { label: "" });
  await fake.advance(1000);
  assert.equal(fake.contextOn("git-sidebar-rows"), true);
  await fake.widget("cancel");
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
  assert.equal(fake.contextOn("git-sidebar-shown"), false);
  assert.deepEqual(listedNow(), [], "nothing after the end");
});

test("palette context stays off when git gives up before showing anything", async () => {
  await load({ status: "", code: 128 });
  await fake.advance(1000);
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
  // The clears at load (F14); then the placeholder is shown, and taken down
  // with Focus when git gives up (R22).
  assert.deepEqual(fake.named("setContext").map((c) => c.args), [
    ["git-sidebar-rows", false],
    ["git-sidebar-shown", false],
    ["git-sidebar-shown", true],
    ["git-sidebar-shown", false],
  ]);
  assert.deepEqual(listedNow(), []);
});

// ---------------------------------------------------------------------------
// R15: stage and unstage one file
// ---------------------------------------------------------------------------

const RENAME = [`2 R. N... 100644 100644 100644 ${H} ${H} R100 moved.ts`, "old.ts"];
/** The acceptance repository after staging `staged` of its Changes files. */
function accAfter(...staged: string[]): string {
  const st = new Set(staged);
  const records: string[] = [];
  // Staged, by path: a.ts (staged already), b.md, gone.ts, moved.ts.
  records.push(mod(st.has("a.ts") ? "M." : "MM", "a.ts"));
  if (st.has("b.md")) records.push(mod("M.", "b.md"));
  else records.push(mod(".M", "b.md"));
  records.push(mod(st.has("gone.ts") ? "D." : ".D", "gone.ts"));
  records.push(...RENAME);
  records.push(st.has("new/c.txt") ? mod("A.", "new/c.txt") : untracked("new/c.txt"));
  records.push(untracked("new/d.txt"));
  return raw({ records });
}

/** Space on the row the host has selected now: the index the user
 *  selected, or the last one the plugin pushed (the host keeps its index
 *  across updates and follows each push). */
async function spaceOnSelected(selected: number, since: number): Promise<string> {
  const pushed = fake.calls
    .slice(since)
    .filter((c) => c.name === "widgetMutate")
    .map((c) => c.args[1] as { kind: string; index?: number })
    .filter((m) => m.kind === "setSelectedIndex")
    .at(-1)?.index;
  const index = pushed ?? selected;
  const key = lastShown().itemKeys[index];
  await fake.widget("activate", { index, key, via: "space" });
  return key;
}

const groupRows = (spec: TreeSpec, group: "g:s" | "g:c") => {
  const g = spec.itemKeys.indexOf(group);
  const out: string[] = [];
  for (let i = g + 1; i < spec.itemKeys.length && !spec.itemKeys[i].startsWith("g:"); i++) out.push(spec.itemKeys[i]);
  return out;
};

test("rows show + under Changes and − under Staged, on files and non-empty groups (R5, R15, R16)", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  await fake.advance(200);
  assert.deepEqual(
    lastShown().nodes.map((n) => n.action ?? null),
    ["−", "−", "−", "+", "+", "+", "+", "+", "+"],
  );
});

test("conflicted rows have no button; a clean repository has no group buttons (R15, R16)", async () => {
  await load({ status: fixture("conflict"), code: 0 });
  await fake.advance(200);
  // g:s (empty), g:c (lists files), then three conflicted rows.
  assert.deepEqual(lastShown().nodes.map((n) => n.action ?? null), [null, "+", null, null, null]);
});

test("clean repository: no group buttons; Space on an empty group does nothing (R16)", async () => {
  await load({ status: fixture("clean"), code: 0 });
  await fake.advance(200);
  assert.ok(lastShown().nodes.every((n) => !("action" in n)));
  fake.clear();
  await fake.widget("activate", { index: 1, key: "g:c", via: "space" });
  await fake.widget("activate", { index: 0, key: "g:s", via: "space" });
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), []);
  assert.deepEqual(mutations(), [], "no toggle either");
});

test("+ on b.md: exactly one literal add in the root, then b.md is listed under Staged within 2 s (R15)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  repo.onWrite = () => {
    repo.status = accAfter("b.md");
  };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(2000);
  const ws = writeCalls();
  assert.deepEqual(ws.map((p) => [p.args, p.cwd, p.via]), [[["--literal-pathspecs", "add", "--", "b.md"], "/repo", "target"]]);
  // A status run followed the write.
  const order = fake.gitCalls().map((p) => p.args[0]);
  assert.equal(order.indexOf("--literal-pathspecs"), 0);
  assert.ok(order.lastIndexOf("--no-optional-locks") > 0);
  assert.deepEqual(groupRows(lastShown(), "g:s"), ["s:a.ts", "s:b.md", "s:moved.ts"]);
  assert.ok(!lastShown().itemKeys.includes("c:b.md"));
  assert.deepEqual(statuses(), []);
});

test("repeated Space works down Changes even as Staged grows; no group op runs (R15, R10, critique F1)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  const staged: string[] = [];
  repo.onWrite = (c) => {
    staged.push(c.args.at(-1)!);
    repo.status = accAfter(...staged);
  };
  await load(repo);
  await fake.advance(200);
  const since = fake.calls.length;
  await fake.widget("select", { index: 4, key: "c:a.ts" });
  for (let i = 0; i < 3; i++) {
    await spaceOnSelected(4, since);
    await fake.advance(1000);
  }
  assert.deepEqual(writes(), [
    ["--literal-pathspecs", "add", "--", "a.ts"],
    ["--literal-pathspecs", "add", "--", "b.md"],
    ["--literal-pathspecs", "update-index", "--remove", "--", "gone.ts"],
  ]);
  const spec = lastShown();
  assert.equal(spec.itemKeys[spec.selectedIndex], "c:new/c.txt");
  const later = fake.calls.slice(since).filter((c) => c.name === "widgetMutate").map((c) => c.args[1] as { kind: string });
  assert.ok(!later.some((m) => m.kind === "setExpandedKeys"), "no group toggled");
  // The host was told where the selection went.
  assert.deepEqual(later.filter((m) => m.kind === "setSelectedIndex").at(-1), {
    kind: "setSelectedIndex",
    widgetKey: "git",
    index: spec.selectedIndex,
  });
});

test("− on a staged rename resets both paths; a Changes rename (.R) removes its original, then adds its new path (R15)", async () => {
  const records = [...RENAME, `2 .R N... 100644 100644 100644 ${H} ${H} R100 new.txt`, "was.txt"];
  await load({ status: raw({ records }), code: 0 });
  await fake.advance(200);
  // keys: g:s s:moved.ts g:c c:new.txt
  await fake.widget("action", { index: 1, key: "s:moved.ts", via: "click" });
  await fake.advance(1000);
  await fake.widget("action", { index: 3, key: "c:new.txt", via: "click" });
  await fake.advance(1000);
  assert.deepEqual(writes(), [
    ["--literal-pathspecs", "reset", "-q", "--", "moved.ts", "old.ts"],
    // The original is deleted: never given to `add` (INV §8 P23 e).
    ["--literal-pathspecs", "update-index", "--remove", "--", "was.txt"],
    ["--literal-pathspecs", "add", "--", "new.txt"],
  ]);
});

test("a doubled button press, or Space again before the refresh draws, writes once (R15)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  repo.onWrite = () => {
    repo.status = accAfter("b.md");
  };
  await load(repo);
  await fake.advance(200);
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(10);
  assert.equal(writes().length, 1);
  // The write is done; its refresh has not been drawn yet.
  await fake.widget("activate", { index: 5, key: "c:b.md", via: "space" });
  await fake.advance(2000);
  assert.equal(writes().length, 1);
  // Other rows are not held up.
  await fake.widget("action", { index: 1, key: "s:a.ts", via: "click" });
  await fake.advance(50);
  assert.equal(writes().length, 2);
});

test("a write's row stays held while the host refuses to draw the status after it (R15, F13)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  repo.onWrite = () => {
    repo.status = accAfter("b.md");
  };
  await load(repo);
  await fake.advance(200);
  // The host refuses the next draw, whether a remount or an in-place update.
  fake.returns.set("mountSidebarSection", [false]);
  fake.returns.set("updateFloatingWidget", [false]);
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(1000);
  assert.equal(writes().length, 1);
  assert.equal(sentSpecs().length, 1, "the refresh after the write was refused");
  // b.md's row, with its `+`, is still on screen: a press on it is the same request.
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(10);
  assert.equal(writes().length, 1);
});

test("while statuses fail after a write, a press on its row acts again rather than being dropped in silence (R15, R10)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  let locked = true;
  repo.onWrite = () => (locked ? { code: 128, stdout: "", stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.\n" } : undefined);
  await load(repo);
  await fake.advance(200);
  // Every later status fails; R10 keeps the rows.
  repo.statusOutcome = () => ({ code: 1, stdout: "", stderr: "error: something went wrong" });
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(2000);
  assert.deepEqual(statuses(), ["could not stage b.md: Unable to create '.git/index.lock': File exists."]);
  assert.ok(fake.gitCalls().some((p) => p.args.includes("status")), "a status ran, and failed");
  locked = false;
  await fake.widget("activate", { index: 5, key: "c:b.md", via: "space" });
  await fake.advance(50);
  assert.equal(writes().length, 2);
});

test("a status that was running across a write is not drawn; the next one is (R15)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  const pending = deferred();
  let first = true;
  repo.statusOutcome = () => {
    if (!first) return { code: 0, stdout: repo.status, stderr: "" };
    first = false;
    return pending.outcome;
  };
  repo.onWrite = () => {
    repo.status = accAfter("b.md");
  };
  await fake.emit("after_file_save", {});
  await fake.advance(150);
  assert.equal(fake.gitCalls().filter((p) => p.args.includes("status")).length, 2, "a status is running");
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(10);
  // The old status comes back after the write, with what it saw before it.
  pending.resolve({ code: 0, stdout: raw({ records: [untracked("stale.txt")] }), stderr: "" });
  await fake.advance(2000);
  for (const spec of sentSpecs()) assert.ok(!texts(spec).includes("U stale.txt"), "stale status drawn");
  assert.deepEqual(groupRows(lastShown(), "g:s"), ["s:a.ts", "s:b.md", "s:moved.ts"]);
});

test("a held index.lock: git's reason in the status bar, rows unchanged, and Space works again later (R15)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  let locked = true;
  repo.onWrite = () =>
    locked
      ? { code: 128, stdout: "", stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running.\n" }
      : undefined;
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(2000);
  assert.deepEqual(statuses(), ["could not stage b.md: Unable to create '.git/index.lock': File exists."]);
  assert.deepEqual(fake.widgetCalls(), [], "the rows did not change");
  assert.ok(fake.gitCalls().some((p) => p.args.includes("status")), "the actual status was read");
  locked = false;
  await fake.widget("activate", { index: 5, key: "c:b.md", via: "space" });
  await fake.advance(50);
  assert.equal(writes().length, 2);
});

test("Space on a conflicted row, or a directory row: a message and no write (R15)", async () => {
  await load({ status: fixture("conflict"), code: 0 });
  await fake.advance(200);
  fake.clear();
  // keys: g:s g:c c:aa.txt c:du.txt c:uu.txt
  await fake.widget("activate", { index: 4, key: "c:uu.txt", via: "space" });
  await fake.widget("action", { index: 4, key: "c:uu.txt", via: "click" });
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), [
    "uu.txt has a merge conflict; resolve it with git first",
    "uu.txt has a merge conflict; resolve it with git first",
  ]);
});

test("in a bind-mounted dev container, writes run on the host in the root (R13, R15)", async () => {
  fake.label = "Container:abc";
  await load({ status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD });
  await fake.advance(200);
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(50);
  assert.deepEqual(writeCalls().map((p) => [p.via, p.cwd]), [["host", "/repo"]]);
});

test("a write queued across a trust change is not run, and says why; after the end it is not run and says nothing (R15)", async () => {
  const first = deferred();
  let n = 0;
  const repo: Repo = { status: ACCEPTANCE, code: 0, onWrite: () => (n++ === 0 ? first.outcome : undefined) };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.widget("action", { index: 1, key: "s:a.ts", via: "click" });
  await fake.advance(10);
  // A trust change keeps the mode already found: not "finding out where git runs".
  await fake.emit("trust_changed", { level: "trusted" });
  first.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(10);
  assert.equal(writes().length, 1);
  assert.deepEqual(statuses(), ["unstage a.ts: not run; the workspace's authority or trust changed after it was asked for"]);
  // The window closes with a write queued: nobody to tell.
  const second = deferred();
  repo.onWrite = () => second.outcome;
  await fake.advance(2000);
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.widget("action", { index: 1, key: "s:a.ts", via: "click" });
  await fake.advance(10);
  await fake.widget("cancel", {});
  second.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(10);
  assert.equal(writes().length, 1);
  assert.deepEqual(statuses(), []);
});

test("a write is refused while the mode is being found again, and never runs in volume mode (R13)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD };
  await load(repo);
  await fake.advance(200);
  fake.label = "Container:vol";
  await fake.emit("authority_changed", { label: fake.label });
  fake.clear();
  await fake.widget("activate", { index: 5, key: "c:b.md", via: "space" });
  assert.deepEqual(statuses(), ["finding out where git runs; try again in a moment"]);
  await fake.advance(1000);
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
  await fake.widget("action", { index: 0, key: "c:b.md", via: "click" });
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
});

// ---------------------------------------------------------------------------
// R16: stage all and unstage all
// ---------------------------------------------------------------------------

test("+ on Changes: a fresh status, then one literal add -A of every path; no toggle (R16)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  repo.onWrite = () => {
    repo.status = accAfter("b.md", "gone.ts", "new/c.txt");
  };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("action", { index: 3, key: "g:c", via: "click" });
  await fake.advance(1000);
  const args = fake.gitCalls().map((p) => p.args.slice(0, 2).join(" "));
  assert.equal(args[0], "--no-optional-locks status", "the plan comes from a fresh status");
  // The deletion first, in its own `update-index --remove` (F1, INV §8 P23).
  assert.deepEqual(writes(), [
    ["--literal-pathspecs", "update-index", "--remove", "--", "gone.ts"],
    ["--literal-pathspecs", "add", "-A", "--", "a.ts", "b.md", "new/c.txt", "new/d.txt"],
  ]);
  assert.ok(!mutations().some((m) => m.kind === "setExpandedKeys"), "the group did not toggle");
  assert.deepEqual(statuses(), []);
  // Space on the group does the same; Enter still toggles.
  fake.clear();
  await fake.widget("activate", { index: 0, key: "g:s", via: "space" });
  await fake.advance(1000);
  assert.equal(writes()[0][1], "reset");
  await fake.widget("activate", { index: 0, key: "g:s" });
  assert.deepEqual(mutations().filter((m) => m.kind === "setExpandedKeys").length, 1);
});

test("stage all covers paths past the 500-row cap (R16)", async () => {
  const records = manyUntracked(1200);
  const status = raw({ records });
  await load({ status, code: 0 });
  await fake.advance(200);
  assert.equal(lastShown().itemKeys.at(-1), "more:c");
  await fake.widget("activate", { index: 1, key: "g:c", via: "space" });
  await fake.advance(1000);
  const paths = writes().flatMap(pathsOf);
  assert.equal(paths.length, 1200);
  assert.equal(new Set(paths).size, 1200);
});

test("during a merge: stage all skips the UU path and says so; unstage all keeps it (R16)", async () => {
  await load({ status: fixture("merge"), code: 0 });
  await fake.advance(200);
  // keys: g:s s:s.txt g:c c:uu.txt
  fake.clear();
  await fake.widget("action", { index: 2, key: "g:c", via: "click" });
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), ["staged 0; skipped 1: 1 with a merge conflict (resolve with git first)"]);
  fake.clear();
  await fake.widget("action", { index: 0, key: "g:s", via: "click" });
  await fake.advance(1000);
  assert.deepEqual(writes(), [["--literal-pathspecs", "reset", "-q", "--", "s.txt"]]);
  // git's "needs merge" on rc 0 is success (P13 i).
  assert.deepEqual(statuses(), []);
});

test("unstage all with git's `needs merge` on stderr is success, not a failure (P13 i, vi)", async () => {
  const repo: Repo = { status: fixture("merge"), code: 0, onWrite: () => ({ code: 0, stdout: "", stderr: "uu.txt: needs merge\n" }) };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("activate", { index: 0, key: "g:s", via: "space" });
  await fake.advance(1000);
  assert.equal(writes().length, 1);
  assert.deepEqual(statuses(), []);
});

test("a failing chunk stops the rest: staged N of M with git's reason (R16)", async () => {
  const records = manyUntracked(1200, "some/fairly/deep/directory/file-");
  let n = 0;
  const repo: Repo = {
    status: raw({ records }),
    code: 0,
    onWrite: () => (++n === 2 ? { code: 128, stdout: "", stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.\n" } : undefined),
  };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("activate", { index: 1, key: "g:c", via: "space" });
  await fake.advance(1000);
  assert.equal(writes().length, 2, "stopped after the failure");
  const first = writes()[0];
  const done = pathsOf(first).length;
  assert.deepEqual(statuses(), [`staged ${done} of 1200: Unable to create '.git/index.lock': File exists.`]);
});

test("staging the last Changes file leaves the selection on the group row; Space there does nothing", async () => {
  const repo: Repo = { status: raw({ records: [mod(".M", "only.txt")] }), code: 0 };
  repo.onWrite = () => {
    repo.status = raw({ records: [mod("M.", "only.txt")] });
  };
  await load(repo);
  await fake.advance(200);
  // keys: g:s g:c c:only.txt
  await fake.widget("activate", { index: 2, key: "c:only.txt", via: "space" });
  await fake.advance(1000);
  const spec = lastShown();
  // keys now: g:s s:only.txt g:c
  assert.equal(spec.itemKeys[spec.selectedIndex], "g:c");
  assert.equal(spec.nodes[spec.selectedIndex].action, undefined, "an empty group has no button");
  await fake.widget("activate", { index: spec.selectedIndex, key: "g:c", via: "space" });
  await fake.advance(1000);
  assert.equal(writes().length, 1);
});

test("a group op across an authority change stops and only logs", async () => {
  const records = manyUntracked(1200, "some/fairly/deep/directory/file-");
  const gate = deferred();
  let first = true;
  const repo: Repo = {
    status: raw({ records }),
    code: 0,
    onWrite: () => {
      if (!first) return undefined;
      first = false;
      return gate.outcome;
    },
  };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("activate", { index: 1, key: "g:c", via: "space" });
  await fake.advance(50);
  assert.equal(writes().length, 1);
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  gate.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(1000);
  assert.equal(writes().length, 1, "no more chunks after the restart");
  assert.deepEqual(statuses(), []);
});

// ---------------------------------------------------------------------------
// R18: the rest of the palette
// ---------------------------------------------------------------------------

/** The commands listed while the section shows rows (R18). */
const ROW_COMMANDS = [
  "Git Sidebar: Commit…",
  "Git Sidebar: Resolve Conflict",
  "Git Sidebar: Stage All",
  "Git Sidebar: Stage or Unstage",
  "Git Sidebar: Unstage All",
  "Git Sidebar: View Diff",
  "Git Sidebar: View File",
];

test("eight commands are registered: the row commands under the rows context, Focus under the shown one (R18, R22)", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  assert.equal(fake.palette().size, 8);
  assert.deepEqual([...fake.palette().keys()].sort(), [...ROW_COMMANDS, FOCUS].sort());
  for (const c of fake.named("registerCommand")) {
    assert.equal(c.args[3], c.args[0] === FOCUS ? "git-sidebar-shown" : "git-sidebar-rows", String(c.args[0]));
  }
  assert.equal(fake.named("registerCommand").find((c) => c.args[0] === FOCUS)!.args[2], "gitSidebar_focus");
  await fake.advance(200);
  assert.ok([...fake.palette().values()].every((listed) => listed));
});

test("with nothing selected, the row commands say so and run no git (R18, A18)", async () => {
  await loadAcceptance();
  for (const name of ["Git Sidebar: View Diff", "Git Sidebar: View File", "Git Sidebar: Stage or Unstage"]) await fake.command(name);
  await fake.advance(1000);
  assert.deepEqual(statuses(), Array(3).fill(`${NOTHING_SELECTED}`));
  assert.deepEqual(fake.gitCalls().filter((p) => !p.args.includes("status")), []);
  assert.equal(fake.named("openFile").length + fake.named("createVirtualBuffer").length, 0);
});

test("Stage or Unstage acts on the selected file like its button (R18, R15)", async () => {
  await loadAcceptance();
  await fake.widget("select", { index: 5, key: "c:b.md" });
  await fake.command("Git Sidebar: Stage or Unstage");
  await fake.advance(1000);
  await fake.widget("select", { index: 2, key: "s:moved.ts" });
  await fake.command("Git Sidebar: Stage or Unstage");
  await fake.advance(1000);
  assert.deepEqual(writes(), [
    ["--literal-pathspecs", "add", "--", "b.md"],
    ["--literal-pathspecs", "reset", "-q", "--", "moved.ts", "old.ts"],
  ]);
  // On a group row it does not stage the whole group.
  fake.clear();
  await fake.widget("select", { index: 3, key: "g:c" });
  await fake.command("Git Sidebar: Stage or Unstage");
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.equal(statuses().length, 1);
});

test("Stage All and Unstage All act on their group whichever row is selected (R18, R16)", async () => {
  await loadAcceptance();
  await fake.command("Git Sidebar: Stage All");
  await fake.advance(1000);
  await fake.widget("select", { index: 5, key: "c:b.md" });
  await fake.command("Git Sidebar: Unstage All");
  await fake.advance(1000);
  assert.deepEqual(writes(), [
    ["--literal-pathspecs", "update-index", "--remove", "--", "gone.ts"],
    ["--literal-pathspecs", "add", "-A", "--", "a.ts", "b.md", "new/c.txt", "new/d.txt"],
    ["--literal-pathspecs", "reset", "-q", "--", "a.ts", "moved.ts", "old.ts"],
  ]);
});

test("volume mode: the context is off, and a command run anyway changes nothing (R18, R13)", async () => {
  fake.label = "Container:vol";
  await load({ status: ACCEPTANCE, code: 0, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD });
  await fake.advance(1000);
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
  assert.deepEqual(listedNow(), [FOCUS], "only Focus under the notice (A18)");
  for (const name of ROW_COMMANDS) await fake.command(name);
  await fake.advance(1000);
  assert.deepEqual(fake.gitCalls(), []);
  assert.equal(statuses().length, ROW_COMMANDS.length);
});

// ---------------------------------------------------------------------------
// R17: the right-click menu
// ---------------------------------------------------------------------------

const menuMounts = () =>
  fake.named("mountFloatingWidget").map((c) => ({
    id: c.args[0] as number,
    labels: ((c.args[1] as { children: { label: string }[] }).children ?? []).map((b) => b.label.trim()),
  }));
const rightClick = (index: number, key: string, col = 7, row = 24) => fake.widget("context", { index, key, col, row });
const choose = (choice: string) => fake.widget("activate", {}, { panel: 2, widgetKey: `menu:${choice}` });

test("right-click: a menu at the pointer listing the row's actions (R17, A17)", async () => {
  await loadAcceptance();
  await rightClick(5, "c:b.md");
  await rightClick(2, "s:moved.ts");
  await rightClick(0, "g:s");
  await rightClick(3, "g:c");
  assert.deepEqual(menuMounts(), [
    { id: 2, labels: ["View Diff", "View File", "Stage"] },
    { id: 2, labels: ["View Diff", "View File", "Unstage"] },
    { id: 2, labels: ["Unstage All", "Commit…"] },
    { id: 2, labels: ["Stage All"] },
  ]);
  // Anchored under the cell the host reported, each time.
  const anchors = fake.named("floatingPanelControl").map((c) => c.args);
  assert.equal(anchors.length, 4);
  for (const a of anchors) assert.deepEqual(a, [2, "anchor", 25 * 65536 + 7]);
  // A right-click does not move the selection.
  assert.deepEqual(mutations(), []);
});

test("right-click on `… N more`, a notice or an empty group: no menu (R17)", async () => {
  const records = manyUntracked(600);
  await load({ status: raw({ records }), code: 0 });
  await fake.advance(200);
  const keys = lastShown().itemKeys;
  await rightClick(keys.length - 1, "more:c");
  await rightClick(0, "g:s");
  await rightClick(0, "n:notice");
  assert.deepEqual(fake.named("mountFloatingWidget"), []);
});

test("menu choices do what the same action does elsewhere (R17)", async () => {
  await loadAcceptance();
  // Stage: the same git call as the + button.
  await rightClick(5, "c:b.md");
  await choose("stage");
  await fake.advance(1000);
  assert.deepEqual(writes(), [["--literal-pathspecs", "add", "--", "b.md"]]);
  assert.deepEqual(fake.named("unmountFloatingWidget").map((c) => c.args[0]), [2]);
  // View File and View Diff.
  await rightClick(4, "c:a.ts");
  await choose("file");
  assert.deepEqual(fake.named("openFile").map((c) => c.args[0]), ["/repo/a.ts"]);
  await rightClick(1, "s:a.ts");
  await choose("diff");
  await fake.advance(50);
  assert.equal(compositeOpts().at(-1)!.name, "a.ts (HEAD ↔ staged)");
  // Unstage All on the group.
  await rightClick(0, "g:s");
  await choose("unstageAll");
  await fake.advance(1000);
  assert.deepEqual(writes().at(-1), ["--literal-pathspecs", "reset", "-q", "--", "a.ts", "moved.ts", "old.ts"]);
});

test("a menu choice for a row that has gone since: a message, nothing else (R17)", async () => {
  const repo = await loadAcceptance();
  await rightClick(5, "c:b.md");
  repo.status = accAfter("b.md");
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  fake.clear();
  await choose("stage");
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), ["b.md is no longer listed"]);
});

test("Esc on the menu (panel 2 cancel) changes nothing and leaves the section live (R17)", async () => {
  const repo = await loadAcceptance();
  await rightClick(5, "c:b.md");
  await fake.widget("cancel", {}, { panel: 2, widgetKey: "menu:diff" });
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.equal(sectionUnmounts().length, 0);
  assert.ok(fake.armedTimers() > 0, "refresh still armed");
  // Still refreshing, and still drawing.
  repo.status = raw({ records: [untracked("later.txt")] });
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.ok(texts(lastShown()).includes("U later.txt"));
  // A choice after the cancel has no menu to act for.
  await choose("stage");
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
});

test("a new right-click replaces the open menu, and acts for the new row (R17)", async () => {
  await loadAcceptance();
  await rightClick(5, "c:b.md");
  await rightClick(6, "c:gone.ts");
  await choose("stage");
  await fake.advance(1000);
  assert.equal(menuMounts().length, 2);
  // A deletion stages with `update-index --remove` (R15, F1, INV §8 P23).
  assert.deepEqual(writes(), [["--literal-pathspecs", "update-index", "--remove", "--", "gone.ts"]]);
});

// ---------------------------------------------------------------------------
// Review fixes (INV §8 "Review fixes")
// ---------------------------------------------------------------------------

const FINDING = "finding out where git runs; try again in a moment";

test("a write that outlives its 60 s timeout is never killed, holds the queue until git exits, and its end is reported (F0, R15)", async () => {
  const slow = deferred();
  let n = 0;
  const repo: Repo = { status: ACCEPTANCE, code: 0, onWrite: () => (n++ === 0 ? slow.outcome : undefined) };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  // Past the 10 s a read gets, short of the write's 60 s.
  await fake.advance(30_000);
  assert.deepEqual(statuses(), []);
  await fake.advance(31_000);
  assert.equal(fake.kills, 0, "a killed git would leave .git/index.lock");
  assert.deepEqual(statuses(), ["stage b.md: git is still running after 60 s"]);
  // The next write waits: git still holds index.lock. So does a press on b.md again.
  await fake.widget("action", { index: 3, key: "g:c", via: "click" });
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  await fake.advance(30_000);
  assert.equal(writes().length, 1, "only b.md's, still running");
  // Git fails after the message: that is reported too, and the queue goes on.
  slow.resolve({ code: 128, stdout: "", stderr: "fatal: unable to write new index file\n" });
  await fake.advance(1_000);
  assert.equal(statuses()[1], "could not stage b.md: unable to write new index file");
  assert.deepEqual(writes().slice(1).map((a) => a[1]), ["update-index", "add"], "stage all ran after it");
  assert.equal(fake.kills, 0);
});

test("a group chunk that outlives its timeout is waited for; the rest still run, and the end is reported (F0, R16)", async () => {
  const slow = deferred();
  let n = 0;
  await load({ status: ACCEPTANCE, code: 0, onWrite: () => (n++ === 0 ? slow.outcome : undefined) });
  await fake.advance(200);
  fake.clear();
  await fake.widget("action", { index: 3, key: "g:c", via: "click" });
  await fake.advance(61_000);
  assert.equal(writes().length, 1);
  assert.equal(fake.kills, 0);
  assert.deepEqual(statuses(), ["staged 0 of 5: git is still running after 60 s"]);
  slow.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(1_000);
  assert.deepEqual(writes().map((a) => a[1]), ["update-index", "add"], "the rest ran after it");
  assert.deepEqual(statuses(), ["staged 0 of 5: git is still running after 60 s", "staged 5"]);
});

test("one text per side feeds its buffer and the line diff: a final-newline change is shown (R14, F3)", async () => {
  await load({ status: raw({ records: [mod(".M", "blank.txt"), mod(".M", "eol.txt")] }), code: 0, blobs: { ":0:blank.txt": "a\n", ":0:eol.txt": "a" } });
  await fake.advance(200);
  fake.files.add("/repo/blank.txt");
  fake.contents.set("/repo/blank.txt", "a\n\n");
  fake.files.add("/repo/eol.txt");
  fake.contents.set("/repo/eol.txt", "a\n");
  fake.clear();
  const hunks = () => (fake.named("createCompositeBuffer").at(-1)!.args[0] as { hunks: unknown }).hunks;
  // keys: g:s g:c c:blank.txt c:eol.txt
  await click(2, "c:blank.txt");
  await fake.advance(50);
  assert.deepEqual(fake.named("computeLineDiff").map((c) => c.args), [["a\n", "a\n\n"]]);
  // The added blank line is in the right-hand buffer, and is the hunk.
  assert.deepEqual(sourceTexts(), ["a", "a\n"]);
  assert.deepEqual(hunks(), [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 1 }]);
  fake.clear();
  await click(3, "c:eol.txt");
  await fake.advance(50);
  assert.deepEqual(fake.named("computeLineDiff").map((c) => c.args), [["a", "a\n"]]);
  assert.deepEqual(hunks(), [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 1 }], "not an empty diff");
});

test("an untracked file's diff covers the empty side's phantom line, so the host draws no missing row (R14, INV §8 P22)", async () => {
  await load({ status: raw({ records: ["? new.txt"] }), code: 0 });
  await fake.advance(200);
  fake.files.add("/repo/new.txt");
  fake.contents.set("/repo/new.txt", "x\ny\n");
  fake.clear();
  // keys: g:s g:c c:new.txt
  await click(2, "c:new.txt");
  await fake.advance(50);
  const opts = fake.named("createCompositeBuffer").at(-1)!.args[0] as { hunks: unknown };
  assert.deepEqual(opts.hunks, [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 2, ops: "++" }]);
});

test("a row whose name git can't be passed back: no button, and Space, the menu, the palette and the diff run no git for it (F6)", async () => {
  const bad = "caf�.txt";
  await load({ status: raw({ records: [untracked(bad), mod("M.", `s�.txt`)] }), code: 0 });
  await fake.advance(200);
  // keys: g:s s:s�.txt g:c c:caf�.txt
  const spec = lastShown();
  assert.deepEqual(spec.itemKeys, ["g:s", `s:s�.txt`, "g:c", `c:${bad}`]);
  assert.deepEqual(spec.nodes.map((n) => n.action ?? null), ["−", null, "+", null]);
  fake.clear();
  await fake.widget("activate", { index: 3, key: `c:${bad}`, via: "space" });
  await fake.widget("activate", { index: 1, key: `s:s�.txt`, via: "space" });
  await fake.command("Git Sidebar: Stage or Unstage");
  await click(3, `c:${bad}`);
  await fake.advance(1000);
  assert.deepEqual(fake.gitCalls().filter((p) => !p.args.includes("status")), [], "no write and no cat-file");
  assert.equal(fake.named("readFile").length, 0);
  const why = (p: string) => `${p}: the name is not valid UTF-8, so git can't be passed it back`;
  assert.deepEqual(statuses(), [why(bad), why(`s�.txt`), why(`s�.txt`), why(bad)]);
  // The menu offers no Stage for it.
  await fake.widget("context", { index: 3, key: `c:${bad}`, col: 7, row: 24 });
  const menu = fake.named("mountFloatingWidget").at(-1)!.args[1] as { children: { key: string }[] };
  assert.deepEqual(menu.children.map((c) => c.key), ["menu:diff", "menu:file"]);
  // Stage all skips it and says why.
  fake.clear();
  await fake.widget("activate", { index: 2, key: "g:c", via: "space" });
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), ["staged 0; skipped 1: 1 name git can't pass back (not UTF-8)"]);
});

test("a Changes row on a symbolic link: no diff and no read through the link; a Staged one diffs the link text (R14, F7)", async () => {
  await load({ status: fixture("symlink"), code: 0, blobs: { "HEAD:staged-link": "a.txt", ":0:staged-link": "b.txt", ":0:link": "a.txt" } });
  await fake.advance(200);
  // keys: g:s s:staged-file.txt s:staged-link g:c c:file.txt c:link c:new-link
  fake.files.add("/repo/link");
  fake.contents.set("/repo/link", "b\n");
  fake.clear();
  await click(5, "c:link");
  await fake.advance(50);
  await click(4, "c:file.txt");
  await fake.advance(50);
  assert.deepEqual(statuses(), ["link is a symbolic link; no diff shown", "file.txt is a symbolic link; no diff shown"]);
  assert.deepEqual(catFiles(), []);
  assert.equal(fake.named("readFile").length + fake.named("createVirtualBuffer").length, 0);
  await click(2, "s:staged-link");
  await fake.advance(50);
  assert.deepEqual(sourceTexts(), ["a.txt", "b.txt"]);
  assert.equal(shownBuffers().length, 1);
});

test("a write queued behind a group op across an authority change says so, and runs no git while the mode is unknown (F8)", async () => {
  const records = manyUntracked(1200, "some/fairly/deep/directory/file-");
  const gate = deferred();
  const pwd = deferred();
  let first = true;
  const repo: Repo = {
    status: raw({ records: [mod("M.", "a.ts"), ...records] }),
    code: 0,
    pwd: pwd.outcome,
    inspect: BIND_INSPECT,
    onWrite: () => {
      if (!first) return undefined;
      first = false;
      return gate.outcome;
    },
  };
  await load(repo);
  await fake.advance(200);
  fake.clear();
  // keys: g:s s:a.ts g:c c:…
  await fake.widget("activate", { index: 2, key: "g:c", via: "space" });
  await fake.advance(50);
  assert.equal(writes().length, 1, "the first of several chunks is running");
  await fake.widget("action", { index: 1, key: "s:a.ts", via: "click" });
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(50);
  gate.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(50);
  assert.deepEqual(statuses(), [FINDING]);
  assert.equal(writes().length, 1, "no write while the mode is unknown");
  assert.ok(fake.named("debug").some((c) => String(c.args[0]).includes("unstage a.ts: not run")));
  // Found again: still nothing runs for the old request.
  pwd.resolve(BIND_PWD);
  await fake.advance(1000);
  assert.equal(writes().length, 1);
});

test("a user's tab close drops the composite's state too; so does a source closing first (R14, F9)", async () => {
  await loadAcceptance();
  const before = fake.openBuffers();
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(fake.compositeStates().size, 1);
  await fake.closeTab(shownBuffers()[0]);
  await fake.advance(50);
  assert.deepEqual(fake.openBuffers(), before);
  assert.deepEqual(fake.compositeStates(), new Set());
  // A source closing first takes the composite, its state and the other source.
  fake.clear();
  await click(4, "c:a.ts");
  await fake.advance(50);
  const composite = shownBuffers()[0];
  const sources = [...fake.openBuffers()].filter((id) => id !== composite && !before.has(id));
  await fake.closeTab(sources[0]);
  await fake.advance(50);
  assert.deepEqual(fake.openBuffers(), before);
  assert.deepEqual(fake.compositeStates(), new Set());
  assert.deepEqual(fake.named("closeCompositeBuffer").map((c) => c.args[0]), [composite]);
});

test("a replace drops the old composite's state (R14, F9)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  await click(4, "c:a.ts");
  await fake.advance(50);
  assert.deepEqual(fake.compositeStates(), new Set([shownBuffers()[1]]));
});

test("Space on a group with no action says nothing: the placeholder, and an empty group while the mode is unknown (R16, F10)", async () => {
  const repo: Repo = { status: raw({ records: [mod(".M", "b.md")] }), code: 0, statusOutcome: () => "hang" };
  await load(repo);
  // The placeholder: no status yet.
  await fake.widget("activate", { index: 0, key: "g:s", via: "space" });
  await fake.widget("activate", { index: 1, key: "g:c", via: "space" });
  await fake.widget("action", { index: 1, key: "g:c", via: "click" });
  await fake.advance(50);
  assert.deepEqual(statuses(), []);
  repo.statusOutcome = undefined;
  await fake.advance(30_000);
  assert.ok(lastShown().itemKeys.includes("c:b.md"));
  // The mode is being found again (detection held).
  const pwd = deferred();
  repo.pwd = pwd.outcome;
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(50);
  fake.clear();
  // keys: g:s g:c c:b.md — Staged is empty.
  await fake.widget("activate", { index: 0, key: "g:s", via: "space" });
  assert.deepEqual(statuses(), [], "an empty group: nothing");
  await fake.widget("activate", { index: 1, key: "g:c", via: "space" });
  assert.deepEqual(statuses(), [FINDING], "a group with files still says why it waits");
  assert.deepEqual(writes(), []);
  pwd.resolve(BIND_PWD);
});

test("a status the host refused to draw is not acted on; the one on screen still is (F13)", async () => {
  // The first status's remount (the title changes) is refused.
  fake.returns.set("mountSidebarSection", [true, false]);
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  assert.equal(mounts().length, 2);
  assert.equal(fake.contextOn("git-sidebar-rows"), false, "no rows on screen, so no palette");
  fake.clear();
  await fake.widget("activate", { index: 5, key: "c:b.md", via: "space" });
  assert.deepEqual(statuses(), ["the Git section shows no files"]);
  // Drawn on the next refresh.
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.equal(fake.contextOn("git-sidebar-rows"), true);
  // An in-place update refused: the rows on screen stay the ones acted on.
  repo.status = raw({ records: [untracked("one.txt")] });
  fake.returns.set("updateFloatingWidget", [false]);
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  fake.clear();
  await fake.widget("activate", { index: 2, key: "c:one.txt", via: "space" });
  await fake.widget("activate", { index: 5, key: "c:b.md", via: "space" });
  await fake.advance(50);
  assert.deepEqual(writes(), [["--literal-pathspecs", "add", "--", "b.md"]]);
});

test("load clears a rows context a previous load left set, before any rows (R18, F14)", async () => {
  (fake.api().setContext as (n: string, on: boolean) => void)("git-sidebar-rows", true);
  fake.clear();
  await load({ status: ACCEPTANCE, code: 0, statusOutcome: () => "hang" });
  // Both cleared before the placeholder mounts; the mount then sets the shown one (R22).
  assert.deepEqual(fake.named("setContext").map((c) => c.args), [
    ["git-sidebar-rows", false],
    ["git-sidebar-shown", false],
    ["git-sidebar-shown", true],
  ]);
  const order = fake.calls.map((c) => c.name).filter((n) => n === "setContext" || n === "mountSidebarSection");
  assert.deepEqual(order, ["setContext", "setContext", "mountSidebarSection", "setContext"]);
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
  assert.deepEqual(listedNow(), [FOCUS], "only Focus under the placeholder");
});

// ---------------------------------------------------------------------------
// R19, R20: Enter in the diff
// ---------------------------------------------------------------------------

/** Enter in the diff, with the host's cursor info `lines` (right pane focused). */
async function diffEnter(lines: (number | null)[] | null): Promise<void> {
  fake.cursorInfo = lines === null ? null : { focusedPane: 1, paneCount: 2, lines };
  await fake.fire("gitSidebar_diffEnter");
  await fake.advance(50);
}
const opened = () => fake.named("openFile").map((c) => c.args);

test("Enter in a Changes diff opens the file at the working-tree line; the diff stays (R19, INV §8 P25)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  const view = fake.openBuffers();
  assert.equal(view.size, 3);
  // The added line 2: no left line, right line 1 (0-based).
  await diffEnter([null, 1]);
  assert.deepEqual(opened(), [["/repo/b.md", 2]]);
  assert.deepEqual(fake.openBuffers(), view, "the composite and both sources stay open");
  assert.equal(fake.named("closeBuffer").length + fake.named("closeCompositeBuffer").length, 0);
  // A context row: both panes have a line, and the right one is opened.
  fake.clear();
  await diffEnter([0, 0]);
  assert.deepEqual(opened(), [["/repo/b.md", 1]]);
});

test("Enter on a removed line opens the right-hand line after it, not the file's last line (R19, A19)", async () => {
  await loadAcceptance({ blobs: { ...ACC_BLOBS, ":0:b.md": "# b\nold\nkeep1\nkeep2\n" } });
  fake.contents.set("/repo/b.md", "# b\nkeep1\nkeep2\n");
  await click(5, "c:b.md");
  await fake.advance(50);
  // Left line 1 (`old`) has no right line: the next one shown is `keep1`,
  // right line 1, where the file's last line would be 3.
  await diffEnter([1, null]);
  assert.deepEqual(opened(), [["/repo/b.md", 2]]);
});

test("Enter in a Staged diff opens the same line number in the file on disk (R19)", async () => {
  await loadAcceptance();
  await click(1, "s:a.ts");
  await fake.advance(50);
  await diffEnter([0, 0]);
  assert.deepEqual(opened(), [["/repo/a.ts", 1]]);
});

test("Enter clamps to the lines the tab will show: the file on disk, or the open buffer (R19)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  // b.md on disk is now one line: line 2 would land on the host's line 1.
  fake.contents.set("/repo/b.md", "# b\n");
  await diffEnter([null, 1]);
  assert.deepEqual(opened(), [["/repo/b.md", 1]]);
  // Open in the editor with unsaved edits: that buffer's lines count, not the disk's.
  fake.clear();
  fake.contents.set("/repo/b.md", "1\n2\n3\n4\n5\n");
  fake.userBuffers.set("/repo/b.md", { id: 7, text: "only\ntwo" });
  await diffEnter([null, 4]);
  assert.deepEqual(opened(), [["/repo/b.md", 2]]);
  assert.deepEqual(fake.named("getBufferText").map((c) => c.args), [[7]]);
  assert.equal(fake.named("readFile").length, 0);
  // An empty file: line 1.
  fake.clear();
  fake.userBuffers.clear();
  fake.contents.set("/repo/b.md", "");
  await diffEnter([null, 1]);
  assert.deepEqual(opened(), [["/repo/b.md", 1]]);
  // A file that gives no text (not UTF-8): the line is passed as it is.
  fake.clear();
  fake.contents.set("/repo/b.md", undefined);
  await diffEnter([null, 6]);
  assert.deepEqual(opened(), [["/repo/b.md", 7]]);
  // Too large for a diff to read: not read here either, and the line is passed as it is.
  fake.clear();
  fake.contents.set("/repo/b.md", "1\n");
  fake.sizes.set("/repo/b.md", 6 * 1024 * 1024);
  await diffEnter([null, 6]);
  assert.deepEqual(opened(), [["/repo/b.md", 7]]);
  assert.equal(fake.named("readFile").length, 0);
  // An open buffer that large: its text is not fetched either.
  fake.clear();
  fake.userBuffers.set("/repo/b.md", { id: 7, text: "x".repeat(6 * 1024 * 1024) });
  await diffEnter([null, 6]);
  assert.deepEqual(opened(), [["/repo/b.md", 7]]);
  assert.equal(fake.named("getBufferText").length, 0);
});

test("Enter in a deleted file's diff says it is deleted and opens nothing (R19, R7)", async () => {
  await loadAcceptance();
  await click(6, "c:gone.ts");
  await fake.advance(50);
  fake.clear();
  await diffEnter([0, null]);
  assert.equal(fake.named("openFile").length, 0);
  assert.equal(fake.named("readFile").length, 0, "View File's checks come before any read");
  assert.deepEqual(statuses(), ["gone.ts is deleted"]);
});

test("Enter does nothing without a composite cursor, after the view closed, or for a view replaced meanwhile (R19)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  const composite = shownBuffers()[0];
  fake.clear();
  await diffEnter(null);
  assert.deepEqual(opened(), []);
  // The view closed by the user: nothing to act on.
  await fake.closeTab(composite);
  await fake.advance(50);
  fake.clear();
  await diffEnter([null, 1]);
  assert.deepEqual(opened(), []);
  // Replaced while the host answered: the answer is for the old view.
  await click(5, "c:b.md");
  await fake.advance(50);
  fake.clear();
  let answer!: (v: unknown) => void;
  fake.cursorInfo = new Promise((r) => (answer = r));
  const pending = fake.fire("gitSidebar_diffEnter");
  await click(1, "s:a.ts");
  await fake.advance(50);
  answer({ focusedPane: 1, paneCount: 2, lines: [null, 1] });
  await pending;
  await fake.advance(50);
  assert.deepEqual(opened(), []);
  assert.deepEqual(fake.loudCalls().filter((c) => c.name !== "setStatus"), []);
});

// ---------------------------------------------------------------------------
// R22: Focus
// ---------------------------------------------------------------------------

const focusCalls = () => fake.named("floatingPanelControl").map((c) => c.args).filter((a) => a[1] === "focus");

test("Focus with nothing selected selects the first row, then moves the keyboard in (R22)", async () => {
  await loadAcceptance();
  await fake.command(FOCUS);
  assert.deepEqual(mutations(), [{ kind: "setSelectedIndex", widgetKey: "git", index: 0 }]);
  assert.deepEqual(focusCalls(), [[fake.panel, "focus", 0]]);
  // The selection order: the row first, then the keyboard.
  const names = fake.widgetCalls().map((c) => c.name);
  assert.deepEqual(names, ["widgetMutate", "floatingPanelControl"]);
  assert.deepEqual(statuses(), []);
  // That row is the selection the row commands act on.
  await fake.command("Git Sidebar: Stage or Unstage");
  assert.deepEqual(statuses(), ["Stage or Unstage needs a file row selected; use Stage All or Unstage All for a group"]);
});

test("Focus keeps an existing selection (R22)", async () => {
  await loadAcceptance();
  await fake.widget("select", { index: 5, key: "c:b.md" });
  fake.clear();
  await fake.command(FOCUS);
  assert.deepEqual(mutations(), []);
  assert.deepEqual(focusCalls(), [[fake.panel, "focus", 0]]);
});

test("Focus under the placeholder and the volume notice moves the keyboard in, with no message (R22, A18)", async () => {
  await load({ status: ACCEPTANCE, code: 0, statusOutcome: () => "hang" });
  fake.clear();
  await fake.command(FOCUS);
  assert.deepEqual(focusCalls(), [[fake.panel, "focus", 0]]);
  assert.deepEqual(mutations(), [], "no rows to select under the placeholder");
  assert.deepEqual(statuses(), []);
  restartFake();
  fake.label = "Container:vol";
  await load({ status: ACCEPTANCE, code: 0, inspect: VOLUME_INSPECT, pwd: VOLUME_PWD });
  await fake.advance(1000);
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
  fake.clear();
  await fake.command(FOCUS);
  assert.deepEqual(focusCalls(), [[fake.panel, "focus", 0]]);
  assert.deepEqual(statuses(), []);
  assert.deepEqual(fake.gitCalls(), []);
});

test("Focus is not listed outside a repository; run from a key binding there, it says so and sends nothing (R22)", async () => {
  await load({ status: "", code: 128 }, { git: false });
  await fake.advance(1000);
  assert.deepEqual(listedNow(), []);
  fake.clear();
  await fake.fire("gitSidebar_focus");
  assert.deepEqual(focusCalls(), []);
  assert.deepEqual(statuses(), [NOT_SHOWN]);
});

test("load, refreshes and remounts never send focus: only the Focus command does (R22, R1)", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0 };
  await load(repo);
  await fake.advance(200);
  repo.status = raw({ records: [untracked("x.txt")] });
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  repo.status = repo.status.replace("# branch.head main", "# branch.head other");
  await fake.emit("focus_gained", {});
  await fake.advance(1000);
  assert.ok(mounts().length >= 3, "the branch change remounted");
  assert.deepEqual(focusCalls(), []);
});

// ---------------------------------------------------------------------------
// R25: Resolve Conflict
// ---------------------------------------------------------------------------

async function loadConflict(): Promise<void> {
  await load({ status: fixture("conflict"), code: 0 });
  await fake.advance(200);
  // uu.txt and aa.txt hold their markers; du.txt is deleted by us and absent.
  fake.files.add("/repo/uu.txt");
  fake.files.add("/repo/aa.txt");
  fake.clear();
}
const actions = () => fake.named("executeAction").map((c) => c.args[0]);

test("Resolve Conflict from the menu and the palette: the file opens, then Fresh's resolution starts on it; no write (R25, A25)", async () => {
  await loadConflict();
  // keys: g:s g:c c:aa.txt c:du.txt c:uu.txt
  await rightClick(4, "c:uu.txt");
  assert.deepEqual(menuMounts().map((m) => m.labels), [["View Diff", "View File", "Resolve Conflict"]]);
  await choose("resolve");
  await fake.advance(50);
  assert.deepEqual(opened(), [["/repo/uu.txt"]]);
  assert.deepEqual(actions(), ["start_merge_conflict"]);
  // The open comes first: the action acts on the active buffer (INV §8 P29).
  const order = fake.calls.map((c) => c.name).filter((n) => n === "openFile" || n === "executeAction");
  assert.deepEqual(order, ["openFile", "executeAction"]);
  fake.clear();
  await fake.widget("select", { index: 2, key: "c:aa.txt" });
  await fake.command("Git Sidebar: Resolve Conflict");
  await fake.advance(50);
  assert.deepEqual(opened(), [["/repo/aa.txt"]]);
  assert.deepEqual(actions(), ["start_merge_conflict"]);
  assert.deepEqual(writes(), [], "a conflicted file is never staged (R15)");
  assert.deepEqual(statuses(), []);
});

test("Resolve Conflict on a DU row whose file is gone: \"deleted\", no open and no resolution (R25)", async () => {
  await loadConflict();
  await rightClick(3, "c:du.txt");
  await choose("resolve");
  await fake.advance(50);
  assert.deepEqual(opened(), []);
  assert.deepEqual(actions(), []);
  assert.deepEqual(statuses(), ["du.txt is deleted"]);
});

test("Resolve Conflict with merge_conflict disabled opens the file and asks for no unknown action (R25, INV §8 P29)", async () => {
  await loadConflict();
  fake.plugins = [{ name: "merge_conflict", path: "merge_conflict.ts", enabled: false }];
  await fake.widget("select", { index: 4, key: "c:uu.txt" });
  await fake.command("Git Sidebar: Resolve Conflict");
  await fake.advance(50);
  assert.deepEqual(opened(), [["/repo/uu.txt"]]);
  assert.deepEqual(actions(), []);
  assert.deepEqual(fake.loudCalls(), []);
  // Absent from the list altogether, as 0.5.9 lists a disabled bundled plugin.
  fake.plugins = [];
  fake.clear();
  await fake.command("Git Sidebar: Resolve Conflict");
  await fake.advance(50);
  assert.deepEqual(opened(), [["/repo/uu.txt"]]);
  assert.deepEqual(actions(), []);
});

test("Resolve Conflict on a row that is not conflicted, or with nothing selected: a message only (R18, A18)", async () => {
  await loadAcceptance();
  await fake.command("Git Sidebar: Resolve Conflict");
  await fake.widget("select", { index: 5, key: "c:b.md" });
  await fake.command("Git Sidebar: Resolve Conflict");
  await fake.advance(50);
  assert.deepEqual(statuses(), [NOTHING_SELECTED, "Resolve Conflict needs a file with a merge conflict selected"]);
  assert.deepEqual(opened(), []);
  assert.deepEqual(actions(), []);
  assert.equal(fake.named("listPlugins").length, 0);
});

test("Resolve Conflict for a row gone while the plugin list was read: a message, nothing opened (R25)", async () => {
  const repo: Repo = { status: fixture("conflict"), code: 0 };
  await load(repo);
  await fake.advance(200);
  fake.files.add("/repo/uu.txt");
  await fake.widget("select", { index: 4, key: "c:uu.txt" });
  let open!: () => void;
  fake.pluginsGate = new Promise<void>((r) => (open = r));
  fake.clear();
  await fake.command("Git Sidebar: Resolve Conflict");
  // The conflict is resolved outside while the host lists the plugins.
  repo.status = raw({ records: [mod("M.", "uu.txt")] });
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  open();
  await fake.advance(50);
  assert.deepEqual(opened(), []);
  assert.deepEqual(actions(), []);
  assert.deepEqual(statuses(), ["uu.txt is no longer listed"]);
});

test("Resolve Conflict for a row still listed but no longer conflicted: a message, nothing opened (R25)", async () => {
  const repo: Repo = { status: fixture("conflict"), code: 0 };
  await load(repo);
  await fake.advance(200);
  fake.files.add("/repo/uu.txt");
  await fake.widget("select", { index: 4, key: "c:uu.txt" });
  let open!: () => void;
  fake.pluginsGate = new Promise<void>((r) => (open = r));
  fake.clear();
  await fake.command("Git Sidebar: Resolve Conflict");
  // Resolved and staged outside, then edited again: `c:uu.txt` is a plain change now.
  repo.status = raw({ records: [mod("MM", "uu.txt")] });
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  open();
  await fake.advance(50);
  assert.deepEqual(opened(), []);
  assert.deepEqual(actions(), []);
  assert.deepEqual(statuses(), ["uu.txt no longer has a merge conflict"]);
});

test("Resolve Conflict when the plugin list cannot be read still opens the file, and asks for no action (R25)", async () => {
  await load({ status: fixture("conflict"), code: 0 });
  await fake.advance(200);
  fake.files.add("/repo/uu.txt");
  await fake.widget("select", { index: 4, key: "c:uu.txt" });
  let fail!: (e: Error) => void;
  fake.pluginsGate = new Promise<void>((_, reject) => (fail = reject));
  fake.clear();
  await fake.command("Git Sidebar: Resolve Conflict");
  fail(new Error("host gone"));
  await fake.advance(50);
  assert.deepEqual(opened(), [["/repo/uu.txt"]]);
  assert.deepEqual(actions(), []);
  assert.deepEqual(statuses(), []);
});

// ---------------------------------------------------------------------------
// R26: Commit…
// ---------------------------------------------------------------------------

const COMMIT = "Git Sidebar: Commit…";
const prompts = () => fake.named("prompt").map((c) => c.args);
/** The summary read after a commit, as `gitSince` shows it. */
const HEAD_LOG = "--no-optional-locks log -1 --no-show-signature --format=%h%n%s HEAD";
/** Every git run's argv after the first commit, in order, statuses as `status`. */
const gitSince = (from: number) =>
  fake.gitCalls().slice(from).map((p) => (p.args.includes("status") ? "status" : p.args.join(" ")));

test("Commit… from the Staged Changes menu: the message's argv, the short id, then a refresh (R26, A26)", async () => {
  await loadAcceptance();
  await rightClick(0, "g:s");
  assert.deepEqual(menuMounts().map((m) => m.labels), [["Unstage All", "Commit…"]]);
  fake.promptAnswers.push("first");
  await choose("commit");
  await fake.advance(1000);
  assert.deepEqual(prompts(), [["Commit message: ", ""]]);
  assert.deepEqual(writes(), [["commit", "-q", "-m", "first"]]);
  const at = fake.gitCalls().findIndex((p) => p.args[0] === "commit");
  assert.deepEqual(gitSince(at).slice(0, 3), ["commit -q -m first", HEAD_LOG, "status"]);
  assert.deepEqual(statuses(), ["committed abc1234: first"]);
  // On the root, like every write.
  assert.deepEqual(fake.gitCalls()[at].cwd, "/repo");
});

test("Commit… from the palette; a message starting with - or # reaches git as typed (R26)", async () => {
  await loadAcceptance();
  fake.promptAnswers.push("-x");
  await fake.command(COMMIT);
  await fake.advance(3000);
  fake.promptAnswers.push("#x");
  await fake.command(COMMIT);
  await fake.advance(3000);
  assert.deepEqual(writes(), [
    ["commit", "-q", "-m", "-x"],
    ["commit", "-q", "-m", "#x"],
  ]);
});

test("Commit…: Esc changes nothing and says so; spaces only say the message is empty; nothing staged opens no prompt (R26)", async () => {
  await loadAcceptance();
  await fake.command(COMMIT);
  await fake.advance(1000);
  assert.equal(prompts().length, 1);
  assert.deepEqual(writes(), []);
  // Said, so no earlier message stays up beside Fresh's "Search cancelled.".
  assert.deepEqual(statuses(), ["commit cancelled"]);
  fake.clear();
  fake.promptAnswers.push("   ");
  await fake.command(COMMIT);
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), ["the commit message is empty; nothing committed"]);
  restartFake();
  await load({ status: fixture("clean"), code: 0 });
  await fake.advance(200);
  fake.clear();
  await fake.command(COMMIT);
  await fake.advance(1000);
  assert.deepEqual(prompts(), []);
  assert.deepEqual(statuses(), ["nothing staged to commit"]);
  // Nor from a menu: Staged Changes offers no Commit… while empty.
  await rightClick(0, "g:s");
  assert.deepEqual(menuMounts(), []);
});

test("Commit… with a failing hook: git's reason, then the actual status (R26)", async () => {
  await loadAcceptance({ onWrite: () => ({ code: 1, stdout: "", stderr: "nope\n" }) });
  fake.promptAnswers.push("first");
  await fake.command(COMMIT);
  await fake.advance(1000);
  assert.deepEqual(statuses(), ["could not commit: nope"]);
  const at = fake.gitCalls().findIndex((p) => p.args[0] === "commit");
  assert.deepEqual(gitSince(at).slice(0, 2), ["commit -q -m first", "status"], "no id read; a refresh");
});

test("a 70 s commit is never killed; a stage asked before runs first and one asked during runs after; its last word is `committed` (R26)", async () => {
  const stage = deferred();
  const commit = deferred();
  await loadAcceptance({ onWrite: (c) => (c.args[0] === "commit" ? commit.outcome : c.args.includes("b.md") ? stage.outcome : undefined) });
  await fake.widget("action", { index: 5, key: "c:b.md", via: "click" });
  fake.promptAnswers.push("slow");
  await fake.command(COMMIT);
  await fake.advance(10);
  assert.deepEqual(writes(), [["--literal-pathspecs", "add", "--", "b.md"]], "the commit waits for the stage");
  stage.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(10);
  assert.deepEqual(writes().at(-1), ["commit", "-q", "-m", "slow"]);
  // `+` on gone.ts while the commit's hook runs.
  await fake.widget("action", { index: 6, key: "c:gone.ts", via: "click" });
  await fake.advance(61_000);
  assert.equal(fake.kills, 0, "a killed commit would leave .git/index.lock");
  assert.ok(statuses().includes("commit: git is still running after 60 s"), statuses().join(" | "));
  assert.equal(writes().length, 2, "gone.ts waits for the commit");
  await fake.advance(9_000);
  commit.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(100);
  assert.deepEqual(writes().at(-1), ["--literal-pathspecs", "update-index", "--remove", "--", "gone.ts"]);
  assert.equal(statuses().at(-1), "committed abc1234: slow", "not `commit: done`");
  assert.ok(!statuses().includes("commit: done"));
  assert.equal(fake.kills, 0);
});

test("a restart during the prompt: the commit is not run, and the user is told, a notice brought up by it included (R26)", async () => {
  await loadAcceptance({ inspect: VOLUME_INSPECT, pwd: VOLUME_PWD });
  let answer!: (v: string | null) => void;
  fake.promptAnswers.push(new Promise((r) => (answer = r)));
  await fake.command(COMMIT);
  await fake.emit("trust_changed", { level: "trusted" });
  answer("first");
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), ["commit: not run; the workspace's authority or trust changed after it was asked for"]);
  // An attach to a volume container during the prompt: a notice, no rows.
  fake.clear();
  fake.promptAnswers.push(new Promise((r) => (answer = r)));
  await fake.command(COMMIT);
  fake.label = "Container:vol";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(1000);
  assert.deepEqual(texts(lastShown()), [VOLUME_NOTICE]);
  answer("first");
  await fake.advance(1000);
  assert.deepEqual(writes(), []);
  assert.deepEqual(statuses(), ["nothing committed: the Git section no longer shows files"]);
});

test("a commit whose id read fails still says it committed (R26)", async () => {
  await loadAcceptance({ headLog: { code: 128, stdout: "", stderr: "fatal: bad" } });
  fake.promptAnswers.push("first");
  await fake.command(COMMIT);
  await fake.advance(1000);
  assert.deepEqual(statuses(), ["committed: first"]);
});

test("a second Commit… before the first is drawn is refused with a message (R26)", async () => {
  const commit = deferred();
  await loadAcceptance({ onWrite: () => commit.outcome });
  fake.promptAnswers.push("one", "two");
  await fake.command(COMMIT);
  await fake.command(COMMIT);
  await fake.advance(10);
  assert.deepEqual(writes(), [["commit", "-q", "-m", "one"]]);
  assert.deepEqual(statuses(), [COMMIT_BUSY]);
  // Refused before its prompt: no message is typed only to be thrown away.
  assert.deepEqual(prompts(), [["Commit message: ", ""]]);
  commit.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(1000);
});

test("a commit that finds nothing staged says so, not the first line of git's status or a hook's output (R26)", async () => {
  // The rows still list a staged file, but an unstage or a terminal emptied the index.
  const out = 'On branch main\nUntracked files:\n\tf\n\nnothing added to commit but untracked files present (use "git add" to track)\n';
  await loadAcceptance({ onWrite: () => ({ code: 1, stdout: out, stderr: "lint ok\n" }) });
  fake.promptAnswers.push("first");
  await fake.command(COMMIT);
  await fake.advance(1000);
  assert.deepEqual(statuses(), ["could not commit: nothing is staged"]);
});

test("in a bind-mounted dev container, the commit and its id read run on the host in the root (R26, R13)", async () => {
  fake.label = "Container:abc";
  await load({ status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD });
  await fake.advance(200);
  fake.promptAnswers.push("first");
  await fake.command(COMMIT);
  await fake.advance(1000);
  const runs = fake.gitCalls().filter((p) => p.args[0] === "commit" || p.args[1] === "log");
  assert.deepEqual(runs.map((p) => [p.args[0] === "commit" ? "commit" : "log", p.via, p.cwd]), [
    ["commit", "host", "/repo"],
    ["log", "host", "/repo"],
  ]);
});

// ---------------------------------------------------------------------------
// R23: auto-reveal
// ---------------------------------------------------------------------------

/** The home window's active tab changes to buffer `id`, open on `path`. */
async function switchTo(id: number, path: string, window = 1): Promise<void> {
  fake.bufferPaths.set(id, path);
  await fake.emit("active_buffer_changed", { window_id: window, buffer_id: id, previous: null, reason: "buffer" });
}
const chrome = (region: string, plugin: string | null = null, panel_id: number | null = null, window_id = 1) =>
  fake.emit("chrome_focus_changed", { window_id, region, plugin, panel_id });
const selects = () => mutations().filter((m) => m.kind === "setSelectedIndex").map((m) => m.index);

test("auto-reveal: a tab change to a listed file selects its row, Changes first; no diff, no focus (R23, A23)", async () => {
  await loadAcceptance();
  // keys: g:s s:a.ts s:moved.ts g:c c:a.ts c:b.md c:gone.ts c:new/c.txt c:new/d.txt
  await switchTo(7, "/repo/b.md");
  await switchTo(8, "/repo/a.ts");
  await switchTo(9, "/repo/moved.ts");
  await switchTo(10, "/repo/new/c.txt");
  assert.deepEqual(selects(), [5, 4, 2, 7]);
  assert.equal(fake.named("createVirtualBuffer").length + fake.named("openFile").length, 0);
  assert.deepEqual(focusCalls(), []);
  assert.deepEqual(fake.gitCalls(), []);
  // The revealed row is the selection the row commands act on.
  await switchTo(7, "/repo/b.md");
  await fake.command("Git Sidebar: Stage or Unstage");
  await fake.advance(50);
  assert.deepEqual(writes(), [["--literal-pathspecs", "add", "--", "b.md"]]);
});

test("auto-reveal leaves the selection alone: not listed, already selected, another window, a virtual buffer, a collapsed group (R23)", async () => {
  await loadAcceptance();
  await fake.widget("select", { index: 5, key: "c:b.md" });
  fake.clear();
  await switchTo(7, "/repo/README.md");
  await switchTo(8, "/repo/b.md");
  // a.ts's Staged row chosen, then a.ts opened (from its Staged diff, R19):
  // the Staged row stays, not traded for the Changes row Space would act on.
  await fake.widget("select", { index: 1, key: "s:a.ts" });
  await switchTo(14, "/repo/a.ts");
  await switchTo(9, "/repo/a.ts", 2);
  await switchTo(10, "");
  await switchTo(11, "/elsewhere/a.ts");
  assert.deepEqual(selects(), []);
  // Changes collapsed: no reveal into it, and it stays collapsed.
  await fake.widget("expand", { index: 3, key: "g:c", expanded: false });
  fake.clear();
  await switchTo(12, "/repo/gone.ts");
  await switchTo(13, "/repo/a.ts");
  assert.deepEqual(mutations(), []);
});

test("auto-reveal waits while the keyboard is in the section, by its focus or the chrome event; a blur, a remount or the chrome event ends that (R23, INV §8 P28)", async () => {
  const repo = await loadAcceptance();
  await fake.widget("focus", { previous: "(re-focus)" });
  await switchTo(7, "/repo/b.md");
  assert.deepEqual(selects(), [], "the row Space acts on stays");
  // A tab click: blur first, then the buffer change (P28 d).
  await fake.widget("blur", {});
  await switchTo(7, "/repo/b.md");
  assert.deepEqual(selects(), [5]);
  // Into the section by Alt+Shift+N: only the chrome event counts here.
  fake.clear();
  await chrome("section", "git_sidebar", fake.panel);
  await switchTo(8, "/repo/gone.ts");
  assert.deepEqual(selects(), []);
  // Out of it with no blur, as after a remount (P28 c).
  await chrome("editor");
  await switchTo(8, "/repo/gone.ts");
  assert.deepEqual(selects(), [6]);
  // Another plugin's section, or another panel, is not ours.
  fake.clear();
  await chrome("section", "markdown_toc", 1);
  await switchTo(9, "/repo/b.md");
  await chrome("section", "git_sidebar", 2);
  await switchTo(10, "/repo/gone.ts");
  assert.deepEqual(selects(), [5, 6]);
  // Focused, then a remount (a branch change) clears it.
  await fake.widget("focus", {});
  repo.status = ACCEPTANCE.replace("# branch.head main", "# branch.head other");
  await fake.emit("focus_gained", {});
  await fake.advance(1000);
  fake.clear();
  await switchTo(7, "/repo/b.md");
  assert.deepEqual(selects(), [5]);
});

test("a refresh that newly lists the active file does not move the selection (R23, R10)", async () => {
  const repo = await loadAcceptance();
  await fake.widget("select", { index: 5, key: "c:b.md" });
  await switchTo(7, "/repo/later.txt");
  fake.clear();
  repo.status = ACCEPTANCE.replace(/\0$/, `\0${untracked("later.txt")}\0`);
  await fake.emit("after_file_save", {});
  await fake.advance(1000);
  assert.ok(texts(lastShown()).includes("U later.txt"));
  assert.deepEqual(selects(), []);
});

test("auto-reveal ignores a switch back to the home window: its active tab did not change (R23)", async () => {
  await loadAcceptance();
  await switchTo(7, "/repo/b.md");
  // The user moves the selection away from the active file's row.
  await fake.widget("select", { index: 1, key: "s:a.ts" });
  fake.clear();
  await fake.emit("active_buffer_changed", { window_id: 1, buffer_id: 7, previous: { window_id: 2, buffer_id: 3 }, reason: "window" });
  assert.deepEqual(selects(), []);
});

test("a remount the host refuses leaves the section focused: no reveal moves the row Space acts on (R23)", async () => {
  const repo = await loadAcceptance();
  await fake.widget("focus", {});
  fake.returns.set("mountSidebarSection", [false]);
  repo.status = ACCEPTANCE.replace("# branch.head main", "# branch.head other");
  await fake.emit("focus_gained", {});
  await fake.advance(200);
  assert.ok(fake.named("debug").some((c) => String(c.args[0]).includes("mountSidebarSection returned false")));
  fake.clear();
  await switchTo(7, "/repo/b.md");
  assert.deepEqual(selects(), []);
});

test("the diff's hint does not replace a write's outcome sent while the diff was built (R20, R15)", async () => {
  const lock = "fatal: Unable to create '/repo/.git/index.lock': File exists.";
  await loadAcceptance({ onWrite: () => ({ code: 128, stdout: "", stderr: lock }) });
  let release!: () => void;
  fake.compositeGate = new Promise<void>((r) => (release = r));
  await click(5, "c:b.md");
  await fake.advance(10);
  await fake.widget("activate", { index: 4, key: "c:a.ts", via: "space" });
  await fake.advance(50);
  release();
  fake.compositeGate = null;
  await fake.advance(50);
  assert.equal(shownBuffers().length, 1, "the diff opened");
  const said = statuses();
  assert.ok(!said.includes(DIFF_HINT), said.join(" | "));
  assert.match(said[said.length - 1], /^could not stage a\.ts: /);
});

test("the diff's hint waits while the keyboard is in the section, then shows once it is in the diff, once (R20, R14)", async () => {
  await loadAcceptance();
  // A click on a row: the keyboard is in the section, where n, p, q and
  // Enter do nothing, so no hint yet.
  await fake.widget("focus", {});
  await click(5, "c:b.md");
  await fake.advance(50);
  const [composite] = shownBuffers();
  assert.equal(fake.activeBuffer, composite, "the diff opened");
  assert.deepEqual(statuses(), []);
  // A click into the diff: blur, then the chrome event (P25 e, P28 c).
  await fake.widget("blur", {});
  assert.deepEqual(statuses(), [], "not on the blur alone");
  await chrome("editor");
  assert.deepEqual(statuses(), [DIFF_HINT]);
  // Back to the section and into the diff again: said once per diff.
  await chrome("section", "git_sidebar", fake.panel);
  await chrome("editor");
  assert.deepEqual(statuses(), [DIFF_HINT]);
});

test("a waiting hint shows on a tab change to its diff with the keyboard in the editor; not for another tab, the explorer or a closed diff (R20)", async () => {
  await loadAcceptance();
  await fake.widget("focus", {});
  await click(5, "c:b.md");
  await fake.advance(50);
  const [composite] = shownBuffers();
  // The keyboard goes to the explorer, then to another tab's editor.
  await chrome("explorer");
  fake.activeBuffer = 99;
  await switchTo(99, "/repo/README.md");
  await chrome("editor");
  assert.deepEqual(statuses(), []);
  // Ctrl+PageDown back to the diff's tab: no chrome event, a tab change.
  fake.activeBuffer = composite;
  await fake.emit("active_buffer_changed", { window_id: 1, buffer_id: composite, previous: null, reason: "buffer" });
  assert.deepEqual(statuses(), [DIFF_HINT]);
  // A diff closed before the keyboard reached it gives no hint.
  fake.clear();
  await fake.widget("focus", {});
  await click(4, "c:a.ts");
  await fake.advance(50);
  const [second] = shownBuffers();
  await fake.emit("buffer_closed", { buffer_id: second, window_id: 1 });
  await fake.advance(50);
  fake.activeBuffer = 99;
  await chrome("editor");
  fake.activeBuffer = second;
  await fake.emit("active_buffer_changed", { window_id: 1, buffer_id: second, previous: null, reason: "buffer" });
  assert.deepEqual(statuses(), []);
});

test("a diff opened with the keyboard outside the section, as from the palette, shows its hint at once (R20, R18)", async () => {
  await loadAcceptance();
  await click(5, "c:b.md");
  await fake.advance(50);
  // Opening the palette blurs the section and gives the editor the keyboard.
  await fake.widget("blur", { passed_on: true });
  await chrome("editor");
  fake.clear();
  await fake.command("Git Sidebar: View Diff");
  await fake.advance(50);
  assert.equal(shownBuffers().length, 1);
  assert.deepEqual(statuses(), [DIFF_HINT]);
  // Nothing waits: a later move into the editor says nothing more.
  await chrome("section", "git_sidebar", fake.panel);
  await chrome("editor");
  assert.deepEqual(statuses(), [DIFF_HINT]);
});

test("a commit's message names the subject git recorded, after a hook rewrote it (R26)", async () => {
  await loadAcceptance({ headLog: { code: 0, stdout: "abc1234\n[ABC-12] fix typo\n", stderr: "" } });
  fake.promptAnswers.push("fix typo");
  await fake.command(COMMIT);
  await fake.advance(1000);
  assert.deepEqual(statuses(), ["committed abc1234: [ABC-12] fix typo"]);
});

test("the queue counts a commit done when git exits: its refresh runs while the summary read is still out (R26, writeSeq)", async () => {
  const head = deferred();
  await loadAcceptance({ headLog: head.outcome });
  fake.promptAnswers.push("first");
  await fake.command(COMMIT);
  await fake.advance(100);
  const at = fake.gitCalls().findIndex((p) => p.args[0] === "commit");
  assert.deepEqual(gitSince(at).slice(0, 3), ["commit -q -m first", HEAD_LOG, "status"]);
  assert.deepEqual(statuses(), []);
  head.resolve({ code: 0, stdout: "abc1234\nfirst\n", stderr: "" });
  await fake.advance(50);
  assert.deepEqual(statuses(), ["committed abc1234: first"]);
});

test("a restart during the summary read: the commit is logged, not left unreported (R26)", async () => {
  const head = deferred();
  await loadAcceptance({ headLog: head.outcome });
  fake.promptAnswers.push("first");
  await fake.command(COMMIT);
  await fake.advance(100);
  await fake.emit("trust_changed", { level: "trusted" });
  head.resolve({ code: 0, stdout: "abc1234\nfirst\n", stderr: "" });
  await fake.advance(50);
  assert.ok(!statuses().some((s) => s.startsWith("committed")));
  assert.ok(fake.named("debug").some((c) => String(c.args[0]).includes("committed abc1234: first (finished after a restart)")));
});

// ---------------------------------------------------------------------------
// R28: every window
// ---------------------------------------------------------------------------

const B_STATUS = ACCEPTANCE.replace("# branch.head main", "# branch.head feature-b");
const PANEL_A = panelOf("ws-1");
const PANEL_B = panelOf("ws-2", "/b");
const ROWS_CTX = "git-sidebar-rows";
const SHOWN_CTX = "git-sidebar-shown";
/** A write in /b that fails on a held lock, and what the status bar says. */
const LOCKED: ProcResult = { code: 128, stdout: "", stderr: "fatal: Unable to create '/b/.git/index.lock': File exists.\n" };
const LOCKED_MSG = "could not stage b.md: Unable to create '.git/index.lock': File exists.";
/** Every write fails on the lock, after 300 ms. */
const lockedWrite = (): ProcOutcome => ({ result: LOCKED, ms: 300 });

/** Window 1 on /repo (the launch window), 2 on /b (a repository on
 *  feature-b), 3 on /plain (no repository). */
function threeWindows(): void {
  fake.windows = [
    { id: 1, stable_id: "ws-1", root: "/repo" },
    { id: 2, stable_id: "ws-2", root: "/b" },
    { id: 3, stable_id: "ws-3", root: "/plain" },
  ];
  fake.files.add("/b/.git");
}

/** Two windows on /repo: the launch window, and one a tab was extracted
 *  into (INV §8 P31 e). */
const twins = () => [
  { id: 1, stable_id: "ws-1", root: "/repo" },
  { id: 5, stable_id: "ws-co", root: "/repo" },
];

/** `a` answers in /repo, `b` in /b; /plain is no repository. */
function windowsScript(a: Repo, b: Repo): (c: ProcCall) => ProcOutcome {
  const inA = repoScript(a);
  const inB = repoScript({ root: "/b", ...b });
  const plain = repoScript({ status: "", code: 128 });
  return (c) => (c.cwd.startsWith("/plain") ? plain(c) : c.cwd.startsWith("/b") ? inB(c) : inA(c));
}

/** Load in window 1 with three windows; window 1 shows its rows. */
async function loadWindows(a: Repo = { status: ACCEPTANCE, code: 0 }, b: Repo = { status: B_STATUS, code: 0 }): Promise<void> {
  threeWindows();
  await load(a, { script: windowsScript(a, b) });
  await fake.advance(200);
}

/** `loadWindows`, then a switch to window 2, which shows B's rows. */
async function loadInB(a?: Repo, b?: Repo): Promise<void> {
  await loadWindows(a, b);
  await fake.switchWindow(2);
  await fake.advance(500);
}

const inB = (p: ProcCall) => p.cwd.startsWith("/b");
const sectionMounts = (panel: number) => fake.named("mountSidebarSection").filter((c) => c.args[0] === panel);
const sectionUpdates = (panel: number) => fake.named("updateFloatingWidget").filter((c) => c.args[0] === panel);
/** The panel ids mounted since the last clear, each once. */
const mountedPanels = () => [...new Set(fake.named("mountSidebarSection").map((c) => c.args[0]))];
/** The status messages said while `window` was active. */
const statusesIn = (window: number) => fake.named("setStatus").filter((c) => c.window === window).map((c) => c.args[0] as string);

test("a switch to another repository's window mounts its own section, scoped to it, with its own panel and rows; the first one stays (R28)", async () => {
  const a: Repo = { status: ACCEPTANCE, code: 0 };
  await loadWindows(a);
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  fake.clear();
  await fake.switchWindow(2);
  await fake.advance(500);
  assert.deepEqual(
    fake.named("mountSidebarSection").map((c) => [c.args[0], c.args[2]]),
    [
      [PANEL_B, "Git"],
      [PANEL_B, "Git · feature-b ↑1 ↓0"],
    ],
  );
  assertEveryMountHasOptions(2);
  assert.notEqual(PANEL_A, PANEL_B);
  assert.ok(fake.gitCalls().length > 0);
  for (const p of fake.gitCalls()) assert.ok(inB(p), `${p.args.join(" ")} in ${p.cwd}`);
  assert.deepEqual(sectionUnmounts(PANEL_A), [], "window 1's section is not taken down");
  // Back in window 1: no remount, and current status within 2 s (R8).
  fake.clear();
  a.status = ACCEPTANCE.replace("? new/c.txt\0", "");
  await fake.switchWindow(1);
  await fake.advance(2000);
  assert.deepEqual(fake.named("mountSidebarSection"), []);
  assert.equal(sectionUpdates(PANEL_A).length, 1);
  for (const p of fake.gitCalls()) assert.equal(p.cwd, "/repo");
});

test("only the active window refreshes; triggers refresh it alone (R28, R11)", async () => {
  await loadInB();
  fake.clear();
  await fake.advance(30_000);
  assert.ok(fake.gitCalls().length >= 3, "B polls");
  for (const p of fake.gitCalls()) assert.ok(inB(p), `only B: ${p.cwd}`);
  fake.clear();
  for (const ev of ["after_file_save", "after_file_revert", "focus_gained", "after_file_explorer_change"]) await fake.emit(ev, {});
  await fake.advance(500);
  assert.ok(fake.gitCalls().length > 0);
  for (const p of fake.gitCalls()) assert.ok(inB(p), `only B: ${p.cwd}`);
});

test("a folder with no repository: no section and no palette commands; checked again on each activation (R28, R1)", async () => {
  await loadWindows();
  assert.equal(fake.contextOn(ROWS_CTX, 1), true);
  // A context left set in window 3, as by an earlier load of the plugin.
  fake.window = 3;
  getEditor().setContext(ROWS_CTX, true);
  fake.window = 1;
  fake.clear();
  await fake.switchWindow(3);
  await fake.advance(500);
  assert.deepEqual(fake.named("mountSidebarSection"), [], "no .git under /plain");
  assert.equal(fake.contextOn(ROWS_CTX, 3), false);
  assert.equal(fake.contextOn(SHOWN_CTX, 3), false);
  assert.deepEqual(listedNow(), []);
  assert.deepEqual(fake.loudCalls(), []);
  assert.equal(fake.gitCalls().filter((p) => p.cwd === "/plain").length, 1, "one rev-parse");
  // Away and back: asked again, once.
  await fake.switchWindow(2);
  await fake.advance(500);
  fake.clear();
  await fake.switchWindow(3);
  await fake.advance(500);
  assert.equal(fake.gitCalls().filter((p) => p.cwd === "/plain").length, 1);
  assert.equal(fake.contextOn(ROWS_CTX, 2), true, "B's contexts stay with B");
});

test("contexts follow the active window, also after a stale switch event (R28, R18, R22, INV §8 P33)", async () => {
  await loadInB(undefined, { status: B_STATUS, code: 0, statusOutcome: () => "hang" });
  // B shows its placeholder (its status hangs): Focus listed, no row commands.
  assert.equal(fake.contextOn(SHOWN_CTX, 2), true);
  assert.equal(fake.contextOn(ROWS_CTX, 2), false);
  assert.deepEqual(listedNow(), [FOCUS]);
  assert.equal(fake.contextOn(ROWS_CTX, 1), true, "A's are A's");
  // A→B→A, fast: the event for B is handled with A active again.
  fake.window = 1;
  await fake.emit("active_window_changed", { previous_id: 1, active_id: 2 });
  assert.equal(fake.contextOn(ROWS_CTX, 1), true);
  assert.ok(listedNow().includes("Git Sidebar: Stage All"));
});

test("palette commands and Focus act on the active window's section (R28, R18, R22)", async () => {
  await loadInB();
  fake.clear();
  await fake.command("Git Sidebar: Stage All");
  await fake.advance(1000);
  assert.ok(writeCalls().length > 0);
  for (const w of writeCalls()) assert.ok(inB(w), w.cwd);
  fake.clear();
  await fake.command(FOCUS);
  assert.deepEqual(focusCalls(), [[PANEL_B, "focus", 0]]);
  // In the folder with no repository, a bound key says so.
  await fake.switchWindow(3);
  await fake.advance(500);
  fake.clear();
  await fake.fire("gitSidebar_focus");
  assert.deepEqual(statuses(), [NOT_SHOWN]);
  assert.deepEqual(focusCalls(), []);
});

test("widget events are routed by panel, whatever window they name; other panels are ignored (R28, INV §11.4)", async () => {
  await loadInB();
  fake.clear();
  // B's button, in an event that names window 1.
  await fake.emit("widget_event", { window_id: 1, panel_id: PANEL_B, widget_key: "git", event_type: "action", payload: { index: 5, key: "c:b.md" }, focus_key: "git" });
  await fake.advance(500);
  assert.deepEqual(
    writeCalls().map((p) => [p.cwd, p.args.at(-1)]),
    [["/b", "b.md"]],
  );
  // The legacy panel, or anyone else's: nothing.
  fake.clear();
  await fake.widget("cancel", {}, { panel: 1 });
  await fake.advance(3000);
  assert.ok(fake.gitCalls().some(inB), "B still refreshes");
});

test("a switch closes the right-click menu; a choice after it does nothing (R28, R17)", async () => {
  await loadWindows();
  await rightClick(5, "c:b.md", 3, 10);
  assert.equal(menuMounts().length, 1);
  fake.clear();
  await fake.switchWindow(2);
  await fake.advance(500);
  assert.deepEqual(
    fake.named("unmountFloatingWidget").map((c) => c.args[0]),
    [2],
  );
  fake.clear();
  await choose("stage");
  await fake.advance(500);
  assert.deepEqual(writes(), []);
});

test("closing an inactive window ends only its section: no buffer closes, and the active window keeps refreshing (R28, INV §8 P31 f)", async () => {
  await loadInB(undefined, { status: B_STATUS, code: 0, blobs: ACC_BLOBS });
  acceptanceOnDisk("/b");
  // A diff open in B.
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(shownBuffers().length, 1);
  await fake.switchWindow(1);
  await fake.advance(500);
  fake.clear();
  await fake.closeWindow(2);
  await fake.advance(50);
  assert.deepEqual(fake.named("closeBuffer"), []);
  assert.deepEqual(fake.named("closeCompositeBuffer"), []);
  fake.clear();
  await fake.advance(30_000);
  assert.ok(fake.gitCalls().length >= 3, "A still polls");
  for (const p of fake.gitCalls()) assert.equal(p.cwd, "/repo");
  assert.deepEqual(sectionMounts(PANEL_B), []);
  assert.ok(fake.armedTimers() > 0);
});

test("a status that settles after a switch draws into the parked section and leaves the active window's timer alone (R28)", async () => {
  const a: Repo = { status: ACCEPTANCE, code: 0 };
  await loadWindows(a);
  const pending = deferred();
  a.statusOutcome = () => pending.outcome;
  await fake.emit("after_file_save", {});
  await fake.advance(500);
  await fake.switchWindow(2);
  await fake.advance(500);
  fake.clear();
  pending.resolve({ code: 0, stdout: ACCEPTANCE.replace("? new/c.txt\0", ""), stderr: "" });
  await fake.advance(10);
  assert.equal(sectionUpdates(PANEL_A).length, 1, "A's parked section updated");
  assert.equal(fake.contextOn(ROWS_CTX, 2), true, "B's contexts untouched");
  await fake.advance(5000);
  assert.ok(fake.gitCalls().some(inB), "B still polls");
  assert.ok(!fake.gitCalls().some((p) => p.cwd === "/repo"), "A does not");
});

test("a rev-parse done after a switch starts no status, and does not give up; the next activation refreshes (R28)", async () => {
  threeWindows();
  const rp = deferred();
  const a: Repo = { status: ACCEPTANCE, code: 0 };
  const base = windowsScript(a, { status: B_STATUS, code: 0 });
  let first = true;
  await load(a, {
    script: (c) => {
      if (first && c.cwd === "/repo" && c.args[1] === "--show-toplevel") {
        first = false;
        return rp.outcome;
      }
      return base(c);
    },
  });
  await fake.advance(150);
  await fake.switchWindow(2);
  await fake.advance(500);
  fake.clear();
  rp.resolve({ code: 0, stdout: "/repo\n", stderr: "" });
  await fake.advance(3000);
  assert.ok(!fake.gitCalls().some((p) => p.cwd === "/repo"), "no status for A");
  assert.deepEqual(sectionUnmounts(PANEL_A), [], "A did not give up");
  await fake.switchWindow(1);
  await fake.advance(500);
  assert.ok(fake.gitCalls().some((p) => p.cwd === "/repo" && p.args.includes("status")));
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
});

test("stage all stops at a switch, and says how far it got once its window is active again (R28, R16)", async () => {
  const records = manyUntracked(1200, "some/fairly/deep/directory/file-");
  await loadInB(undefined, { status: raw({ records }), code: 0, onWrite: () => ({ result: { code: 0, stdout: "", stderr: "" }, ms: 300 }) });
  fake.clear();
  await fake.widget("activate", { index: 1, key: "g:c", via: "space" });
  await fake.advance(150);
  assert.equal(writes().length, 1, "the first chunk is running");
  await fake.switchWindow(1);
  await fake.advance(3000);
  assert.equal(writes().length, 1, "no chunk starts while A is active");
  assert.deepEqual(statusesIn(1), []);
  await fake.switchWindow(2);
  const done = pathsOf(writes()[0]).length;
  assert.deepEqual(statusesIn(2), [`staged ${done} of 1200; the rest not run: another window became active`]);
});

test("a write queued behind another is not run once its window is inactive; both outcomes wait for the window, in order (R28, R15)", async () => {
  await loadInB(undefined, { status: B_STATUS, code: 0, onWrite: lockedWrite });
  fake.clear();
  await fake.widget("action", { index: 5, key: "c:b.md" });
  await fake.widget("action", { index: 4, key: "c:a.ts" });
  await fake.advance(50);
  await fake.switchWindow(1);
  await fake.advance(2000);
  assert.equal(writes().length, 1, "the second write did not start");
  assert.deepEqual(statusesIn(1), [], "nothing about B shown in A");
  await fake.switchWindow(2);
  assert.deepEqual(statusesIn(2), [`${LOCKED_MSG} · stage a.ts: not run; another window became active before it started`]);
});

test("a diff build overtaken by a switch opens nothing and leaves no buffers (R28, R14)", async () => {
  await loadWindows({ status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS });
  acceptanceOnDisk();
  fake.clear();
  await click(5, "c:b.md");
  await fake.switchWindow(2);
  await fake.advance(500);
  assert.deepEqual(shownBuffers(), []);
  assert.deepEqual(fake.named("createVirtualBuffer"), []);
  assert.equal(fake.openBuffers().size, 0);
});

test("two windows on one folder each get a section, with ids from their stable ids whatever the order (R28, INV §8 P31 e)", async () => {
  fake.windows = twins();
  await loadAcceptance();
  await fake.switchWindow(5);
  await fake.advance(500);
  assert.deepEqual(mountedPanels(), [panelOf("ws-co")]);
  assert.notEqual(panelOf("ws-co"), PANEL_A);
  // The other window first, in a new run: the same ids.
  restartFake();
  fake.windows = twins();
  fake.window = 5;
  await load({ status: ACCEPTANCE, code: 0 });
  assert.deepEqual(mountedPanels(), [panelOf("ws-co")]);
});

test("a window id used again gets a section of its own (R28)", async () => {
  await loadInB();
  await fake.switchWindow(1);
  await fake.closeWindow(2);
  fake.windows = [...(fake.windows ?? []), { id: 2, stable_id: "ws-9", root: "/b" }];
  fake.clear();
  await fake.switchWindow(2);
  await fake.advance(500);
  assert.deepEqual(mountedPanels(), [panelOf("ws-9", "/b")]);
});

test("load unmounts the legacy panel once, before the first mount (R28)", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  const calls = fake.widgetCalls().map((c) => [c.name, c.args[0]]);
  assert.deepEqual(calls[0], ["unmountFloatingWidget", 1]);
  assert.deepEqual(calls[1], ["mountSidebarSection", fake.panel]);
  assert.equal(calls.filter(([n, id]) => n === "unmountFloatingWidget" && id === 1).length, 1);
});

test("a window attached while away finds out where git runs again, once (R28, R13)", async () => {
  await loadInB({ status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD });
  fake.clear();
  // Fresh switches to window 1, attached meanwhile: its authority hook comes
  // first, then the switch (INV §11.4).
  fake.label = "Container:abc";
  fake.window = 1;
  await fake.emit("authority_changed", { label: fake.label });
  await fake.switchWindow(1);
  await fake.advance(1000);
  assert.equal(fake.procs.filter((p) => p.program === "pwd").length, 1);
  assert.ok(fake.gitCalls().length > 0);
  for (const p of fake.gitCalls()) assert.equal(p.via, "host");
});

test("a tab change in a window with no section yet makes it, as the first focus announcement has no window switch (R28, INV §11.3)", async () => {
  await loadWindows();
  fake.clear();
  fake.window = 2;
  await switchTo(7, "/b/README.md", 2);
  await fake.advance(500);
  assert.equal(sectionMounts(PANEL_B).at(-1)?.args[2], "Git · feature-b ↑1 ↓0");
});

test("authority_changed on a switch between windows of different authorities restarts neither: their own labels did not change (R28, R13)", async () => {
  const slow = deferred();
  const b: Repo = { status: B_STATUS, code: 0, inspect: inspectResult({ Type: "bind", Source: "/b", Destination: "/workspaces/b" }), onWrite: () => slow.outcome };
  // `pwd` in the container runs with no cwd, which the script answers from
  // the first repository: there, B's container folder.
  await loadWindows({ status: ACCEPTANCE, code: 0, pwd: pwdResult("/workspaces/b") }, b);
  // B is attached to a container: its label is its own from the start.
  fake.label = "Container:abc";
  await fake.switchWindow(2);
  await fake.advance(500);
  assert.equal(fake.allProcs.filter((p) => p.program === "pwd").length, 1);
  // A stage in B that is still running when the user goes to A and back.
  await fake.widget("action", { index: 5, key: "c:b.md" });
  await fake.advance(50);
  // Fresh moves the active window, then sends the authority hook, then the
  // switch (INV §11.4).
  fake.label = "";
  fake.window = 1;
  await fake.emit("authority_changed", { label: "" });
  await fake.switchWindow(1);
  await fake.advance(500);
  fake.label = "Container:abc";
  fake.window = 2;
  await fake.emit("authority_changed", { label: fake.label });
  await fake.switchWindow(2);
  await fake.advance(500);
  assert.equal(fake.allProcs.filter((p) => p.program === "pwd").length, 1, "B's mode is kept: no detection again");
  fake.clear();
  slow.resolve(LOCKED);
  await fake.advance(500);
  assert.deepEqual(statusesIn(2), [LOCKED_MSG], "the outcome is not lost to a restart");
});

test("two windows on one repository share its write queue: the second window's write waits for the first's (R28, R15)", async () => {
  const gate = deferred();
  let first = true;
  const repo: Repo = {
    status: ACCEPTANCE,
    code: 0,
    onWrite: () => {
      if (!first) return undefined;
      first = false;
      return gate.outcome;
    },
  };
  fake.windows = twins();
  await load(repo);
  await fake.advance(200);
  // A slow write in window 1, then the user goes to window 5 on the same repository.
  await fake.widget("action", { index: 5, key: "c:b.md" });
  await fake.advance(50);
  await fake.switchWindow(5);
  await fake.advance(500);
  fake.clear();
  await fake.widget("action", { index: 4, key: "c:a.ts" });
  await fake.advance(500);
  assert.deepEqual(writes(), [], "no second git while the first holds index.lock");
  gate.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(500);
  assert.deepEqual(writes().map((w) => w.at(-1)), ["a.ts"]);
});

test("a diff build overtaken by a switch after its buffers exist closes them once its window is active again (R28, R14, INV §11.4)", async () => {
  await loadWindows({ status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS });
  acceptanceOnDisk();
  let release!: () => void;
  fake.compositeGate = new Promise<void>((r) => (release = r));
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(fake.openBuffers().size, 2, "sources made, composite pending");
  await fake.switchWindow(2);
  await fake.advance(500);
  fake.clear();
  release();
  await fake.advance(50);
  assert.deepEqual(shownBuffers(), []);
  assert.deepEqual(fake.named("closeBuffer"), [], "nothing closed from window 2");
  assert.deepEqual(fake.named("closeCompositeBuffer"), []);
  await fake.switchWindow(1);
  await fake.advance(50);
  assert.equal(fake.named("closeCompositeBuffer").length, 1);
  assert.equal(fake.openBuffers().size, 0);
  assert.equal(fake.compositeStates().size, 0);
  for (const c of [...fake.named("closeBuffer"), ...fake.named("closeCompositeBuffer")]) assert.equal(c.window, 1);
});

test("a diff tab closed just before a switch is cleaned up on the way back (R28, R14)", async () => {
  await loadWindows({ status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS });
  acceptanceOnDisk();
  await click(5, "c:b.md");
  await fake.advance(50);
  const [composite] = shownBuffers();
  // The host handles the switch before the plugin hears of the close.
  await fake.switchWindow(2);
  await fake.advance(500);
  fake.clear();
  await fake.closeTab(composite);
  await fake.advance(50);
  assert.deepEqual(fake.named("closeCompositeBuffer"), []);
  await fake.switchWindow(1);
  await fake.advance(50);
  assert.deepEqual(fake.named("closeCompositeBuffer").map((c) => c.args[0]), [composite]);
  assert.equal(fake.openBuffers().size, 0);
  assert.equal(fake.compositeStates().size, 0);
});

test("on return, the diff hint waiting for its diff does not replace the messages that waited (R28, R20)", async () => {
  await loadInB(undefined, { status: B_STATUS, code: 0, blobs: ACC_BLOBS, onWrite: lockedWrite });
  acceptanceOnDisk("/b");
  // A diff opened from a row: the keyboard stays in the section, the hint waits.
  await fake.widget("focus", {});
  await click(5, "c:b.md");
  await fake.advance(50);
  assert.equal(shownBuffers().length, 1);
  await fake.widget("action", { index: 5, key: "c:b.md" });
  await fake.advance(50);
  await fake.widget("blur", {});
  await fake.switchWindow(1);
  await fake.advance(1000);
  assert.deepEqual(statusesIn(1), [], "the failure waits for window 2");
  fake.clear();
  await fake.switchWindow(2);
  await fake.emit("chrome_focus_changed", { window_id: 2, region: "editor", plugin: null, panel_id: null });
  await fake.advance(50);
  assert.deepEqual(statusesIn(2), [LOCKED_MSG]);
});

test("a message said in the window before its switch event is handled comes after the ones that waited, with them (R28)", async () => {
  const slow = deferred();
  await loadInB(undefined, { status: B_STATUS, code: 0, onWrite: () => slow.outcome });
  await fake.widget("action", { index: 5, key: "c:b.md" });
  await fake.advance(50);
  await fake.switchWindow(1);
  await fake.advance(50);
  slow.resolve(LOCKED);
  await fake.advance(50);
  fake.clear();
  // Window 2 is active again; its `active_window_changed` is not handled yet.
  fake.window = 2;
  await fake.command("Git Sidebar: View File");
  await fake.emit("active_window_changed", { previous_id: 1, active_id: 2 });
  await fake.advance(50);
  // The palette's View File on the row the press selected, which is deleted on disk here.
  assert.deepEqual(statusesIn(2), [`${LOCKED_MSG} · b.md is deleted`]);
});

test("a press on a section's panel handled after a switch to another window does nothing (R28)", async () => {
  await loadInB({ status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS });
  fake.clear();
  for (const [event_type, payload] of [
    ["action", { index: 5, key: "c:b.md" }],
    ["activate", { index: 5, key: "c:b.md", via: "space" }],
    ["select", { index: 5, key: "c:b.md", via: "click" }],
    ["context", { key: "c:b.md", col: 3, row: 10 }],
  ] as const) {
    await fake.widget(event_type, payload, { panel: PANEL_A });
  }
  await fake.advance(500);
  assert.ok(!fake.gitCalls().some((p) => p.cwd === "/repo"), "no git for window 1");
  assert.deepEqual(menuMounts(), []);
  assert.deepEqual(fake.named("createVirtualBuffer"), []);
  assert.deepEqual(statusesIn(2), []);
});
