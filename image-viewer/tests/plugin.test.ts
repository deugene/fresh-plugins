import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BLOCKED, FakeEditor, type ProcCall, type ProcOutcome, type ProcResult } from "./fake_editor.ts";
import { NO_TOOL } from "../lib/tools.ts";

let fake: FakeEditor;
let rejections: unknown[] = [];
const onRejection = (e: unknown) => rejections.push(e);
let loads = 0;

const MODE = "image-viewer";
const SHOW = "Image Viewer: Show Image";
const QUAD = "/work/quadrants.png";
const BIG = "/work/big.jpg";

type Px = (x: number, y: number) => number[];
const QUADRANTS: Px = (x, y) => (y < 150 ? (x < 200 ? [255, 0, 0, 255] : [0, 255, 0, 255]) : x < 200 ? [0, 0, 255, 255] : [255, 255, 255, 255]);

/** A PAM of `w`×`h` whose pixel (i, j) is `px` at the source point it shows. */
function pam(w: number, h: number, at: (i: number, j: number) => number[]): string {
  const head = Buffer.from(`P7\nWIDTH ${w}\nHEIGHT ${h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`, "latin1");
  const body = Buffer.alloc(w * h * 4);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) body.set(at(i, j), (j * w + i) * 4);
  return Buffer.concat([head, body]).toString("base64");
}

/** The crop an ffmpeg `-vf` asks for: [w, h, x, y]. */
const cropOf = (vf: string): number[] => /crop=(\d+):(\d+):(\d+):(\d+)/.exec(vf)!.slice(1).map(Number);

/** The output an ffmpeg render's `-vf` asks for, drawn from `px`. */
function ffmpegOutput(vf: string, px: Px): string {
  const c = cropOf(vf);
  const sc = /scale=(\d+):(\d+)/.exec(vf);
  const [ow, oh] = sc ? [Number(sc[1]), Number(sc[2])] : [c[0], c[1]];
  return pam(ow, oh, (i, j) => px(c[2] + Math.floor(((i + 0.5) * c[0]) / ow), c[3] + Math.floor(((j + 0.5) * c[1]) / oh)));
}

interface Tools {
  /** What `command -v` finds; null: none. */
  tool?: "ffmpeg" | "magick" | "sips" | null;
  /** Image sizes by path; a path not listed is corrupt. */
  sizes?: Record<string, { w: number; h: number }>;
  px?: Px;
  /** Overrides a render step's outcome. */
  render?: (c: ProcCall) => ProcOutcome | undefined;
  renderMs?: number;
}

const ok = (stdout = "", stderr = ""): ProcResult => ({ code: 0, stdout, stderr });

function tools(t: Tools = {}): (c: ProcCall) => ProcOutcome {
  const tool = t.tool === undefined ? "ffmpeg" : t.tool;
  const sizes = t.sizes ?? { [QUAD]: { w: 400, h: 300 }, [BIG]: { w: 4000, h: 3000 } };
  const lastRender = new Map<string, string>();
  return (c) => {
    if (c.program === "sh" && c.args[1].startsWith("for t in")) return tool === null ? { code: 1, stdout: "", stderr: "" } : ok(`${tool}\n`);
    if (c.program === "sh" && c.args[1].startsWith("base64")) return ok(lastRender.get(c.args[3]) ?? "");
    if (c.program === "chmod") return ok();
    if (c.program === "ffmpeg" && c.args.includes("showinfo")) {
      const path = c.args[c.args.indexOf("-i") + 1];
      const s = sizes[path];
      if (s === undefined) return { code: 1, stdout: "", stderr: `[png @ 0x1] Invalid PNG signature 0x7468697320697320.\n${path}: Invalid data\n` };
      return ok("", `Input #0\n[Parsed_showinfo_0 @ 0x1] n:   0 pts:      0 fmt:rgb24 s:${s.w}x${s.h} i:P\n`);
    }
    if (c.program === "ffmpeg") {
      const custom = t.render?.(c);
      if (custom !== undefined) return custom;
      lastRender.set(c.args.at(-1)!, ffmpegOutput(c.args[c.args.indexOf("-vf") + 1], t.px ?? QUADRANTS));
      return t.renderMs ? { result: ok(), ms: t.renderMs } : ok();
    }
    if (c.program === "sips") {
      const custom = t.render?.(c);
      if (custom !== undefined) return custom;
      if (c.args[0] === "-g") return ok("x\n  pixelWidth: 400\n  pixelHeight: 300\n");
      return { result: ok(), ms: t.renderMs ?? 0 };
    }
    return { code: 127, stdout: "", stderr: "unknown program" };
  };
}

async function load(): Promise<void> {
  await import(`../image_viewer.ts?load=${++loads}`);
  await fake.flush();
}

/** Opens `path` in the active window and lets the view come up. */
async function openImage(path = QUAD): Promise<number> {
  const id = await fake.open(path);
  await fake.advance(20);
  return id;
}

const procsOf = (program: string) => fake.procs.filter((p) => p.program === program);
/** The directories runs made that are still there (R11, INV §8 P31). */
const liveDirs = () => fake.scratches().filter((d) => d.live).map((d) => d.dir);
/** The run directory a file was written in. */
const dirOf = (file: string) => file.slice(0, file.lastIndexOf("/"));
const renders = () => procsOf("ffmpeg").filter((p) => !p.args.includes("showinfo"));
/** Moves the clock to `t`. */
const advanceTo = (t: number) => fake.advance(t - fake.now);
const vfs = () => renders().map((p) => p.args[p.args.indexOf("-vf") + 1]);
const groupOf = (window = fake.activeWindow) => fake.groups(window)[0];
const headerOf = (window = fake.activeWindow) => {
  const e = groupOf(window)?.content.get("hdr") as { text: string }[] | undefined;
  return e?.[0].text ?? "";
};
const imageOf = (window = fake.activeWindow) => groupOf(window)?.content.get("img") as { text: string; inlineOverlays: { start: number; style: { fg?: unknown; bg?: unknown } }[] }[] | undefined;

beforeEach(async () => {
  rejections = [];
  process.on("unhandledRejection", onRejection);
  fake = new FakeEditor();
  fake.script = tools();
  fake.install();
  await load();
});

afterEach(async () => {
  await fake.advance(20_000);
  fake.uninstall();
  process.off("unhandledRejection", onRejection);
  assert.deepEqual(rejections, [], "no unhandled rejection");
  assert.equal(fake.running.size, 0, "no process left running");
  assert.deepEqual(liveDirs(), [], "no directory left behind (R11)");
  assert.equal(procsOf("rm").length, 0, "the editor removes them: no rm");
});

// ---------------------------------------------------------------- step 7: opening

test("an image opens as a group in its own tab, with the loading header first, then the image (R1, R2, A1)", async () => {
  const id = await fake.open(QUAD);
  const create = fake.named("createBufferGroup");
  assert.equal(create.length, 1);
  // The group is asked for before anything else; detecting the tool starts
  // right after it, while the create is in flight.
  assert.deepEqual(fake.procs.map((p) => p.program), ["sh"]);
  assert.ok(create[0].order < fake.procs[0].order, "the create comes first");
  assert.equal(create[0].args[1], MODE);
  assert.deepEqual(create[0].args[3], { inTabOf: id });
  assert.deepEqual(JSON.parse(String(create[0].args[2])), { type: "split", direction: "v", ratio: 0.1, first: { type: "fixed", id: "hdr", height: 1 }, second: { type: "scrollable", id: "img" } });
  await fake.advance(20);
  const hdr = fake.named("setPanelContent").filter((c) => c.args[1] === "hdr");
  assert.deepEqual(hdr[0].args[2], [{ text: "quadrants.png  loading…" }], "loading first");
  assert.equal(fake.groups().length, 1);
  assert.equal(fake.ownTabs().length, 0, "one tab: the file's");
  assert.match(headerOf(), /^quadrants\.png {2}400×300 {2}fit {2}/);
  const img = imageOf()!;
  assert.equal(img.length, 55);
  // 400×300 at fit in 199×110 px: 147×110, centred from column 26.
  assert.equal(img[0].text, " ".repeat(26) + "▀".repeat(147) + " ".repeat(26) + "\n");
  const first = img[0].inlineOverlays.find((o) => o.start === 26)!;
  assert.deepEqual(first.style, { fg: [255, 0, 0], bg: [255, 0, 0] });
  for (const name of ["setLineNumbers", "setBufferShowCursors", "setLineWrap"]) assert.equal(fake.named(name).length, 2, name);
  assert.deepEqual(fake.named("setLineWrap")[1].args.slice(2), [false]);
  assert.deepEqual(fake.statuses(), []);
});

test("non-images, SVG and panels (path '') are left alone (R1, A3)", async () => {
  await fake.open("/work/notes.txt");
  await fake.open("/work/logo.svg");
  await fake.open("");
  await fake.advance(20);
  assert.equal(fake.named("createBufferGroup").length, 0);
  assert.equal(fake.procs.length, 0);
  await fake.open("/work/upper/QUADRANTS.PNG");
  assert.equal(fake.named("createBufferGroup").length, 1, "any case");
});

test("explorer Enter (activate 2, activate 3, close 2) leaves one group, in the file's tab, and no orphan (P2, INV §8 P17)", async () => {
  const two = await fake.open(QUAD);
  const three = await fake.open(QUAD);
  await fake.closeTab(two);
  await fake.advance(20);
  assert.equal(fake.named("createBufferGroup").length, 2);
  const groups = fake.groups();
  assert.equal(groups.length, 1, JSON.stringify(groups.map((g) => [g.id, g.file, g.inTab])));
  assert.equal(groups[0].file, three);
  assert.ok(groups[0].inTab);
  assert.match(headerOf(), /400×300/);
});

test("a create that resolves after its tab closed closes its group (INV §8 P17)", async () => {
  fake.createMs = 50;
  const id = await fake.open(QUAD);
  fake.autoViewport = null;
  await fake.closeTab(id);
  await fake.advance(100);
  assert.equal(fake.groups().length, 0);
  assert.equal(fake.named("closeBufferGroup").length, 1);
});

test("a create that lands in a tab of its own is closed, and the next activation tries again (INV §8 P17)", async () => {
  fake.createMs = 50;
  const img = await fake.open(QUAD);
  const txt = await fake.open("/work/notes.txt");
  await fake.advance(100);
  assert.equal(fake.groups().length, 0, "the own-tab group is closed");
  fake.createMs = 0;
  await fake.activate(img);
  await fake.advance(20);
  assert.equal(fake.groups().length, 1);
  assert.ok(groupOf().inTab);
  assert.ok(txt > 0);
});

test("an explorer preview while the image still loads opens as its own tab, not into the view's empty panel (R1, A1, INV §8 P32)", async () => {
  fake.script = tools({ renderMs: 300 });
  const a = await fake.open(QUAD);
  await fake.advance(20);
  assert.deepEqual(imageOf(), [{ text: " " }], "the image panel has content as soon as the group is up, before the image");
  const b = await fake.preview(BIG, a);
  assert.ok(fake.openBuffers().some((x) => x.id === b && x.path === BIG && !x.panel), "the new preview is a file of its own");
  await fake.advance(1_000);
  assert.ok(fake.openBuffers().some((x) => x.id === b && x.path === BIG), "and is still open after the old preview's group closed");
  const groups = fake.groups();
  assert.deepEqual(groups.map((g) => [g.file, g.inTab]), [[b, true]], "one group, in the new preview's tab");
  assert.match(headerOf(), /4000×3000/);
});

test("the view ending kills its running step at once, not at the deadline: b, Show Image, the tab closing (R8, R11)", async () => {
  fake.script = tools({ render: () => "hang" });
  const t0 = fake.now;
  const id = await openImage();
  const first = renders().at(-1)!;
  assert.ok(fake.running.has(first));
  await fake.key("b");
  assert.ok(fake.kills.includes(first), "b kills the render");
  await fake.advance(20);
  await fake.command(SHOW);
  await fake.advance(20);
  const second = renders().at(-1)!;
  assert.notEqual(second, first);
  assert.ok(fake.running.has(second));
  await fake.closeTab(id);
  assert.ok(fake.kills.includes(second), "closing the tab kills the render");
  assert.ok(fake.now - t0 < 1_000, "long before the 10 s deadline");
  assert.deepEqual(liveDirs(), [], "and the run's directory goes once the step has exited");
});

test("the pre-check: an activation of a file that is no longer active does nothing (INV §8 P17)", async () => {
  const id = await fake.open("/work/notes.txt");
  await fake.emit("buffer_activated", { buffer_id: id + 100, window_id: 1 });
  assert.equal(fake.named("createBufferGroup").length, 0);
});

test("a rejected create leaves the bytes, a status message and Show Image (R11)", async () => {
  fake.createError = new Error("no layout");
  await fake.open(QUAD);
  await fake.advance(20);
  assert.equal(fake.groups().length, 0);
  assert.equal(fake.statuses().length, 1);
  assert.match(fake.statuses()[0], /^quadrants\.png: could not open the image view/);
  assert.equal(fake.palette().get(SHOW), true);
  await fake.command(SHOW);
  await fake.advance(20);
  assert.equal(fake.groups().length, 1);
  assert.equal(fake.palette().get(SHOW), false);
});

test("a create that throws at once leaves the bytes and Show Image, not a tab stuck loading (R11)", async () => {
  fake.createThrow = new TypeError("bad layout");
  await fake.open(QUAD);
  await fake.advance(20);
  assert.equal(fake.groups().length, 0);
  assert.match(fake.statuses()[0], /^quadrants\.png: could not open the image view \(bad layout\)/);
  assert.equal(fake.palette().get(SHOW), true);
  await fake.command(SHOW);
  await fake.advance(20);
  assert.equal(fake.groups().length, 1);
  assert.equal(fake.palette().get(SHOW), false);
});

test("promoting a preview keeps the group: after_file_open does nothing (P7)", async () => {
  const id = await openImage();
  await fake.emit("after_file_open", { buffer_id: id, window_id: 1, path: QUAD });
  await fake.advance(20);
  assert.equal(fake.named("createBufferGroup").length, 1);
  assert.equal(fake.groups().length, 1);
});

test("q closes the file's tab; nothing of the view is left; opening again shows the image (R8, A11)", async () => {
  await openImage();
  await fake.key("q");
  assert.equal(fake.named("closeBuffer").length, 1);
  await fake.advance(20);
  assert.equal(fake.groups().length, 0);
  assert.deepEqual(fake.openBuffers(), []);
  await openImage();
  assert.equal(fake.groups().length, 1);
  assert.match(headerOf(), /400×300/);
});

test("Alt+W or × (the host closes the tab) forgets the state, and a reopen shows the image (R8, R7)", async () => {
  const id = await openImage();
  await fake.key("b");
  await fake.advance(20);
  await fake.closeTab(id);
  await openImage();
  assert.equal(fake.groups().length, 1, "a file opened again after its tab closed shows the image");
});

// ---------------------------------------------------------------- step 8: tools and failures

test("no tool: the bytes and a message naming the tools; then, tools back, a later open shows the image (R10, A13)", async () => {
  fake.script = tools({ tool: null });
  const id = await openImage();
  assert.equal(fake.groups().length, 0);
  assert.deepEqual(fake.statuses(), [`quadrants.png: ${NO_TOOL}`]);
  assert.equal(fake.named("createBufferGroup").length, 1, "the bytes stay: no reopen loop");
  await fake.closeTab(id);
  fake.script = tools();
  await openImage();
  assert.equal(fake.groups().length, 1);
  assert.match(headerOf(), /400×300/);
});

test("a corrupt file: the bytes and the tool's first stderr line (R11, A14)", async () => {
  await openImage("/work/corrupt.png");
  assert.equal(fake.groups().length, 0);
  assert.deepEqual(fake.statuses(), ["corrupt.png: [png @ 0x1] Invalid PNG signature 0x7468697320697320."]);
  await openImage();
  assert.equal(fake.groups().length, 1, "and a valid image still opens");
});

test("output that cannot be parsed: the bytes and a reason (R11)", async () => {
  fake.script = tools({ render: () => ok() });
  await openImage();
  assert.equal(fake.groups().length, 0);
  assert.match(fake.statuses()[0], /^quadrants\.png: cannot read ffmpeg's output/);
});

test("trust Blocked and a remote window: the bytes, a message, and no process at all (R11, INV §7)", async () => {
  await fake.setTrust("blocked");
  await openImage();
  assert.deepEqual(fake.statuses(), ["image viewer: workspace trust is Blocked"]);
  assert.equal(fake.named("createBufferGroup").length, 0);
  assert.equal(fake.procs.length, 0);
  assert.equal(fake.palette().get(SHOW), true);
  await fake.setTrust("trusted");
  fake.addWindow(2, { remote: true });
  await fake.switchWindow(2);
  await openImage("/work/b.png");
  assert.deepEqual(fake.statuses(2), ["image viewer: remote window"]);
  assert.equal(fake.named("createBufferGroup").length, 0);
});

test("a hang is killed at 10 s, says so, and its directory is removed (R11, A14, INV §8 P31)", async () => {
  fake.script = tools({ render: () => "hang" });
  await openImage();
  const render = renders()[0];
  await fake.advance(9_000);
  assert.equal(fake.kills.length, 0);
  assert.equal(fake.groups().length, 1);
  await fake.advance(1_100);
  assert.deepEqual(fake.kills, [render]);
  assert.equal(fake.groups().length, 0);
  assert.deepEqual(fake.statuses(), ["quadrants.png: ffmpeg timed out after 10 s"]);
  const out = render.args.at(-1)!;
  assert.match(out, /^\/cfg\/\.staging\/image-viewer-\d+\/0\.pam$/, "written in the editor's directory, not the shared temp dir");
  await fake.advance(1_000);
  assert.ok(!liveDirs().includes(dirOf(out)), "removed once the killed step has exited");
});

test("every file a tool writes is in a directory of the run's own, and each run gets a new one (INV §8 P31)", async () => {
  fake.script = tools({ tool: "sips" });
  await openImage();
  const files = procsOf("sips").flatMap((p) => p.args.filter((_, i) => p.args[i - 1] === "--out" || (p.args[0] === "-g" && i === p.args.length - 1)));
  assert.equal(files.length, 4, JSON.stringify(files));
  for (const f of files) assert.match(f, /^\/cfg\/\.staging\/image-viewer-\d+\/\d\.bmp$/, f);
  const dirs = fake.scratches().map((d) => d.dir);
  assert.deepEqual(dirs, [...new Set(files.map(dirOf))], "the size probe's, then the fit render's");
  // The staging directory is made private once, before any tool writes in it (INV §8 P31).
  assert.deepEqual(procsOf("chmod").map((p) => p.args), [["700", "/cfg/.staging"]]);
  assert.ok(fake.procs.findIndex((p) => p.program === "chmod") < fake.procs.findIndex((p) => p.program === "sips"));
  assert.deepEqual(liveDirs(), []);
});

test("no directory can be made: the bytes, with the reason (R11)", async () => {
  fake.scratchFail = true;
  await openImage();
  assert.equal(fake.groups().length, 0);
  assert.deepEqual(fake.statuses(), ["quadrants.png: cannot create a temporary directory"]);
  assert.equal(renders().length, 0, "nothing runs without one");
  assert.equal(fake.palette().get(SHOW), true);
});

test("a tab closed between sips passes kills the running pass, runs no further pass and removes the run's directory (R8, R11)", async () => {
  fake.script = tools({ tool: "sips", renderMs: 100 });
  const id = await fake.open(QUAD);
  await fake.advance(250);
  const before = procsOf("sips").length;
  const running = [...fake.running].filter((p) => p.program === "sips");
  assert.equal(running.length, 1, "a pass is running at the close");
  await fake.closeTab(id);
  assert.ok(fake.kills.includes(running[0]), "it is killed at the close");
  await fake.advance(1_000);
  const sips = procsOf("sips");
  assert.equal(sips.length, before, "no pass after the close");
  // The size probe's directory, then the render's, cut short: both gone.
  assert.deepEqual(fake.scratches().map((d) => d.live), [false, false]);
  assert.equal(procsOf("sh").filter((p) => p.args[1].startsWith("base64")).length, 0);
});

test("b, and every failure, leave the bytes: the re-activation after buffer_group_closed is ignored (R7, A10, INV §2)", async () => {
  const file = await openImage();
  await fake.key("b");
  await fake.advance(20);
  assert.equal(fake.groups().length, 0);
  assert.equal(fake.named("createBufferGroup").length, 1, "no reopen");
  assert.equal(fake.palette().get(SHOW), true);
  // Switching away and back keeps the bytes.
  await fake.open("/work/notes.txt");
  assert.equal(fake.palette().get(SHOW), false, "not listed on a text file");
  await fake.activate(file);
  await fake.advance(20);
  assert.equal(fake.named("createBufferGroup").length, 1);
  assert.equal(fake.palette().get(SHOW), true);
});

test("a host-closed group (not ours) also leaves the bytes (R7, INV §2)", async () => {
  const file = await openImage();
  await fake.emit("buffer_group_closed", { group_id: groupOf().id, window_id: 1 });
  await fake.emit("buffer_activated", { buffer_id: file, window_id: 1 });
  await fake.advance(20);
  assert.equal(fake.named("createBufferGroup").length, 1);
});

test("a deadline in window A while B is active closes nothing in B, and lands when A is active again (INV §2)", async () => {
  fake.script = tools({ render: (c) => (c.window === 1 ? "hang" : undefined) });
  fake.addWindow(2);
  await openImage();
  await fake.switchWindow(2);
  await openImage();
  assert.equal(fake.groups(2).length, 1);
  await fake.advance(11_000);
  assert.equal(fake.kills.length, 1);
  assert.equal(fake.named("closeBufferGroup").length, 0, "nothing closed while A is not active");
  assert.deepEqual(fake.statuses(2), []);
  assert.equal(fake.groups(2).length, 1);
  assert.equal(fake.groups(1).length, 1);
  await fake.switchWindow(1);
  await fake.advance(20);
  assert.equal(fake.groups(1).length, 0);
  assert.equal(fake.groups(2).length, 1);
  assert.deepEqual(fake.statuses(1), ["quadrants.png: ffmpeg timed out after 10 s"]);
  assert.ok(fake.named("closeBufferGroup").every((c) => c.window === 1));
});

test("two windows with the same group and split ids do not collide (INV §2)", async () => {
  fake.addWindow(2);
  await openImage();
  await fake.switchWindow(2);
  await openImage(BIG);
  const [a, b] = [groupOf(1), groupOf(2)];
  assert.deepEqual([a.id, a.splits], [b.id, b.splits], "the ids are equal");
  const before = renders().length;
  await fake.viewport(b.splits.img, 111, 40, 2);
  await fake.advance(20);
  assert.equal(renders().length, before + 1);
  const last = renders().at(-1)!.args;
  assert.equal(last[last.indexOf("-i") + 1], BIG, "window 2's image re-rendered");
  assert.equal(imageOf(1)!.length, 55, "window 1 unchanged");
  assert.equal(imageOf(2)!.length, 40);
  await fake.emit("buffer_group_closed", { group_id: b.id, window_id: 2 });
  await fake.key("+");
  await fake.advance(20);
  assert.equal(headerOf(1).includes("400×300  fit"), true, "window 1's view untouched");
});

test("two windows holding the same buffer id keep their own views; closing one leaves the other (INV §2; the host's buffer ids are global, the fake's are not)", async () => {
  fake.addWindow(2);
  const one = await openImage();
  await fake.switchWindow(2);
  const two = await openImage(BIG);
  assert.equal(one, two, "the same id, in different windows");
  assert.match(headerOf(1), /400×300/);
  assert.match(headerOf(2), /4000×3000/);
  await fake.closeTab(two, 2);
  await fake.advance(20);
  assert.equal(fake.groups(2).length, 0);
  assert.equal(fake.groups(1).length, 1, "window 1's tab is untouched");
  await fake.switchWindow(1);
  await fake.key("+");
  await fake.advance(20);
  assert.match(headerOf(1), / 50% /, "and its state is still there");
});

test("a render result for an inactive window is queued and drawn when it is active again (INV §2)", async () => {
  fake.script = tools({ renderMs: 300 });
  fake.addWindow(2);
  await fake.open(QUAD);
  await fake.advance(20);
  await fake.switchWindow(2);
  await fake.advance(500);
  assert.deepEqual(imageOf(1), [{ text: " " }], "only the placeholder (INV §8 P32): not drawn into window 2's active window");
  assert.equal(fake.named("setPanelContent").filter((c) => c.window !== 1).length, 0);
  await fake.switchWindow(1);
  assert.equal(imageOf(1)!.length, 55);
});

// ---------------------------------------------------------------- step 9: keys, resize, Show Image

test("the mode binds exactly the view's keys (P13)", () => {
  assert.deepEqual(fake.bindings().sort(), ["+", "-", "0", "=", "Down", "Left", "Right", "Up", "b", "h", "j", "k", "l", "q"].sort());
  assert.equal(fake.named("defineMode")[0].args[2], true, "read-only");
});

test("key → view → argv: + and - walk the stops on the 4000×3000 JPEG, 0 returns to fit (R4, A6)", async () => {
  await openImage(BIG);
  assert.equal(vfs()[0], "crop=4000:3000:0:0:exact=1,scale=147:110:flags=area,format=rgba");
  await fake.key("+");
  assert.match(headerOf(), / 6\.25% /, "the header changes at once");
  await fake.advance(20);
  assert.equal(vfs().at(-1), "crop=3184:1760:408:620:exact=1,scale=199:110:flags=area,format=rgba");
  for (let i = 0; i < 4; i++) await fake.key("=");
  await fake.advance(20);
  assert.match(headerOf(), / 100% /);
  assert.equal(vfs().at(-1), "crop=199:110:1900:1445:exact=1,format=rgba");
  for (let i = 0; i < 4; i++) await fake.key("+");
  await fake.advance(20);
  assert.match(headerOf(), / 800% /);
  const n = renders().length;
  await fake.key("+");
  await fake.advance(20);
  assert.equal(renders().length, n, "+ at 800% changes nothing");
  await fake.key("0");
  await fake.advance(20);
  assert.match(headerOf(), / fit /);
  await fake.key("-");
  await fake.advance(20);
  assert.equal(renders().length, n + 1, "- at fit changes nothing");
});

test("pan: arrows and h j k l move a quarter of the area and stop at the edge (R5, A8)", async () => {
  await openImage();
  // quadrants.png fits at 36.7%: + goes 50, 100, 200, 400%.
  for (let i = 0; i < 4; i++) await fake.key("+");
  await fake.advance(20);
  assert.match(headerOf(), / 400% /);
  const crop = () => cropOf(vfs().at(-1)!);
  const x0 = crop()[2];
  await fake.key("Right");
  await fake.advance(20);
  // A quarter of 199 cells is 49 cells: 12.25 source pixels at 400%.
  assert.ok([12, 13].includes(crop()[2] - x0), String(crop()[2] - x0));
  const afterRight = crop()[2];
  await fake.key("l");
  await fake.advance(20);
  assert.ok(crop()[2] > afterRight);
  for (let i = 0; i < 60; i++) await fake.key("l");
  await fake.advance(20);
  const [w, , x] = crop();
  assert.equal(x + w, 400, "the image's last column is in the area's last column");
  for (let i = 0; i < 60; i++) await fake.key("k");
  await fake.advance(20);
  assert.equal(crop()[3], 0);
  for (let i = 0; i < 60; i++) await fake.key("Down");
  await fake.advance(20);
  assert.equal(crop()[3] + crop()[1], 300);
  for (let i = 0; i < 60; i++) await fake.key("h");
  await fake.advance(20);
  assert.equal(crop()[2], 0);
  await fake.key("Left");
  await fake.key("Up");
  await fake.key("j");
  await fake.key("0");
  await fake.advance(20);
  const n = renders().length;
  for (const k of ["Left", "Right", "Up", "Down"]) await fake.key(k);
  await fake.advance(20);
  assert.equal(renders().length, n, "at fit the arrows change nothing");
});

test("resize: a new area re-renders; at fit it fits; a shrink re-cuts the last frame at once (R6, A9)", async () => {
  fake.script = tools({ renderMs: 200 });
  await fake.open(QUAD);
  await fake.advance(300);
  const g = groupOf();
  await fake.viewport(g.splits.img, 111, 40);
  // Before the new render lands, the old frame is cut to 111×40.
  const cut = imageOf()!;
  assert.equal(cut.length, 40);
  assert.equal(Array.from(cut[0].text.replace(/\n$/, "")).length, 111);
  await fake.advance(300);
  assert.equal(vfs().at(-1), "crop=400:300:0:0:exact=1,format=gbrap16le,premultiply=inplace=1,scale=107:80:flags=area,unpremultiply=inplace=1,format=rgba");
  assert.equal(imageOf()!.length, 40);
  // At 400%, a resize keeps the scale and the centre.
  for (let i = 0; i < 4; i++) await fake.key("+");
  await fake.advance(1_000);
  const before = cropOf(vfs().at(-1)!);
  await fake.viewport(g.splits.img, 199, 55);
  await fake.advance(1_000);
  const after = cropOf(vfs().at(-1)!);
  assert.match(headerOf(), / 400% /);
  assert.ok(Math.abs(before[2] + before[0] / 2 - (after[2] + after[0] / 2)) <= 1, `centre x kept: ${before} → ${after}`);
  assert.ok(Math.abs(before[3] + before[1] / 2 - (after[3] + after[1] / 2)) <= 1, `centre y kept: ${before} → ${after}`);
});

test("the area comes only from the image split's viewport_changed (INV §8 P17)", async () => {
  fake.autoViewport = null;
  await fake.open(QUAD);
  await fake.advance(20);
  assert.equal(renders().length, 0, "detect and size run, but no render without the area");
  assert.ok(fake.procs.some((p) => p.args.includes("showinfo")));
  const g = groupOf();
  await fake.viewport(g.splits.hdr, 200, 1);
  await fake.advance(20);
  assert.equal(renders().length, 0, "the header's split is not the area");
  await fake.viewport(g.splits.img, 199, 55);
  await fake.advance(20);
  assert.equal(renders().length, 1);
});

test("Show Image is listed only while the active tab is an image showing its bytes; it opens at fit (R7, A10)", async () => {
  assert.equal(fake.palette().get(SHOW), false);
  const txt = await fake.open("/work/notes.txt");
  assert.equal(fake.palette().get(SHOW), false);
  const img = await openImage();
  assert.equal(fake.palette().get(SHOW), false, "not on an image showing its image");
  await fake.key("+");
  await fake.key("b");
  await fake.advance(20);
  assert.equal(fake.palette().get(SHOW), true);
  await fake.activate(txt);
  assert.equal(fake.palette().get(SHOW), false);
  await fake.activate(img);
  assert.equal(fake.palette().get(SHOW), true);
  await fake.command(SHOW);
  await fake.advance(20);
  assert.equal(fake.groups().length, 1);
  assert.match(headerOf(), / fit /);
  assert.equal(fake.palette().get(SHOW), false);
});

test("the first row's padding is the editor background one unit off, and the theme name loses builtin:// (INV §8 P19)", async () => {
  fake.theme = "builtin://light";
  fake.themes.set("light", { editor: { bg: [255, 255, 255] } });
  await openImage();
  const img = imageOf()!;
  assert.deepEqual(img[0].inlineOverlays[0], { start: 0, end: 26, unit: "byte", style: { bg: [254, 255, 255] } });
  assert.deepEqual(img[1].inlineOverlays[0].style, { bg: "editor.bg" });
});

test("a user theme, saved as a path under the themes directory, gives its background (theme/loader.rs resolve_key)", async () => {
  fake.theme = "s-light.json";
  fake.themes.set(`file://${fake.themesDir}/s-light.json`, { editor: { bg: [250, 250, 250] } });
  await openImage();
  assert.deepEqual(imageOf()![0].inlineOverlays[0].style, { bg: [251, 250, 250] }, "not black");
});

test("a theme that leaves the background to the terminal: the first row is not nudged (theme/types.rs, INV §8 P19)", async () => {
  fake.theme = "builtin://terminal";
  fake.themes.set("terminal", { editor: { bg: "Default" } });
  await openImage();
  const img = imageOf()!;
  assert.deepEqual(img[0].inlineOverlays[0].style, { bg: "editor.bg" }, "no near-black band on the first row");
  assert.deepEqual(img[1].inlineOverlays[0].style, { bg: "editor.bg" });
});

test("a click in the view, and a new area, put the image panel's cursor back at byte 0 (INV §8 P25, A9)", async () => {
  const img = await openImage();
  const g = groupOf();
  const resets = () => fake.named("setBufferCursor").map((c) => [c.args, c.window]);
  const before = resets().length;
  await fake.click(g.panels.img);
  assert.deepEqual(resets().slice(before), [[[g.panels.img, 0], 1]]);
  await fake.click(null);
  const notes = await fake.open("/work/notes.txt");
  await fake.click(notes);
  assert.equal(resets().length, before + 1, "clicks elsewhere change nothing");
  await fake.activate(img);
  await fake.viewport(g.splits.img, 111, 40);
  assert.deepEqual(resets().at(-1), [[g.panels.img, 0], 1], "before the frame for the new area");
  const n = resets().length;
  await fake.viewport(g.splits.img, 111, 40);
  assert.equal(resets().length, n, "the same size again does nothing");
});

test("the cursor reset for an inactive window waits for it (INV §2)", async () => {
  fake.addWindow(2);
  await openImage();
  const g = groupOf(1);
  await fake.switchWindow(2);
  const before = fake.named("setBufferCursor").length;
  await fake.viewport(g.splits.img, 150, 50, 1);
  assert.equal(fake.named("setBufferCursor").length, before, "nothing runs in window 2");
  await fake.switchWindow(1);
  const c = fake.named("setBufferCursor").at(-1)!;
  assert.deepEqual([c.args, c.window], [[g.panels.img, 0], 1]);
});

// ---------------------------------------------------------------- review fixes

test("queued operations run only while their window is still active (INV §2)", async () => {
  fake.script = tools({ render: (c) => (c.window === 1 ? "hang" : undefined) });
  fake.addWindow(2);
  fake.addWindow(3);
  await openImage();
  await fake.switchWindow(2);
  await fake.advance(11_000);
  assert.equal(fake.groups(1).length, 1, "the close is queued for window 1");
  // The event names window 1, but window 3 is active by the time it lands.
  fake.setActive(3);
  await fake.emit("active_window_changed", { previous_id: 2, active_id: 1 });
  await fake.advance(20);
  assert.equal(fake.named("closeBufferGroup").length, 0, "nothing ran in window 3");
  assert.deepEqual(fake.statuses(3), []);
  await fake.switchWindow(1);
  await fake.advance(20);
  assert.equal(fake.groups(1).length, 0);
  assert.deepEqual(fake.statuses(1), ["quadrants.png: ffmpeg timed out after 10 s"]);
});

test("an operation run at once drops a stale queued one of the same kind (INV §2)", async () => {
  fake.addWindow(2);
  await openImage();
  const g = groupOf(1);
  await fake.switchWindow(2);
  await fake.viewport(g.splits.img, 150, 50, 1);
  const hdr = () => fake.named("setPanelContent").filter((c) => c.args[1] === "hdr" && c.window === 1).length;
  const before = hdr();
  fake.setActive(1);
  await fake.viewport(g.splits.img, 120, 45, 1);
  assert.equal(hdr(), before + 1, "the new header ran at once");
  await fake.emit("active_window_changed", { previous_id: 2, active_id: 1 });
  assert.equal(hdr(), before + 1, "the old queued header did not run after it");
  await fake.advance(20);
});

test("a zero size while the create is in flight is not taken as the area (INV §8 P17)", async () => {
  fake.createMs = 50;
  fake.autoViewport = null;
  await fake.open(QUAD);
  // Window 1's first group gets splits 1 (header) and 2 (image).
  await fake.viewport(2, 0, 0);
  await fake.advance(100);
  assert.equal(renders().length, 0, "no render for a 0×0 area");
  await fake.viewport(2, 199, 55);
  await fake.advance(20);
  assert.equal(renders().length, 1);
  assert.equal(imageOf()!.length, 55);
});

test("the post-check waits for the window, and a focus move does not close a group that landed right (INV §2, §8 P17)", async () => {
  fake.addWindow(2);
  fake.createMs = 50;
  const id = await fake.open(QUAD);
  await fake.switchWindow(2);
  fake.activeSplit = 7;
  await fake.advance(100);
  assert.equal(fake.groups(1).length, 1);
  assert.equal(fake.named("closeBufferGroup").length, 0, "nothing closed from window 2");
  await fake.switchWindow(1);
  await fake.advance(20);
  assert.equal(fake.groups(1).length, 1, "kept: it is in the file's tab");
  assert.equal(fake.named("closeBufferGroup").length, 0);
  assert.match(headerOf(1), /400×300/);
  assert.ok(id > 0);
});

test("Blocked trust mid-render in the tab's own window: the bytes, and the directory is still removed (R11, INV §7, §8 P31)", async () => {
  fake.script = tools({ renderMs: 100 });
  await fake.open(QUAD);
  await fake.advance(20);
  const out = renders()[0].args.at(-1)!;
  await fake.setTrust("blocked");
  await fake.advance(200);
  assert.equal(fake.groups().length, 0, "a refused read is a failure: the bytes");
  assert.deepEqual(fake.statuses(), [`quadrants.png: ${BLOCKED}`]);
  const reads = procsOf("sh").filter((p) => p.args[1].startsWith("base64"));
  assert.deepEqual(reads.map((p) => p.refused), [true]);
  assert.ok(!liveDirs().includes(dirOf(out)), "trust cannot refuse the editor's own removal");
});

test("a step refused by another window's Blocked trust runs again once the tab's window is active (R11, INV §7)", async () => {
  fake.script = tools({ renderMs: 100 });
  fake.addWindow(2);
  await fake.setTrust("blocked", 2);
  await fake.open(QUAD);
  await fake.advance(20);
  const first = renders()[0].args.at(-1)!;
  await fake.switchWindow(2);
  await fake.advance(200);
  const reads = () => procsOf("sh").filter((p) => p.args[1].startsWith("base64"));
  assert.deepEqual(reads().map((p) => [p.window, p.refused]), [[2, true]], "the read step was refused in window 2");
  assert.equal(fake.groups(1).length, 1, "window 1's view stays up");
  assert.deepEqual(fake.statuses(), [], "and nothing says Blocked");
  await fake.switchWindow(1);
  await fake.advance(200);
  assert.equal(renders().length, 2, "the render runs again in window 1");
  assert.notEqual(dirOf(renders()[1].args.at(-1)!), dirOf(first), "in a new directory: the refused run's went when it ended");
  assert.deepEqual(reads().map((p) => [p.window, p.refused]), [
    [2, true],
    [1, false],
  ]);
  assert.equal(imageOf(1)!.length, 55, "drawn");
  assert.deepEqual(liveDirs(), []);
});

test("a size probe refused by another window's trust runs again too, and the image opens (R11, INV §7)", async () => {
  const base = tools();
  fake.addWindow(2);
  await fake.setTrust("blocked", 2);
  fake.script = (c) => {
    // The user moves to window 2 as detection starts, so the size probe is
    // sent from there.
    if (c.program === "sh" && c.args[1].startsWith("for t in")) fake.setActive(2);
    return base(c);
  };
  await fake.open(QUAD);
  await fake.advance(100);
  assert.deepEqual(procsOf("ffmpeg").map((p) => [p.window, p.refused]), [[2, true]]);
  assert.equal(fake.statuses().length, 0);
  await fake.switchWindow(1);
  await fake.advance(200);
  assert.match(headerOf(1), /400×300/);
  assert.equal(imageOf(1)!.length, 55);
});

test("a refusal is judged by the window active when the step was spawned, not when it answered (R11, INV §7)", async () => {
  const base = tools();
  fake.addWindow(2);
  let probes = 0;
  fake.script = (c) => {
    if (c.program === "sh" && c.args[1].startsWith("for t in")) fake.setActive(2);
    if (c.program === "ffmpeg" && c.args.includes("showinfo") && probes++ === 0) {
      // Sent from window 2 and refused there; the user is back in window 1
      // by the time the answer comes.
      fake.setActive(1);
      return { code: -1, stdout: "", stderr: BLOCKED };
    }
    return base(c);
  };
  await fake.open(QUAD);
  await fake.advance(200);
  assert.deepEqual(fake.statuses(), [], "window 1's own trust refused nothing");
  assert.equal(probes, 2, "the probe ran again in window 1");
  // The switch's event, on its way meanwhile, lets the create's post-check run.
  await fake.switchWindow(1);
  await fake.advance(200);
  assert.match(headerOf(1), /400×300/);
  assert.equal(imageOf(1)!.length, 55);
});

test("a spawn whose result rejects shows the bytes and says why, not 'loading…' for good (R11)", async () => {
  const base = tools();
  fake.script = (c) => (c.program === "ffmpeg" && c.args.includes("showinfo") ? { reject: new Error("Async runtime not available") } : base(c));
  await openImage();
  assert.equal(fake.groups().length, 0);
  assert.deepEqual(fake.statuses(), ["quadrants.png: could not run the image tool (Async runtime not available)"]);
  assert.equal(fake.palette().get(SHOW), true);
});

test("a create still in flight when its window closes does not make another window keep stray sizes (INV §2)", async () => {
  fake.addWindow(2);
  fake.createMs = 50;
  await fake.switchWindow(2);
  await fake.open(QUAD);
  await fake.switchWindow(1);
  await fake.closeWindow(2);
  await fake.advance(100);
  fake.createMs = 0;
  fake.autoViewport = null;
  // Window 1's first group gets image split 2. A size for split 2 that comes
  // while no create is in flight in window 1 is not kept for it.
  await fake.viewport(2, 50, 20, 1);
  await fake.open(BIG);
  await fake.advance(20);
  assert.equal(groupOf(1).splits.img, 2);
  assert.equal(renders().length, 0, "no area yet, so no render at a stale size");
  await fake.viewport(2, 120, 40, 1);
  await fake.advance(20);
  assert.equal(imageOf(1)!.length, 40);
});

test("after a deadline kill the directory goes only once the killed step has exited, at most 1 s later (R11, INV §8 P21)", async () => {
  fake.script = tools({ render: () => "hang" });
  fake.killMs = 300;
  await openImage();
  const killAt = renders()[0].at + 10_000;
  const live = () => liveDirs().length;
  await advanceTo(killAt + 1);
  assert.deepEqual(fake.statuses(), ["quadrants.png: ffmpeg timed out after 10 s"], "the message does not wait");
  assert.equal(live(), 1);
  await advanceTo(killAt + 299);
  assert.equal(live(), 1);
  await fake.advance(2);
  assert.equal(live(), 0);
});

test("a killed step that never exits still gets its directory removed after 1 s (R11)", async () => {
  fake.script = tools({ render: () => "hang" });
  fake.killMs = 60_000;
  await openImage();
  const killAt = renders()[0].at + 10_000;
  const live = () => liveDirs().length;
  await advanceTo(killAt + 999);
  assert.equal(live(), 1);
  await fake.advance(2);
  assert.equal(live(), 0);
  await fake.advance(60_000);
});

test("one 10 s deadline for the whole plan, not one per step (R11)", async () => {
  // Each sips pass takes 6 s. The size probe ends at 6 s; the fit render is
  // two passes from 6 s, and the second is killed at 16 s, 10 s from the
  // plan's start, not at 22 s from its own.
  fake.script = tools({ tool: "sips", renderMs: 6_000 });
  await fake.open(QUAD);
  await fake.advance(15_990);
  assert.equal(fake.kills.length, 0);
  await fake.advance(20);
  assert.equal(fake.kills.length, 1);
  assert.equal(fake.kills[0].args[0], "-z", "the render's second pass");
  assert.match(fake.statuses()[0], /sips timed out after 10 s/);
});

// ---------------------------------------------------------------- cleanup-pass wiring

test("the tool and the size are probed while the create is in flight; the image follows the create (R1, R2)", async () => {
  fake.createMs = 50;
  await fake.open(QUAD);
  await fake.advance(10);
  assert.equal(fake.groups().length, 0, "the create has not landed");
  assert.ok(procsOf("ffmpeg").some((p) => p.args.includes("showinfo")), "but the size probe has run");
  assert.equal(renders().length, 0, "no render before the group and its area");
  await fake.advance(100);
  assert.equal(renders().length, 1);
  assert.match(headerOf(), /400×300  fit/);
  assert.equal(imageOf()!.length, 55);
});

test("a tab dropped while the sips size probe runs removes the probe's directory (R11)", async () => {
  fake.script = tools({ tool: "sips", renderMs: 100 });
  const id = await fake.open(QUAD);
  await fake.advance(50);
  await fake.closeTab(id);
  await fake.advance(500);
  assert.deepEqual(procsOf("sips").map((p) => p.args[0]), ["-s"], "no pass after the close");
  assert.deepEqual(fake.scratches().map((d) => d.live), [false], "the probe's directory, gone");
});

test("the theme is read once per frame (INV §8 P19)", async () => {
  await openImage();
  const per = () => fake.named("getConfig").length;
  assert.equal(per(), renders().length);
  await fake.key("+");
  await fake.advance(20);
  await fake.viewport(groupOf().splits.img, 100, 30);
  await fake.advance(20);
  assert.equal(per(), renders().length, "the shrink re-cut reuses the frame's colour");
});

test("a queued image op is cut to the area as it is when it runs (INV §2, §9.6)", async () => {
  fake.addWindow(2);
  fake.script = tools({ renderMs: 300 });
  await fake.open(QUAD);
  await fake.advance(20);
  await fake.switchWindow(2);
  await fake.advance(400);
  const g = groupOf(1);
  // The frame for 199×55 waits; then the area grows and shrinks again.
  await fake.viewport(g.splits.img, 150, 30, 1);
  await fake.switchWindow(1);
  const img = imageOf(1)!;
  assert.ok(img.length <= 30, `at most the area's rows: ${img.length}`);
  assert.ok(img.every((r) => Array.from(r.text.replace(/\n$/, "")).length <= 150));
  await fake.advance(1_000);
});
