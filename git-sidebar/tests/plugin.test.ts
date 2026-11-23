import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deferred, FakeEditor, type ProcCall, type ProcOutcome } from "./fake_editor.ts";
import { rowKind, UNKNOWN_NOTICE, VOLUME_NOTICE, type TreeSpec } from "../lib/view.ts";
import { fixture, GS_VOLUME, H, inspectResult, mod, pwdResult, raw, texts, untracked } from "./helpers.ts";

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
}

function repoScript(repo: Repo): (c: ProcCall) => ProcOutcome {
  return (c) => {
    if (c.program === "docker") return repo.inspect ?? { code: 1, stdout: "", stderr: "no such container" };
    if (c.program === "pwd") return repo.pwd ?? BIND_PWD;
    if (c.program !== "git") return { code: 127, stdout: "", stderr: "unknown program" };
    if (c.args[0] === "rev-parse") {
      const code = repo.revParseCode ?? repo.code;
      return code === 0 ? { code: 0, stdout: "/repo\n", stderr: "" } : { code, stdout: "", stderr: "fatal: not a git repository" };
    }
    if (repo.statusOutcome) return repo.statusOutcome();
    return repo.code === 0 ? { code: 0, stdout: repo.status, stderr: "" } : { code: repo.code, stdout: "", stderr: "fatal" };
  };
}

async function load(repo: Repo, opts: { git?: boolean } = {}): Promise<void> {
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

test("activation: deleted file gives a status message and no buffer; groups toggle", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  await fake.advance(200);
  fake.files.add("/repo/b.md");
  fake.clear();
  await fake.widget("activate", { index: 6, key: "c:gone.ts" });
  assert.equal(fake.named("openFile").length, 0);
  assert.deepEqual(fake.named("setStatus").map((c) => c.args[0]), ["git-sidebar: gone.ts is deleted"]);
  await fake.widget("activate", { index: 5, key: "c:b.md" });
  assert.deepEqual(fake.named("openFile").map((c) => c.args[0]), ["/repo/b.md"]);
  fake.clear();
  await fake.widget("activate", { index: 3, key: "g:c" });
  await fake.widget("activate", { index: 3, key: "g:c", via: "space" });
  assert.deepEqual(mutations(), [
    { kind: "setExpandedKeys", widgetKey: "git", keys: ["g:s"] },
    { kind: "setExpandedKeys", widgetKey: "git", keys: ["g:s", "g:c"] },
  ]);
  fake.clear();
  await fake.widget("activate", { index: 0, key: "more:c" });
  assert.deepEqual(fake.calls.filter((c) => c.name !== "fileExists"), []);
});

test("every git argument list starts with --no-optional-locks or is rev-parse", async () => {
  await load({ status: ACCEPTANCE, code: 0 });
  await fake.advance(20_000);
  await fake.emit("after_file_save", {});
  await fake.advance(5_000);
  const calls = fake.gitCalls();
  assert.ok(calls.length > 5);
  for (const c of calls) assert.ok(c.args[0] === "--no-optional-locks" || c.args[0] === "rev-parse", c.args.join(" "));
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

test("authority_changed keeps the root: Enter on a shown file row still opens it", async () => {
  const repo: Repo = { status: ACCEPTANCE, code: 0, inspect: BIND_INSPECT, pwd: BIND_PWD };
  await load(repo);
  await fake.advance(200);
  fake.files.add("/repo/b.md");
  fake.label = "Container:abc";
  await fake.emit("authority_changed", { label: fake.label });
  // Before the refresh the attach asked for has run.
  await fake.widget("activate", { index: 5, key: "c:b.md" });
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
  await fake.widget("activate", { index: 2, key: "c:sub" });
  await fake.widget("activate", { index: 3, key: "c:vendor/lib/" });
  assert.equal(fake.named("openFile").length, 0);
  assert.deepEqual(fake.named("setStatus").map((c) => c.args[0]), [
    "git-sidebar: sub is a directory (submodule or nested repository)",
    "git-sidebar: vendor/lib is a directory (submodule or nested repository)",
  ]);
});

test("a root file named `~more` in an overflowing group has its own key and opens", async () => {
  const records = [untracked("~more")];
  for (let i = 0; i < 600; i++) records.push(untracked(`~n${String(i).padStart(4, "0")}.txt`));
  await load({ status: raw({ records }), code: 0 });
  await fake.advance(200);
  const keys = lastShown().itemKeys;
  assert.equal(new Set(keys).size, keys.length, "item keys unique");
  assert.equal(keys[2], "c:~more");
  fake.files.add("/repo/~more");
  await fake.widget("activate", { index: 2, key: "c:~more" });
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

test("a file row whose path is now a directory gives a status message, never openFile", async () => {
  await load({ status: raw({ records: [mod(".D", "docs"), untracked("docs/x.md")] }), code: 0 });
  await fake.advance(200);
  fake.dirs.add("/repo/docs");
  fake.clear();
  await fake.widget("activate", { index: 2, key: "c:docs" });
  assert.equal(fake.named("openFile").length, 0);
  assert.deepEqual(fake.named("setStatus").map((c) => c.args[0]), ["git-sidebar: docs is a directory"]);
});

test("a workspace below the repository root mounts the placeholder at load", async () => {
  fake.cwd = "/repo/sub/dir";
  await load({ status: ACCEPTANCE, code: 0 });
  assert.equal(mounts().length, 1);
  assert.equal(lastMount().title, "Git");
});
