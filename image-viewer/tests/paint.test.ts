import { test } from "node:test";
import assert from "node:assert/strict";
import { cells, compose, fitCanvas, header, KEYS, loadingHeader, nudge, TERMINAL_BG, themeBg, themeKey, type Canvas, type Entry, type Rgb } from "../lib/paint.ts";
import { clip } from "../lib/text.ts";
import { fitView, layout, type Area } from "../lib/view.ts";
import type { Image } from "../lib/decode.ts";

const BG: Rgb = [10, 20, 30];

/** An image whose pixel (x, y) is `f(x, y)` as [r,g,b,a]. */
function image(w: number, h: number, f: (x: number, y: number) => number[]): Image {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(f(x, y), (y * w + x) * 4);
  return { w, h, rgba };
}

/** The cell at (col, row) of the entries: its char and its overlay's style. */
function cell(entries: Entry[], col: number, row: number): { ch: string; fg?: unknown; bg?: unknown } {
  const e = entries[row];
  const chars = Array.from(e.text.replace(/\n$/, ""));
  let bytes = 0;
  for (let i = 0; i < col; i++) bytes += chars[i] === "▀" || chars[i] === "▄" ? 3 : 1;
  const o = e.inlineOverlays.find((x) => x.start <= bytes && bytes < x.end);
  return { ch: chars[col], fg: o?.style.fg, bg: o?.style.bg };
}

const quadrants = (w: number, h: number) =>
  image(w, h, (x, y) => (y < h / 2 ? (x < w / 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]) : x < w / 2 ? [0, 0, 255, 255] : [255, 255, 255, 255]));

test("corner colours at fit: top-left upper half red, bottom-right lower half white (A4)", () => {
  const area: Area = { cols: 20, rows: 5 };
  const src = { w: 20, h: 10 };
  const l = layout(src, area, fitView(src));
  const e = cells(compose(quadrants(20, 10), l, BG));
  assert.equal(e.length, 5);
  assert.deepEqual(cell(e, 0, 0), { ch: "▀", fg: [255, 0, 0], bg: [255, 0, 0] });
  assert.deepEqual(cell(e, 19, 4), { ch: "▀", fg: [255, 255, 255], bg: [255, 255, 255] });
  assert.deepEqual(cell(e, 19, 0).fg, [0, 255, 0]);
  assert.deepEqual(cell(e, 0, 4).bg, [0, 0, 255]);
});

test("padding runs on both sides, in editor.bg, one overlay per run (R2, INV §8 P19)", () => {
  const area: Area = { cols: 10, rows: 3 };
  const src = { w: 4, h: 6 };
  const l = layout(src, area, fitView(src));
  const e = cells(compose(quadrants(4, 6), l, BG));
  const row = e[1];
  assert.equal(row.text, "   ▀▀▀▀   \n");
  assert.deepEqual(row.inlineOverlays[0], { start: 0, end: 3, unit: "byte", style: { bg: "editor.bg" } });
  assert.deepEqual(row.inlineOverlays.at(-1), { start: 15, end: 18, unit: "byte", style: { bg: "editor.bg" } });
  assert.equal(row.inlineOverlays.length, 6);
});

test("the first row: a colour equal to editor.bg is drawn one unit off, padding and image alike (INV §8 P19)", () => {
  const area: Area = { cols: 6, rows: 2 };
  const src = { w: 2, h: 4 };
  const img = image(2, 4, (x) => (x === 0 ? [...BG, 255] : [200, 0, 0, 255]));
  const e = cells(compose(img, layout(src, area, fitView(src)), BG));
  assert.deepEqual(nudge(BG), [11, 20, 30]);
  assert.deepEqual(nudge([255, 1, 2]), [254, 1, 2]);
  assert.deepEqual(e[0].inlineOverlays[0], { start: 0, end: 2, unit: "byte", style: { bg: [11, 20, 30] } });
  assert.deepEqual(cell(e, 2, 0), { ch: "▀", fg: [11, 20, 30], bg: [11, 20, 30] });
  assert.deepEqual(cell(e, 3, 0).fg, [200, 0, 0]);
  // Other rows keep the theme key and the exact colour.
  assert.deepEqual(e[1].inlineOverlays[0].style, { bg: "editor.bg" });
  assert.deepEqual(cell(e, 2, 1).fg, BG);
});

test("alpha is blended over the background (R2, A4)", () => {
  const area: Area = { cols: 2, rows: 1 };
  const src = { w: 2, h: 2 };
  const img = image(2, 2, (x) => (x === 0 ? [255, 255, 255, 0] : [255, 255, 255, 128]));
  const c = compose(img, layout(src, area, fitView(src)), BG);
  assert.deepEqual(Array.from(c.rgb.subarray(0, 3)), BG);
  assert.deepEqual(Array.from(c.rgb.subarray(3, 6)), [133, 138, 143]);
});

test("16×16 at 800%: each source pixel is an 8×4-cell block of one colour (A6)", () => {
  const src = { w: 16, h: 16 };
  const area: Area = { cols: 199, rows: 55 };
  const view = { scale: 8, centre: { x: 8, y: 8 } };
  const l = layout(src, area, view);
  const img = image(l.crop.w, l.crop.h, (x, y) => [16 * (x + l.crop.x), 16 * (y + l.crop.y), 128, 255]);
  const e = cells(compose(img, l, BG));
  // Source column 3 is screen columns 35+24 … 35+31.
  const ref = cell(e, 59, 20).fg as number[];
  assert.equal(ref[0], 48);
  for (let c = 59; c < 67; c++) assert.deepEqual(cell(e, c, 20).fg, ref);
  assert.equal((cell(e, 58, 20).fg as number[])[0], 32);
  assert.equal((cell(e, 67, 20).fg as number[])[0], 64);
  // A block is 8 px tall: 4 cell rows of one colour, top and bottom alike.
  const rowsOf = (y: number) => {
    const f = cell(e, 60, y);
    return JSON.stringify([f.fg, f.bg]);
  };
  const runs: number[] = [];
  let n = 1;
  for (let y = 1; y < 55; y++) {
    if (rowsOf(y) === rowsOf(y - 1)) n++;
    else {
      runs.push(n);
      n = 1;
    }
  }
  assert.ok(runs.slice(1).every((r) => r === 4), JSON.stringify(runs));
  assert.deepEqual(cell(e, 34, 20), { ch: " ", fg: undefined, bg: "editor.bg" });
});

test("never more than rows × cols, and the last row has no newline (INV §8 P18)", () => {
  const area: Area = { cols: 30, rows: 7 };
  const src = { w: 300, h: 300 };
  const l = layout(src, area, { scale: 1, centre: { x: 150, y: 150 } });
  const e = cells(compose(image(l.crop.w, l.crop.h, () => [1, 2, 3, 255]), l, BG));
  assert.equal(e.length, 7);
  for (const row of e) assert.equal(Array.from(row.text.replace(/\n$/, "")).length, 30);
  assert.ok(!e.at(-1)!.text.endsWith("\n"));
  assert.ok(e.slice(0, -1).every((r) => r.text.endsWith("\n")));
});

test("a canvas painted for a larger area is cut to the smaller one around its centre (R6, INV §9.6)", () => {
  const c: Canvas = compose(quadrants(20, 20), layout({ w: 20, h: 20 }, { cols: 20, rows: 10 }, fitView({ w: 20, h: 20 })), BG);
  const small = fitCanvas(c, { cols: 10, rows: 4 });
  assert.deepEqual([small.w, small.h], [10, 8]);
  const e = cells(small);
  assert.equal(e.length, 4);
  assert.deepEqual(cell(e, 4, 1).fg, [255, 0, 0]);
  assert.deepEqual(cell(e, 5, 2).bg, [255, 255, 255]);
  assert.equal(fitCanvas(c, { cols: 40, rows: 40 }), c);
});

test("header: name, size, zoom, keys, in order, cut to the pane (R3, A5)", () => {
  assert.equal(header("quadrants.png", { w: 400, h: 300 }, "fit", 200), `quadrants.png  400×300  fit  ${KEYS}`);
  assert.equal(header("quadrants.png", { w: 400, h: 300 }, "200%", 200), `quadrants.png  400×300  200%  ${KEYS}`);
  const narrow = header("quadrants.png", { w: 400, h: 300 }, "fit", 40);
  assert.equal(Array.from(narrow).length, 40);
  assert.ok(narrow.startsWith("quadrants.png  400×300  fit"));
  assert.equal(loadingHeader("a.png", 80), "a.png  loading…");
  // A control character in a file name would give the 1-row panel a second line.
  assert.equal(loadingHeader("a\nb.png", 80), "a?b.png  loading…");
  assert.ok(!header("a\nb\t.png", { w: 1, h: 1 }, "fit", 200).includes("\n"));
});

test("the canvas carries the background it was blended over, and a re-cut keeps it (INV §8 P19)", () => {
  const c = compose(quadrants(4, 4), layout({ w: 4, h: 4 }, { cols: 8, rows: 4 }, fitView({ w: 4, h: 4 })), BG);
  assert.deepEqual(c.bg, BG);
  assert.deepEqual(fitCanvas(c, { cols: 4, rows: 2 }).bg, BG);
  assert.equal(c.terminalBg, false);
  assert.equal(fitCanvas(compose(quadrants(4, 4), layout({ w: 4, h: 4 }, { cols: 8, rows: 4 }, fitView({ w: 4, h: 4 })), BG, true), { cols: 4, rows: 2 }).terminalBg, true);
});

test("theme key: as the host's registry resolves getConfig().theme (INV §8 P19, theme/loader.rs resolve_key)", () => {
  const dir = "/home/u/.config/fresh/themes";
  assert.equal(themeKey({ theme: "builtin://light" }, dir), "light");
  assert.equal(themeKey({ theme: "high-contrast" }, dir), "high-contrast");
  assert.equal(themeKey({ theme: "s-dark.json" }, dir), `file://${dir}/s-dark.json`, "a user theme, as the picker saves it");
  assert.equal(themeKey({ theme: "nord/dark.json" }, `${dir}/`), `file://${dir}/nord/dark.json`);
  assert.equal(themeKey({ theme: "/abs/t.json" }, dir), "file:///abs/t.json");
  assert.equal(themeKey({ theme: "file:///abs/t.json" }, dir), "file:///abs/t.json");
  assert.equal(themeKey({ theme: "https://github.com/a/b.json" }, dir), "https://github.com/a/b.json");
  assert.equal(themeKey({}, dir), "");
  assert.equal(themeKey(null, dir), "");
  // `~`, `$VAR` and `${VAR}` expand in a path and a file:// value (loader.rs expand_env_vars).
  const env = (n: string) => ({ HOME: "/home/u", T: "themes" })[n] ?? null;
  assert.equal(themeKey({ theme: "~/t.json" }, dir, env), "file:///home/u/t.json");
  assert.equal(themeKey({ theme: "${HOME}/$T/t.json" }, dir, env), "file:///home/u/themes/t.json");
  assert.equal(themeKey({ theme: "file://$HOME/t.json" }, dir, env), "file:///home/u/t.json");
  assert.equal(themeKey({ theme: "$NOPE/t.json" }, dir, env), `file://${dir}/$NOPE/t.json`, "an unset variable stays as written");
});

test("theme background: an RGB triple, a named colour at the host's RGB, {color}, or the terminal's own (theme/types.rs)", () => {
  assert.deepEqual(themeBg({ editor: { bg: [1, 2, 3] } }), [1, 2, 3]);
  assert.deepEqual(themeBg({ editor: { bg: "Black" } }), [0, 0, 0]);
  assert.deepEqual(themeBg({ editor: { bg: "LightBlue" } }), [92, 92, 255]);
  assert.deepEqual(themeBg({ editor: { bg: { color: [40, 42, 54], modifier: ["Bold"] } } }), [40, 42, 54]);
  assert.deepEqual(themeBg({ editor: { bg: { color: "White" } } }), [255, 255, 255]);
  assert.equal(themeBg({ editor: { bg: "Default" } }), TERMINAL_BG);
  assert.equal(themeBg({ editor: { bg: "toString" } }), null, "only the host's names");
  assert.equal(themeBg({ editor: { bg: [1, 2] } }), null);
  assert.equal(themeBg({ editor: { bg: [1, Number.NaN, 3] } }), null);
  assert.equal(themeBg({ editor: { bg: null } }), null);
  assert.equal(themeBg(null), null);
});

test("a terminal background: the first row keeps the theme key and the exact colours, as the rows below (INV §8 P19)", () => {
  const area: Area = { cols: 6, rows: 2 };
  const src = { w: 2, h: 4 };
  const img = image(2, 4, (x) => (x === 0 ? [0, 0, 0, 255] : [200, 0, 0, 255]));
  const e = cells(compose(img, layout(src, area, fitView(src)), [0, 0, 0], true));
  assert.deepEqual(e[0].inlineOverlays[0].style, { bg: "editor.bg" });
  assert.deepEqual(cell(e, 2, 0), { ch: "▀", fg: [0, 0, 0], bg: [0, 0, 0] });
  assert.deepEqual(e[1].inlineOverlays[0].style, { bg: "editor.bg" });
});

test("a cell the image covers only in one half draws the other half as padding, not the stand-in black", () => {
  // 4×3 at fit in 6×3 cells: the second cell row has image pixels only on top.
  const src = { w: 4, h: 3 };
  const l = layout(src, { cols: 6, rows: 3 }, fitView(src));
  const white = image(4, 3, () => [255, 255, 255, 255]);
  const term = cells(compose(white, l, [0, 0, 0], true));
  assert.deepEqual(cell(term, 1, 1), { ch: "▀", fg: [255, 255, 255], bg: "editor.bg" });
  const themed = cells(compose(white, l, BG));
  assert.deepEqual(cell(themed, 1, 1), { ch: "▀", fg: [255, 255, 255], bg: "editor.bg" });
  // A canvas whose image starts in a cell's lower half draws `▄`.
  const c = compose(white, l, BG);
  c.inside.fill(0, 0, c.w);
  assert.deepEqual(cell(cells(c), 1, 0), { ch: "▄", fg: [255, 255, 255], bg: nudge(BG) });
});

test("clip cuts by code points, with an optional mark (R3, R11)", () => {
  assert.equal(clip("abc", 5), "abc");
  assert.equal(clip("a×b×c", 3), "a×b");
  assert.equal(clip("abcdef", 4, "…"), "abc…");
  assert.equal(clip("abc", 0), "");
});
