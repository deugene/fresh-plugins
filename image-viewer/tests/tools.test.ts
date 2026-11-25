import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseName, isImage } from "../lib/files.ts";
import { classifyDetect, DETECT, ffmpegInput, imInput, NO_TOOL, parseDetect, planRender, planSize, preflight, readStep, reason, stepReason } from "../lib/tools.ts";
import { fitView, layout, type Area, type View } from "../lib/view.ts";
import { base64ToBytes, parseBmp, parsePam, type Image } from "../lib/decode.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const A6: Area = { cols: 199, rows: 55 };
const BIG = { w: 4000, h: 3000 };
const F = "/w/big.jpg";
/** The run's directory, as the runner gives it (lib/runner.ts). */
const T = "/cfg/.staging/image-viewer-3";
const D = () => T;
/** For plans that must not ask for a directory: they write nothing. */
const NONE = (): string => assert.fail("asked for a directory");
/** ffmpeg's limits for a JPEG (INV §8 P30). */
const JPEG_ONLY = ["-format_whitelist", "jpeg_pipe,jpeg_mpf,jpegls_pipe,image2", "-codec_whitelist", "mjpeg,jpegls"];

test("isImage: the R1 extensions in any case; not .svg, .txt or a panel's empty path (A3)", () => {
  for (const p of ["/a/b.png", "/a/b.PNG", "/a/QUADRANTS.PNG", "/x.jpg", "/x.JPEG", "/x.gif", "/x.bmp", "/x.webp", "/x.tif", "/x.TIFF"]) assert.ok(isImage(p), p);
  for (const p of ["", "/a/logo.svg", "/a/notes.txt", "/a/png", "/a/b.png.txt", "/a/b.pngx"]) assert.ok(!isImage(p), p);
  assert.equal(baseName("/private/tmp/w/quadrants.png"), "quadrants.png");
});

test("detect: one shell probe in the Decisions order, and its parsing (R10)", () => {
  assert.equal(DETECT.program, "sh");
  assert.match(DETECT.args[1], /for t in ffmpeg magick convert sips;/);
  assert.equal(parseDetect("ffmpeg\n"), "ffmpeg");
  assert.equal(parseDetect("convert\n"), "convert");
  assert.equal(parseDetect("gimp\n"), null);
  assert.match(NO_TOOL, /ffmpeg/);
  assert.match(NO_TOOL, /ImageMagick/);
  assert.match(NO_TOOL, /sips/);
});

test("classifyDetect: exit 1 is no tool; a timeout or a refusal shows its reason (R10, R11)", () => {
  assert.equal(classifyDetect({ ok: true, stdout: "sips\n", stderr: "" }), "sips");
  assert.deepEqual(classifyDetect({ ok: true, stdout: "gimp\n", stderr: "" }), { why: NO_TOOL });
  assert.deepEqual(classifyDetect({ ok: false, reason: "sh exited with 1", unanswered: false, refused: false }), { why: NO_TOOL });
  assert.deepEqual(classifyDetect({ ok: false, reason: "sh timed out after 10 s", unanswered: true, refused: false }), { why: "sh timed out after 10 s" });
  assert.deepEqual(classifyDetect({ ok: false, reason: "workspace trust is set to Blocked — no processes may run", unanswered: true, refused: true }), {
    why: "workspace trust is set to Blocked — no processes may run",
  });
});

test("preflight: remote windows and Blocked trust (R11, INV §7)", () => {
  assert.equal(preflight({ trust: "trusted", remote: false }), null);
  assert.equal(preflight({ trust: "restricted", remote: false }), null, "bare tool names run under Restricted (INV §7)");
  assert.equal(preflight({ trust: "blocked", remote: false }), "workspace trust is Blocked");
  assert.equal(preflight({ trust: "trusted", remote: true }), "remote window");
});

test("reason: the first non-empty line, at most 80 characters (R11)", () => {
  assert.match(reason(fixture("corrupt.showinfo.txt")), /^\[png @ 0x[0-9a-f]+\] Invalid PNG signature/);
  assert.equal(reason("\n\n  boom  \nmore"), "boom");
  assert.equal(reason(""), "the image tool failed");
  assert.equal(Array.from(reason("x".repeat(200))).length, 80);
});

test("size probes: ffmpeg showinfo gives the oriented size, and writes no file (INV §8 P29)", () => {
  const p = planSize("ffmpeg", F, NONE);
  assert.deepEqual(p.steps, [{ program: "ffmpeg", args: ["-nostdin", "-hide_banner", "-v", "info", ...JPEG_ONLY, "-i", F, "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"] }]);
  assert.equal(p.final, null);
  assert.deepEqual(p.parse("", fixture("o6.showinfo.txt")), { w: 300, h: 400 });
  assert.deepEqual(p.parse("", fixture("quadrants.showinfo.txt")), { w: 400, h: 300 });
  assert.equal(p.parse("", fixture("corrupt.showinfo.txt")), null);
});

test("size probes: ImageMagick 7 and 6, which write no file, and sips, which does (P22, P23)", () => {
  const m = planSize("magick", F, NONE);
  assert.deepEqual(m.steps, [{ program: "magick", args: [`jpeg:${F}[0]`, "-auto-orient", "-format", "%w %h", "info:"] }]);
  assert.deepEqual(m.parse("3000 4000", ""), { w: 3000, h: 4000 });
  assert.equal(m.parse("garbage", ""), null);
  assert.equal(planSize("convert", F, NONE).steps[0].program, "convert");
  const s = planSize("sips", F, D);
  assert.deepEqual(s.steps, [
    { program: "sips", args: ["-s", "format", "bmp", F, "--out", `${T}/0.bmp`] },
    { program: "sips", args: ["-g", "pixelWidth", "-g", "pixelHeight", `${T}/0.bmp`] },
  ]);
  assert.deepEqual(s.parse(`/x\n${fixture("quadrants.sips-size.txt")}`, ""), { w: 400, h: 300 });
});

const scaled: View = { scale: 0.0625, centre: { x: 2000, y: 1500 } };
const oneToOne: View = { scale: 2, centre: { x: 2000, y: 1500 } };

test("ffmpeg render: crop with exact=1, scaled below 100%, 1:1 above (INV §8 P25)", () => {
  const fit = planRender("ffmpeg", F, BIG, layout(BIG, A6, fitView(BIG)), D);
  assert.deepEqual(fit.steps, [
    { program: "ffmpeg", args: ["-nostdin", "-v", "error", ...JPEG_ONLY, "-i", F, "-frames:v", "1", "-vf", "crop=4000:3000:0:0:exact=1,scale=147:110:flags=area,format=rgba", "-c:v", "pam", "-f", "image2", "-update", "1", "-y", `${T}/0.pam`] },
  ]);
  assert.deepEqual([fit.final, fit.format], [`${T}/0.pam`, "pam"]);
  const z = planRender("ffmpeg", F, BIG, layout(BIG, A6, oneToOne), D);
  const l = layout(BIG, A6, oneToOne);
  assert.equal(z.steps[0].args[12], `crop=${l.crop.w}:${l.crop.h}:${l.crop.x}:${l.crop.y}:exact=1,format=rgba`);
});

test("ffmpeg render: a format that can carry alpha is scaled premultiplied, in 16 bits; JPEG is not; 1:1 needs neither (R2, INV §8 P33)", () => {
  const vf = (path: string, view: View) => {
    const args = planRender("ffmpeg", path, BIG, layout(BIG, A6, view), D).steps[0].args;
    return args[args.indexOf("-vf") + 1];
  };
  for (const ext of ["png", "PNG", "gif", "webp", "bmp", "tif", "tiff"]) {
    assert.equal(vf(`/w/a.${ext}`, fitView(BIG)), "crop=4000:3000:0:0:exact=1,format=gbrap16le,premultiply=inplace=1,scale=147:110:flags=area,unpremultiply=inplace=1,format=rgba", ext);
  }
  for (const ext of ["jpg", "jpeg", "JPG"]) assert.equal(vf(`/w/a.${ext}`, fitView(BIG)), "crop=4000:3000:0:0:exact=1,scale=147:110:flags=area,format=rgba", ext);
  assert.doesNotMatch(vf("/w/a.png", oneToOne), /premultiply|scale=/, "nothing is resampled at or above 100%");
});

test("ImageMagick render: -auto-orient, crop, Box resize below 100%, TrueColorAlpha PAM (INV §8 P23)", () => {
  const l = layout(BIG, A6, scaled);
  const m = planRender("magick", F, BIG, l, D);
  assert.deepEqual(m.steps, [
    {
      program: "magick",
      args: [`jpeg:${F}[0]`, "+repage", "-auto-orient", "-crop", `${l.crop.w}x${l.crop.h}+${l.crop.x}+${l.crop.y}`, "+repage", "-filter", "Box", "-resize", "199x110!", "-type", "TrueColorAlpha", "-depth", "8", `pam:${T}/0.pam`],
    },
  ]);
  const c = planRender("convert", F, BIG, layout(BIG, A6, oneToOne), D);
  assert.equal(c.steps[0].program, "convert");
  assert.ok(!c.steps[0].args.includes("-resize"));
  assert.equal(c.final, `${T}/0.pam`);
  // ImageMagick expands % in an output name too (INV §8 P31).
  const pct = planRender("magick", F, BIG, l, () => "/cfg/100%/s");
  assert.deepEqual([pct.steps[0].args.at(-1), pct.final], ["pam:/cfg/100%%/s/0.pam", "/cfg/100%/s/0.pam"]);
});

test("a page offset is dropped before ImageMagick crops (INV §8 P27)", () => {
  const args = planRender("magick", F, BIG, layout(BIG, A6, fitView(BIG)), D).steps[0].args;
  assert.deepEqual(args.slice(0, 3), [`jpeg:${F}[0]`, "+repage", "-auto-orient"]);
});

const PNG_ONLY = ["-format_whitelist", "png_pipe,apng,image2", "-codec_whitelist", "png,apng"];

test("a % in the path: ffmpeg reads the literal file, ImageMagick gets %% (INV §8 P27)", () => {
  assert.deepEqual(ffmpegInput("/w/a.png"), [...PNG_ONLY, "-i", "/w/a.png"], "no % keeps the probing, limited");
  assert.deepEqual(ffmpegInput("/w/frame%03d.png"), [...PNG_ONLY, "-f", "image2", "-pattern_type", "none", "-i", "/w/frame%03d.png"]);
  assert.deepEqual(ffmpegInput("/w/frame%03d.JPG"), [...JPEG_ONLY, "-f", "image2", "-pattern_type", "none", "-i", "/w/frame%03d.JPG"]);
  assert.deepEqual(ffmpegInput("/w/a%d.GIF"), ["-format_whitelist", "gif,gif_pipe,image2", "-codec_whitelist", "gif", "-f", "gif", "-i", "/w/a%d.GIF"], "image2 cannot read GIF on 8.1");
  assert.equal(imInput("/w/100%.png"), "png:/w/100%%.png[0]");
  assert.equal(imInput("/w/f%%d.png"), "png:/w/f%%%%d.png[0]");
  const size = planSize("ffmpeg", "/w/f%d.png", NONE).steps[0].args;
  assert.deepEqual(size.slice(4, 13), [...PNG_ONLY, "-f", "image2", "-pattern_type", "none", "-i"]);
  const render = planRender("ffmpeg", "/w/f%d.png", BIG, layout(BIG, A6, fitView(BIG)), D).steps[0].args;
  assert.deepEqual(render.slice(3, 12), [...PNG_ONLY, "-f", "image2", "-pattern_type", "none", "-i"]);
  assert.equal(planSize("magick", "/w/f%d.png", NONE).steps[0].args[0], "png:/w/f%%d.png[0]");
  assert.equal(planRender("convert", "/w/f%d.png", BIG, layout(BIG, A6, fitView(BIG)), D).steps[0].args[0], "png:/w/f%%d.png[0]");
});

test("ffmpeg may use only the extension's demuxers and decoders, so the content cannot pick others (INV §8 P30)", () => {
  const cases: [string, string, string][] = [
    ["/w/a.png", "png_pipe,apng,image2", "png,apng"],
    ["/w/a.JPG", "jpeg_pipe,jpeg_mpf,jpegls_pipe,image2", "mjpeg,jpegls"],
    ["/w/a.jpeg", "jpeg_pipe,jpeg_mpf,jpegls_pipe,image2", "mjpeg,jpegls"],
    ["/w/a.Gif", "gif,gif_pipe,image2", "gif"],
    ["/w/a.bmp", "bmp_pipe,image2", "bmp"],
    ["/w/a.webp", "webp_pipe,webp_anim,image2", "webp,webp_anim"],
    ["/w/a.tif", "tiff_pipe,image2", "tiff"],
    ["/w/a.TIFF", "tiff_pipe,image2", "tiff"],
  ];
  for (const [path, formats, codecs] of cases) assert.deepEqual(ffmpegInput(path), ["-format_whitelist", formats, "-codec_whitelist", codecs, "-i", path], path);
  for (const ext of ["png", "PNG", "jpg", "JPEG", "gif", "bmp", "webp", "tif", "TIFF"]) {
    assert.ok(isImage(`/x.${ext}`), ext);
    assert.equal(ffmpegInput(`/x.${ext}`)[0], "-format_whitelist", `every extension isImage takes is limited: ${ext}`);
  }
});

test("ImageMagick reads with the extension's coder, so the content cannot pick another (INV §8 P28)", () => {
  const cases: [string, string][] = [
    ["/w/a.png", "png:/w/a.png[0]"],
    ["/w/a.JPG", "jpeg:/w/a.JPG[0]"],
    ["/w/a.jpeg", "jpeg:/w/a.jpeg[0]"],
    ["/w/a.gif", "gif:/w/a.gif[0]"],
    ["/w/a.bmp", "bmp:/w/a.bmp[0]"],
    ["/w/a.webp", "webp:/w/a.webp[0]"],
    ["/w/a.tif", "tiff:/w/a.tif[0]"],
    ["/w/a.TIFF", "tiff:/w/a.TIFF[0]"],
    ["/w/x:y/a.png", "png:/w/x:y/a.png[0]"],
  ];
  for (const [path, want] of cases) assert.equal(imInput(path), want, path);
  for (const ext of ["png", "PNG", "jpg", "JPEG", "gif", "bmp", "webp", "tif", "TIFF"]) {
    assert.ok(isImage(`/x.${ext}`), ext);
    assert.match(imInput(`/x.${ext}`), /^[a-z]+:\/x\./, `every extension isImage takes has a coder: ${ext}`);
  }
});

test("stepReason: ffmpeg's real error line, after the Input #0 header (R11, INV §8 P27)", () => {
  const ff = { program: "ffmpeg", args: [] };
  const t = fixture("truncated.showinfo.txt");
  assert.match(t.split("\n")[0], /^Input #0/);
  assert.match(stepReason(ff, t, "x"), /^\[vist#0:0\/gif @ 0x0\] \[dec:gif @ 0x0\] Error submitting packet to decoder/);
  assert.match(stepReason(ff, fixture("corrupt.showinfo.txt"), "x"), /Invalid PNG signature/);
  // A misnamed file: the whitelist line, not the generic errors it causes (INV §8 P30).
  assert.match(stepReason(ff, fixture("mis.showinfo.txt"), "x"), /^\[mjpeg @ 0x0\] Codec \(mjpeg\) not on whitelist 'png,apng'$/);
  assert.match(stepReason(ff, fixture("ppm.showinfo.txt"), "x"), /^\[in#0 @ 0x0\] Format not on whitelist 'png_pipe,apng,image2'$/);
  assert.equal(stepReason(ff, "", "fallback"), "fallback");
  assert.equal(stepReason({ program: "sips", args: [] }, "Input #0 first\nmore", "x"), "Input #0 first");
});

test("sips render: convert, resample, pad, crop at (y+1, x+1); every pass in the run's directory (INV §8 P22)", () => {
  const fit = planRender("sips", F, BIG, layout(BIG, A6, fitView(BIG)), D);
  assert.deepEqual(fit.steps, [
    { program: "sips", args: ["-s", "format", "bmp", F, "--out", `${T}/0.bmp`] },
    { program: "sips", args: ["-z", "110", "147", `${T}/0.bmp`, "--out", `${T}/1.bmp`] },
  ]);
  assert.deepEqual([fit.final, fit.format], [`${T}/1.bmp`, "bmp"]);
  const l = layout(BIG, A6, scaled);
  const z = planRender("sips", F, BIG, l, D);
  assert.deepEqual(z.steps.slice(1), [
    { program: "sips", args: ["-z", "188", "250", `${T}/0.bmp`, "--out", `${T}/1.bmp`] },
    { program: "sips", args: ["-p", "190", "252", `${T}/1.bmp`, "--out", `${T}/2.bmp`] },
    { program: "sips", args: ["-c", "110", "199", "--cropOffset", String(Math.round(l.crop.y * 0.0625) + 1), String(Math.round(l.crop.x * 0.0625) + 1), `${T}/2.bmp`, "--out", `${T}/3.bmp`] },
  ]);
  // At the origin, 1:1: no flip any more, the pad shifts the offset to 1 1.
  const o = planRender("sips", F, BIG, layout(BIG, A6, { scale: 1, centre: { x: 0, y: 0 } }), D);
  assert.deepEqual(o.steps.slice(1), [
    { program: "sips", args: ["-p", "3002", "4002", `${T}/0.bmp`, "--out", `${T}/1.bmp`] },
    { program: "sips", args: ["-c", "110", "199", "--cropOffset", "1", "1", `${T}/1.bmp`, "--out", `${T}/2.bmp`] },
  ]);
  assert.ok(!o.steps.some((s) => s.args.includes("-f")), "no flip pass");
});

test("the read step only base64-encodes the output: the runner removes the directory (R11)", () => {
  assert.deepEqual(readStep("/s/2.bmp"), { program: "sh", args: ["-c", 'base64 < "$1"', "sh", "/s/2.bmp"] });
});

// End to end, with the tools installed here: the planned argv on an image
// whose pixel (x, y) is (x, y, 128) gives exactly the pixels asked for.
const has = (t: string) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0;
const GRAD = { w: 200, h: 150 };

/** One render, in a directory of its own, as the runner gives each run. */
function runPlan(tool: "ffmpeg" | "sips", file: string, area: Area, view: View, parent: string): { img: Image; l: ReturnType<typeof layout> } {
  const l = layout(GRAD, area, view);
  const plan = planRender(tool, file, GRAD, l, () => mkdtempSync(join(parent, "run-")));
  for (const s of plan.steps) execFileSync(s.program, s.args, { stdio: "ignore" });
  const r = readStep(plan.final);
  const out = execFileSync(r.program, r.args, { encoding: "utf8" });
  const bytes = base64ToBytes(out);
  return { img: plan.format === "pam" ? parsePam(bytes) : parseBmp(bytes), l };
}

for (const tool of ["ffmpeg", "sips"] as const) {
  test(`end to end with ${tool}: crops at the origin, both edges and the middle are exact`, { skip: !has(tool) || !has("ffmpeg") }, () => {
    const dir = mkdtempSync(join(tmpdir(), "iv-tools-"));
    try {
      const file = join(dir, "grad.png");
      execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "nullsrc=s=200x150,geq=r='X':g='Y':b='128'", "-frames:v", "1", "-y", file]);
      const area: Area = { cols: 50, rows: 20 };
      const views: View[] = [
        { scale: 1, centre: { x: 0, y: 0 } },
        { scale: 1, centre: { x: 0, y: 150 } },
        { scale: 1, centre: { x: 200, y: 0 } },
        { scale: 1, centre: { x: 200, y: 150 } },
        { scale: 2, centre: { x: 100, y: 75 } },
      ];
      views.forEach((v) => {
        const { img, l } = runPlan(tool, file, area, v, dir);
        assert.deepEqual([img.w, img.h], [l.crop.w, l.crop.h], JSON.stringify(v));
        const at = (x: number, y: number) => Array.from(img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 3));
        assert.deepEqual(at(0, 0), [l.crop.x, l.crop.y, 128], JSON.stringify(v));
        assert.deepEqual(at(img.w - 1, img.h - 1), [l.crop.x + l.crop.w - 1, l.crop.y + l.crop.h - 1, 128], JSON.stringify(v));
      });
      const { img, l } = runPlan(tool, file, area, { scale: 0.5, centre: { x: 100, y: 75 } }, dir);
      assert.deepEqual([img.w, img.h], [l.out.w, l.out.h]);
      // A % in the name, with a file the pattern would match beside it.
      const pct = join(dir, "frame%d.png");
      execFileSync("cp", [file, pct]);
      execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=blue:s=16x16", "-frames:v", "1", "-y", "-update", "1", join(dir, "frame1.png")]);
      const size = planSize(tool, pct, () => mkdtempSync(join(dir, "run-")));
      let out = "";
      let err = "";
      for (const s of size.steps) {
        const r = spawnSync(s.program, s.args, { encoding: "utf8" });
        out = r.stdout;
        err = r.stderr;
      }
      assert.deepEqual(size.parse(out, err), GRAD, "the literal file's size");
      const p = runPlan(tool, pct, area, { scale: 1, centre: { x: 0, y: 0 } }, dir);
      assert.deepEqual(Array.from(p.img.rgba.subarray(0, 3)), [0, 0, 128], "the literal file's pixels");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("end to end with ffmpeg: a scaled transparent edge keeps its colour, with none of the transparent pixels' hidden one (R2, INV §8 P33)", { skip: !has("ffmpeg") }, () => {
  const dir = mkdtempSync(join(tmpdir(), "iv-tools-"));
  try {
    // Opaque magenta, then fully transparent pixels whose colour is green.
    const file = join(dir, "edge.png");
    const left = "lt(X,100)";
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", `nullsrc=s=200x10,format=rgba,geq=r='if(${left},255,0)':g='if(${left},0,255)':b='if(${left},255,0)':a='if(${left},255,0)'`, "-frames:v", "1", "-pix_fmt", "rgba", "-y", file]);
    const src = { w: 200, h: 10 };
    // 29 columns: the edge, at 14.5, falls inside output column 14.
    const l = layout(src, { cols: 29, rows: 5 }, fitView(src));
    const plan = planRender("ffmpeg", file, src, l, () => mkdtempSync(join(dir, "run-")));
    for (const s of plan.steps) execFileSync(s.program, s.args, { stdio: "ignore" });
    const r = readStep(plan.final);
    const img = parsePam(base64ToBytes(execFileSync(r.program, r.args, { encoding: "utf8" })));
    assert.equal(img.w, 29);
    const edge: number[][] = [];
    for (let x = 0; x < img.w; x++) {
      const [red, green, blue, a] = Array.from(img.rgba.subarray(x * 4, x * 4 + 4));
      if (a > 0 && a < 255) edge.push([red, green, blue, a]);
      if (a > 0) assert.ok(green <= 2 && red >= 250 && blue >= 250, `column ${x}: ${[red, green, blue, a]}`);
    }
    assert.equal(edge.length, 1, `one partly transparent column at the edge: ${JSON.stringify(edge)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
