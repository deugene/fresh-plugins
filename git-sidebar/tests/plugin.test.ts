import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deferred, FakeEditor, type ProcCall, type ProcOutcome } from "./fake_editor.ts";
import { rowKind, UNKNOWN_NOTICE, VOLUME_NOTICE, type TreeSpec } from "../lib/view.ts";
import { NOTHING_SELECTED } from "../lib/actions.ts";
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

/** A repository at /repo whose `git status` prints `state.status`. */
interface Repo {
  status: string;
  code: number;
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
  /** A write (`--literal-pathspecs …`): its result, by default rc 0. */
  onWrite?: (c: ProcCall) => ProcOutcome | void;
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
  return (c) => {
    if (c.program === "docker") return repo.inspect ?? { code: 1, stdout: "", stderr: "no such container" };
    if (c.program === "pwd") return repo.pwd ?? BIND_PWD;
    if (c.program !== "git") return { code: 127, stdout: "", stderr: "unknown program" };
    if (c.args[0] === "--literal-pathspecs") return repo.onWrite?.(c) ?? { code: 0, stdout: "", stderr: "" };
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
      return code === 0 ? { code: 0, stdout: "/repo\n", stderr: "" } : { code, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (repo.statusOutcome) return repo.statusOutcome();
    return repo.code === 0 ? { code: 0, stdout: repo.status, stderr: "" } : { code: repo.code, stdout: "", stderr: "fatal" };
  };
}

/** The repository the last `load` scripted. */
let currentRepo: Repo = { status: "", code: 0 };

async function load(repo: Repo, opts: { git?: boolean } = {}): Promise<void> {
  currentRepo = repo;
  fake.script = repoScript(repo);
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

/** A click on a row body, as the host reports it for a file row. */
const click = (index: number, key: string) => fake.widget("select", { index, key, via: "click" });
const statuses = () => fake.named("setStatus").map((c) => c.args[0] as string);
/** The argv of every git write (`--literal-pathspecs …`) so far. */
const writes = () => fake.gitCalls().filter((p) => p.args[0] === "--literal-pathspecs").map((p) => p.args);
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
  // Every git run is a lock-free read, or a write with literal paths (R11, R15).
  for (const p of fake.allProcs.filter((x) => x.program === "git")) {
    assert.ok(["--no-optional-locks", "rev-parse", "--literal-pathspecs"].includes(p.args[0]), p.args.join(" "));
  }
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
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
  assert.deepEqual(fake.loudCalls(), []);
});

test("no section in a non-repository; nothing logged above debug; no retries", async () => {
  await load({ status: "", code: 128 }, { git: false });
  await fake.advance(30_000);
  assert.equal(mounts().length, 0);
  // The one widget call takes down a section a previous instance of the
  // plugin left mounted across a reload (a no-op when there is none).
  assert.deepEqual(fake.widgetCalls().map((c) => c.name), ["unmountFloatingWidget"]);
  assert.deepEqual(fake.loudCalls(), []);
  assert.equal(fake.gitCalls().length, 1, "one rev-parse, then quiet until the authority changes");
});

test("no section when git cannot run (code -1), even where .git exists", async () => {
  await load({ status: "", code: -1 });
  await fake.advance(30_000);
  // The placeholder is the only mount, and it is taken down again.
  assert.equal(mounts().length, 1);
  assert.equal(fake.named("unmountFloatingWidget").length, 1);
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
  // No "focus": the host's focus reveals a hidden explorer or a collapsed
  // section, and no blur arrives when the user hides either.
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
  assert.deepEqual(statuses(), []);
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
  assert.equal(fake.named("unmountFloatingWidget").length, 1);
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
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
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
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
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
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
  // A run that fails with an ordinary code does not give up either.
  repo.statusOutcome = () => ({ code: 1, stdout: "", stderr: "transient" });
  await fake.advance(40_000);
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
  repo.statusOutcome = undefined;
  await fake.advance(5_000);
  assert.equal(lastMount().title, "Git · main ↑1 ↓0");
  assert.ok(hasFileRows(lastShown()));
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
  assert.deepEqual(fake.loudCalls(), []);
});

test("every mount is scoped to the window active at load, and the workspace is read once", async () => {
  fake.window = 7;
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD };
  await load(repo);
  await fake.advance(200);
  // Another window becomes active, with another folder.
  fake.window = 9;
  fake.cwd = "/elsewhere";
  repo.status = ACCEPTANCE.replace("# branch.head main", "# branch.head other");
  await fake.emit("focus_gained", {});
  await fake.advance(1000);
  assert.equal(lastMount().title, "Git · other ↑1 ↓0");
  // Attaching re-detects against the load-time workspace (/repo): still bind.
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  await fake.advance(1000);
  assert.equal(lastMount().title, "Git · other ↑1 ↓0");
  assert.ok(fake.gitCalls().some((p) => p.via === "host"));
  assert.equal(mounts().length, 3);
  assertEveryMountHasOptions(7);
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
  assert.equal(fake.named("unmountFloatingWidget").length, 1);
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
  assert.equal(fake.named("unmountFloatingWidget").length, 1, "no section");
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
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
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
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
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
  assert.deepEqual(statuses(), []);
  // An empty side needs no line diff: the host is not sent the other side for it.
  assert.equal(fake.named("computeLineDiff").length, 0);
  await fake.command("Git Sidebar: View File");
  assert.equal(fake.named("openFile").length, 0);
  assert.deepEqual(statuses(), ["docs is a directory"]);
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

/** The acceptance repository with b.md on disk as the fixture has it. */
async function loadAcceptance(extra: Partial<Repo> = {}): Promise<Repo> {
  const repo: Repo = { status: ACCEPTANCE, code: 0, blobs: ACC_BLOBS, ...extra };
  await load(repo);
  await fake.advance(200);
  fake.files.add("/repo/b.md");
  fake.contents.set("/repo/b.md", "# b\nchanged\n");
  fake.files.add("/repo/a.ts");
  fake.contents.set("/repo/a.ts", "export const a = 4;\n");
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
  assert.deepEqual(statuses(), []);
});

test("the diff mode is defined at load, read-only, with no keys of its own", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  assert.deepEqual(fake.named("defineMode").map((c) => c.args), [["git-sidebar-diff", [], true]]);
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
  assert.deepEqual(statuses(), []);
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
  await fake.emit("authority_changed", { label: "" });
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
  assert.ok([...fake.palette().values()].every((listed) => !listed));
  fake.label = "";
  await fake.emit("authority_changed", { label: "" });
  await fake.advance(1000);
  assert.equal(fake.contextOn("git-sidebar-rows"), true);
  await fake.widget("cancel");
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
});

test("palette context stays off when git gives up before showing anything", async () => {
  await load({ status: "", code: 128 });
  await fake.advance(1000);
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
  // Only the clear at load (F14).
  assert.deepEqual(fake.named("setContext").map((c) => c.args), [["git-sidebar-rows", false]]);
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
  const ws = fake.gitCalls().filter((p) => p.args[0] === "--literal-pathspecs");
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
  const w = fake.gitCalls().filter((p) => p.args[0] === "--literal-pathspecs");
  assert.deepEqual(w.map((p) => [p.via, p.cwd]), [["host", "/repo"]]);
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
  await fake.emit("authority_changed", { label: "" });
  gate.resolve({ code: 0, stdout: "", stderr: "" });
  await fake.advance(1000);
  assert.equal(writes().length, 1, "no more chunks after the restart");
  assert.deepEqual(statuses(), []);
});

// ---------------------------------------------------------------------------
// R18: the rest of the palette
// ---------------------------------------------------------------------------

const FIVE = [
  "Git Sidebar: Stage All",
  "Git Sidebar: Stage or Unstage",
  "Git Sidebar: Unstage All",
  "Git Sidebar: View Diff",
  "Git Sidebar: View File",
];

test("all five commands are registered, under the rows context (R18)", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  assert.deepEqual([...fake.palette().keys()].sort(), FIVE);
  for (const c of fake.named("registerCommand")) assert.equal(c.args[3], "git-sidebar-rows", String(c.args[0]));
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
  assert.ok([...fake.palette().values()].every((listed) => !listed));
  for (const name of FIVE) await fake.command(name);
  await fake.advance(1000);
  assert.deepEqual(fake.gitCalls(), []);
  assert.equal(statuses().length, 5);
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
    { id: 2, labels: ["Unstage All"] },
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
  assert.equal(fake.named("unmountFloatingWidget").length, 0);
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
  assert.deepEqual(fake.named("setContext").map((c) => c.args), [["git-sidebar-rows", false]]);
  const order = fake.calls.map((c) => c.name).filter((n) => n === "setContext" || n === "mountSidebarSection");
  assert.deepEqual(order, ["setContext", "mountSidebarSection"]);
  assert.equal(fake.contextOn("git-sidebar-rows"), false);
  assert.ok([...fake.palette().values()].every((listed) => !listed), "nothing listed under the placeholder");
});
