// The image tools (R10, R11): which one is installed, what to run for an
// image's size and for a view's pixels, and the one-line reason a failure
// shows. Pure: argv lists only. The entry runs them with spawnHostProcess,
// each program directly, never under `sh -c`, so a kill reaches it (INV §8
// P21); only the last step, which reads the output, is a shell.

import { clip } from "./text.ts";
import type { Layout, Size } from "./view.ts";

export type Tool = "ffmpeg" | "magick" | "convert" | "sips";

export interface Step {
  program: string;
  args: string[];
}

/** A run's result (lib/runner.ts). `unanswered`: the tool never answered,
 *  because it timed out, the editor refused to run it, or a signal ended
 *  it; the reason then says which. `refused`: a step came back `exit_code
 *  -1` with a reason, as a refusal does (INV §8 P27); workspace trust is
 *  checked against the active window, so it may be another window's (INV
 *  §7); `window` is the one that was active when that step was spawned,
 *  when the runner knows it. After the tab's `alive()` turned false the
 *  result means nothing: callers check `alive()`. Here, not in runner.ts,
 *  so the two modules don't import each other: Fresh's bundler orders such
 *  a pair wrongly even when one side's import is type-only. */
export type RunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; reason: string; unanswered: boolean; refused: boolean; window?: number };

/** First found of ffmpeg, ImageMagick 7, ImageMagick 6, sips (spec Decisions). */
export const DETECT: Step = {
  program: "sh",
  args: ["-c", 'for t in ffmpeg magick convert sips; do command -v "$t" >/dev/null 2>&1 && { echo "$t"; exit 0; }; done; exit 1'],
};

const TOOLS: readonly Tool[] = ["ffmpeg", "magick", "convert", "sips"];

export function parseDetect(stdout: string): Tool | null {
  const t = stdout.trim();
  return (TOOLS as readonly string[]).includes(t) ? (t as Tool) : null;
}

/** The status message when no tool is found (R10). */
export const NO_TOOL = "no image tool found; install ffmpeg or ImageMagick (macOS has sips)";

/** What the detect run found: a tool, or why there is none to use. It
 *  exits 1 when nothing is installed (R10); a timeout or a refusal shows
 *  its own reason. */
export function classifyDetect(r: RunResult): Tool | { why: string } {
  if (!r.ok) return { why: r.unanswered ? r.reason : NO_TOOL };
  return parseDetect(r.stdout) ?? { why: NO_TOOL };
}

/** Why a window cannot run the viewer at all, or null (R11, INV §7). */
export function preflight(opts: { trust: string; remote: boolean }): string | null {
  if (opts.remote) return "remote window";
  if (opts.trust === "blocked") return "workspace trust is Blocked";
  return null;
}

/** A failure's reason: the first non-empty line of stderr, at most 80
 *  characters (R11). See `stepReason` for ffmpeg. */
export function reason(stderr: string, fallback = "the image tool failed"): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return clip(line ?? fallback, 80, "…");
}

const ERRORISH = /error|invalid|could not|cannot|failed|unable|not enough|no such|too big|unsupported|not on whitelist/i;

/** The reason a failed step gives. ffmpeg's size probe runs at `-v info`,
 *  so its first lines are the `Input #0` header; its errors are the lines
 *  tagged `[component @ …]` other than showinfo's, and the first of them
 *  that reads as an error is the reason (INV §8 P27, P29). A misnamed file's
 *  is the whitelist line, before the generic ones it causes (P30). */
export function stepReason(step: Step, stderr: string, fallback: string): string {
  if (step.program !== "ffmpeg") return reason(stderr, fallback);
  const tagged = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("[") && !l.startsWith("[Parsed_showinfo"));
  const line = tagged.find((l) => ERRORISH.test(l)) ?? tagged[0];
  return reason(line ?? stderr, fallback);
}

const extension = (path: string) => /\.([^./]*)$/.exec(path)?.[1].toLowerCase() ?? "";

/** The demuxers and decoders ffmpeg may use for each extension the viewer
 *  takes (lib/files.ts). image2 is always allowed: probing falls back to it,
 *  and it picks the decoder by extension. Animated WebP and APNG have their
 *  own demuxer and decoder, which read frame 1, and so does JPEG-LS in a
 *  `.jpg` (INV §8 P30). */
const FF_INPUT = new Map(
  Object.entries({
    png: ["png_pipe,apng,image2", "png,apng"],
    jpg: ["jpeg_pipe,jpeg_mpf,jpegls_pipe,image2", "mjpeg,jpegls"],
    jpeg: ["jpeg_pipe,jpeg_mpf,jpegls_pipe,image2", "mjpeg,jpegls"],
    gif: ["gif,gif_pipe,image2", "gif"],
    bmp: ["bmp_pipe,image2", "bmp"],
    webp: ["webp_pipe,webp_anim,image2", "webp,webp_anim"],
    tif: ["tiff_pipe,image2", "tiff"],
    tiff: ["tiff_pipe,image2", "tiff"],
  }),
);

/** ffmpeg's input options for `path`.
 *  - ffmpeg picks the demuxer, and with it the decoder, from the file's
 *    content, so a file's content would choose its decoder, as it would for
 *    ImageMagick (INV §8 P28). The whitelists keep both to the extension's
 *    own, and a misnamed file fails and shows its bytes (INV §8 P30).
 *    Forcing `-f image2` instead would lose animated WebP on ffmpeg 9.1.
 *  - A `%` makes the image2 demuxer read the name as a sequence pattern, so
 *    `frame%d.png` opens `frame1.png` when that exists. `-pattern_type none`
 *    stops it, but only with image2 forced, which cannot read GIF on ffmpeg
 *    8.1 (9.1 can), so a GIF gets its own demuxer, which works on both.
 *    Without a `%` the probing stays: `-pattern_type none` alone breaks PNG,
 *    GIF, WebP and BMP inputs (INV §8 P27, P29). */
export function ffmpegInput(path: string): string[] {
  const allowed = FF_INPUT.get(extension(path));
  const guard = allowed === undefined ? [] : ["-format_whitelist", allowed[0], "-codec_whitelist", allowed[1]];
  if (!path.includes("%")) return [...guard, "-i", path];
  return [...guard, ...(/\.gif$/i.test(path) ? ["-f", "gif"] : ["-f", "image2", "-pattern_type", "none"]), "-i", path];
}

/** ImageMagick's coder for each extension the viewer takes (lib/files.ts). */
const IM_CODERS = new Map([
  ["png", "png"],
  ["jpg", "jpeg"],
  ["jpeg", "jpeg"],
  ["gif", "gif"],
  ["bmp", "bmp"],
  ["webp", "webp"],
  ["tif", "tiff"],
  ["tiff", "tiff"],
]);

/** ImageMagick's name for the first frame of `path`: with a `[0]` scene a
 *  `%` is a format escape, and `%%` is a literal `%` (INV §8 P27). The
 *  extension's coder comes first (`png:`): without it ImageMagick reads the
 *  file's first bytes and uses whatever coder they match, delegates such as
 *  Ghostscript included, so a file's content would choose its decoder
 *  (INV §8 P28; MagickCore `SetImageInfo` skips that check for a known
 *  format). A misnamed file then fails, and shows its bytes. */
export function imInput(path: string): string {
  const name = `${path.split("%").join("%%")}[0]`;
  const coder = IM_CODERS.get(extension(path));
  return coder === undefined ? name : `${coder}:${name}`;
}

/** What the runner runs (lib/runner.ts): converter steps, each killable,
 *  then, with `final`, a read step that base64-encodes that file. */
export interface Plan {
  steps: Step[];
  final: string | null;
}

/** The directory a plan writes its files in. The runner makes it on the
 *  first call, a new one per run, and removes it when the run ends (R11,
 *  INV §8 P31); a plan that writes nothing never calls it. */
export type Dir = () => string;

export interface SizePlan extends Plan {
  /** The size from the last step's output, or null. */
  parse(stdout: string, stderr: string): Size | null;
}

const size = (w: number, h: number): Size | null => (w > 0 && h > 0 && Number.isInteger(w) && Number.isInteger(h) ? { w, h } : null);

/** The image's oriented size, once per open (INV §8 P22, P23, P29). */
export function planSize(tool: Tool, path: string, dir: Dir): SizePlan {
  if (tool === "ffmpeg") {
    return {
      steps: [{ program: "ffmpeg", args: ["-nostdin", "-hide_banner", "-v", "info", ...ffmpegInput(path), "-frames:v", "1", "-vf", "showinfo", "-f", "null", "-"] }],
      final: null,
      parse: (_out, err) => {
        const line = err.split("\n").find((l) => l.includes("showinfo") && / s:\d+x\d+/.test(l));
        const m = line === undefined ? null : / s:(\d+)x(\d+)/.exec(line);
        return m ? size(Number(m[1]), Number(m[2])) : null;
      },
    };
  }
  if (tool === "sips") {
    const t0 = `${dir()}/0.bmp`;
    return {
      steps: [
        { program: "sips", args: ["-s", "format", "bmp", path, "--out", t0] },
        { program: "sips", args: ["-g", "pixelWidth", "-g", "pixelHeight", t0] },
      ],
      final: null,
      parse: (out) => size(Number(/pixelWidth: (\d+)/.exec(out)?.[1]), Number(/pixelHeight: (\d+)/.exec(out)?.[1])),
    };
  }
  return {
    steps: [{ program: tool, args: [imInput(path), "-auto-orient", "-format", "%w %h", "info:"] }],
    final: null,
    parse: (out) => {
      const m = /^\s*(\d+) (\d+)\s*$/.exec(out);
      return m ? size(Number(m[1]), Number(m[2])) : null;
    },
  };
}

export interface RenderPlan extends Plan {
  /** The file the read step base64-encodes. */
  final: string;
  format: "pam" | "bmp";
}

/** The steps that write the pixels `layout` asks for (R2, R4, R5). */
export function planRender(tool: Tool, path: string, src: Size, layout: Layout, dir: Dir): RenderPlan {
  const { crop, out, s } = layout;
  if (tool === "ffmpeg") {
    // exact=1: without it a crop of 4:2:0 input is rounded to even sizes
    // and offsets (INV §8 P25). Below 100%, a format that can carry alpha is
    // scaled premultiplied: swscale averages colour and alpha apart, so a
    // transparent pixel's hidden colour bleeds into the edge (R2). In 16
    // bits, as 8-bit premultiplying turns opaque 255s into 254s. JPEG has no
    // alpha and keeps the cheaper chain (INV §8 P33).
    const ext = extension(path);
    const alpha = ext !== "jpg" && ext !== "jpeg";
    const area = `scale=${out.w}:${out.h}:flags=area`;
    const scale = s >= 1 ? "" : alpha ? `,format=gbrap16le,premultiply=inplace=1,${area},unpremultiply=inplace=1` : `,${area}`;
    const final = `${dir()}/0.pam`;
    const vf = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}:exact=1${scale},format=rgba`;
    return {
      steps: [{ program: "ffmpeg", args: ["-nostdin", "-v", "error", ...ffmpegInput(path), "-frames:v", "1", "-vf", vf, "-c:v", "pam", "-f", "image2", "-update", "1", "-y", final] }],
      final,
      format: "pam",
    };
  }
  if (tool === "magick" || tool === "convert") {
    const final = `${dir()}/0.pam`;
    const resize = s < 1 ? ["-filter", "Box", "-resize", `${out.w}x${out.h}!`] : [];
    return {
      steps: [
        {
          program: tool,
          // +repage first: a page offset (a PNG's oFFs) would shift the
          // crop, and leave the output blank (INV §8 P27). ImageMagick
          // expands `%` in an output name too, so each is doubled (P31).
          args: [imInput(path), "+repage", "-auto-orient", "-crop", `${crop.w}x${crop.h}+${crop.x}+${crop.y}`, "+repage", ...resize, "-type", "TrueColorAlpha", "-depth", "8", `pam:${final.split("%").join("%%")}`],
        },
      ],
      final,
      format: "pam",
    };
  }
  // sips: one operation a pass, as its order inside a pass is fixed and
  // undocumented. Convert (which orients), resample the whole image below
  // 100%, then pad by a pixel and crop at (y+1, x+1): a crop at 0 0 is
  // centred, and one at column 0 reaching the bottom edge is ignored (INV
  // §8 P22, spec Decisions).
  const d = dir();
  const steps: Step[] = [];
  let k = 0;
  const next = () => `${d}/${k++}.bmp`;
  let cur = next();
  steps.push({ program: "sips", args: ["-s", "format", "bmp", path, "--out", cur] });
  let full: Size = src;
  let rect = { ...crop };
  if (s < 1) {
    full = { w: Math.max(1, Math.round(src.w * s)), h: Math.max(1, Math.round(src.h * s)) };
    const w = Math.min(out.w, full.w);
    const h = Math.min(out.h, full.h);
    rect = { x: Math.min(Math.round(crop.x * s), full.w - w), y: Math.min(Math.round(crop.y * s), full.h - h), w, h };
    const t = next();
    steps.push({ program: "sips", args: ["-z", String(full.h), String(full.w), cur, "--out", t] });
    cur = t;
  }
  if (rect.w !== full.w || rect.h !== full.h) {
    const padded = next();
    steps.push({ program: "sips", args: ["-p", String(full.h + 2), String(full.w + 2), cur, "--out", padded] });
    const cut = next();
    steps.push({ program: "sips", args: ["-c", String(rect.h), String(rect.w), "--cropOffset", String(rect.y + 1), String(rect.x + 1), padded, "--out", cut] });
    cur = cut;
  }
  return { steps, final: cur, format: "bmp" };
}

/** Makes a directory private (0700). The editor makes its staging
 *  directories with the umask's modes, which on a Mac let the user's group
 *  read a crop of a private image (INV §8 P31). */
export function privateStep(dir: string): Step {
  return { program: "chmod", args: ["700", dir] };
}

/** The read step: the output as base64, in a shell that is never killed.
 *  The runner removes the plan's directory after it (R11). */
export function readStep(final: string): Step {
  return { program: "sh", args: ["-c", 'base64 < "$1"', "sh", final] };
}
