// Painting (R2, R3, R5): the tool's pixels placed on a canvas of screen
// pixels, and the canvas turned into the image panel's entries, one `▀`
// cell per two pixels (INV §3, P3). Pure: no editor.

import type { Image } from "./decode.ts";
import { clip } from "./text.ts";
import type { Area, Layout, Size } from "./view.ts";

export type Rgb = [number, number, number];

/** The image area in screen pixels: `cols` wide, `2·rows` tall. */
export interface Canvas {
  w: number;
  h: number;
  /** w·h·3 bytes, blended over the background. */
  rgb: Uint8Array;
  /** 1 where an image pixel was drawn, 0 for the background around it. */
  inside: Uint8Array;
  /** The editor background it was blended over, read once per frame. */
  bg: Rgb;
  /** The theme leaves the background to the terminal (`TERMINAL_BG`): `bg`
   *  is a stand-in, and the first row needs no nudge. */
  terminalBg: boolean;
}

/** The `getThemeData` key for `getConfig().theme`, as the host's theme
 *  registry resolves it (`ThemeRegistry::resolve_key`, theme/loader.rs).
 *  `builtin://light` is `light` there (INV §8 P19). A user theme is saved
 *  as a path relative to the themes directory (`s-dark.json`,
 *  `nord/dark.json`), and its key is `file://` and the absolute path. A
 *  `file://` value and such a path get `~`, `$VAR` and `${VAR}` expanded
 *  first, as the host does. Any other value (an `https://` key, a bare
 *  name) is a key or a name as it is. */
export function themeKey(config: unknown, themesDir: string, env: (name: string) => string | null = () => null): string {
  const theme = String((config as { theme?: unknown } | null)?.theme ?? "");
  if (theme.startsWith("builtin://")) return theme.slice("builtin://".length);
  if (theme.startsWith("file://")) return `file://${expandEnv(theme.slice("file://".length), env)}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(theme) || !theme.endsWith(".json")) return theme;
  const path = expandEnv(theme, env);
  return `file://${path.startsWith("/") ? path : `${themesDir.replace(/\/+$/, "")}/${path}`}`;
}

/** `~`, `$VAR` and `${VAR}` expanded as the host's `expand_env_vars`
 *  (theme/loader.rs): `~` from `HOME`, and an unset variable left as
 *  written. */
function expandEnv(value: string, env: (name: string) => string | null): string {
  const home = value.startsWith("~") ? env("HOME") : null;
  const s = home === null ? value : home + value.slice(1);
  return s.replace(/\$\{([^}]*)\}|\$([A-Za-z0-9_]+)/g, (m: string, braced: string | undefined, bare: string | undefined) => env(braced ?? bare ?? "") ?? m);
}

/** The host's RGB for each named colour (`color_to_rgb`, theme/types.rs). */
const NAMED = new Map<string, Rgb>([
  ["White", [255, 255, 255]],
  ["Black", [0, 0, 0]],
  ["Red", [205, 0, 0]],
  ["Green", [0, 205, 0]],
  ["Blue", [0, 0, 238]],
  ["Yellow", [205, 205, 0]],
  ["Magenta", [205, 0, 205]],
  ["Cyan", [0, 205, 205]],
  ["Gray", [229, 229, 229]],
  ["DarkGray", [127, 127, 127]],
  ["LightRed", [255, 0, 0]],
  ["LightGreen", [0, 255, 0]],
  ["LightBlue", [92, 92, 255]],
  ["LightYellow", [255, 255, 0]],
  ["LightMagenta", [255, 0, 255]],
  ["LightCyan", [0, 255, 255]],
]);

/** `themeBg` for the named colour `Default`: the terminal's own background,
 *  whose RGB no plugin can read. */
export const TERMINAL_BG = "terminal";

/** The editor background from `getThemeData`'s result, or null. The host
 *  gives `[r, g, b]`, a colour name, or `{color, modifier}` for a colour
 *  with text attributes (`StyledColorDef`, theme/types.rs). */
export function themeBg(data: unknown): Rgb | typeof TERMINAL_BG | null {
  let bg = (data as { editor?: { bg?: unknown } } | null)?.editor?.bg;
  if (bg !== null && typeof bg === "object" && !Array.isArray(bg)) bg = (bg as { color?: unknown }).color;
  if (bg === "Default") return TERMINAL_BG;
  if (typeof bg === "string") return NAMED.get(bg) ?? null;
  return Array.isArray(bg) && bg.length === 3 && bg.every((n) => typeof n === "number" && Number.isFinite(n)) ? [bg[0], bg[1], bg[2]] : null;
}

/** Places `img`, the tool's output for `layout`, on a canvas of the
 *  layout's area. Alpha is blended over `bg` (R2); `terminalBg` says `bg`
 *  stands in for the terminal's own. Above 100% each source pixel is a
 *  `rep`×`rep` block, nearest neighbour (R4). */
export function compose(img: Image, layout: Layout, bg: Rgb, terminalBg = false): Canvas {
  const w = layout.area.cols;
  const h = layout.area.rows * 2;
  const rgb = new Uint8Array(w * h * 3);
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = bg[0];
    rgb[i * 3 + 1] = bg[1];
    rgb[i * 3 + 2] = bg[2];
  }
  const { place, draw, phase, rep } = layout;
  const x1 = Math.min(w, place.x + draw.w);
  const y1 = Math.min(h, place.y + draw.h);
  for (let y = Math.max(0, place.y); y < y1; y++) {
    const sy = Math.min(img.h - 1, Math.floor((y - place.y + phase.y) / rep));
    for (let x = Math.max(0, place.x); x < x1; x++) {
      const sx = Math.min(img.w - 1, Math.floor((x - place.x + phase.x) / rep));
      const s = (sy * img.w + sx) * 4;
      const d = y * w + x;
      const a = img.rgba[s + 3] / 255;
      for (let k = 0; k < 3; k++) rgb[d * 3 + k] = Math.round(a * img.rgba[s + k] + (1 - a) * bg[k]);
      inside[d] = 1;
    }
  }
  return { w, h, rgb, inside, bg, terminalBg };
}

/** The canvas cut to `area` around its centre, for a panel that shrank
 *  since it was painted (INV §9.6, P18). A canvas no larger than
 *  the area is returned as it is. */
export function fitCanvas(c: Canvas, area: Area): Canvas {
  const w = Math.min(c.w, area.cols);
  const h = Math.min(c.h, area.rows * 2);
  if (w === c.w && h === c.h) return c;
  const ox = Math.floor((c.w - w) / 2);
  const oy = 2 * Math.floor((c.h - h) / 4);
  const rgb = new Uint8Array(w * h * 3);
  const inside = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const from = (y + oy) * c.w + ox;
    rgb.set(c.rgb.subarray(from * 3, (from + w) * 3), y * w * 3);
    inside.set(c.inside.subarray(from, from + w), y * w);
  }
  return { w, h, rgb, inside, bg: c.bg, terminalBg: c.terminalBg };
}

/** `c` one unit off in one channel. On the image panel's first row, a cell
 *  colour equal to the editor background is drawn with the terminal's own
 *  background instead (INV §8 P19), so `cells` moves it off (spec Decisions).
 *  When the editor background is the terminal's own, that is already right. */
export function nudge(c: Rgb): Rgb {
  return [c[0] < 255 ? c[0] + 1 : c[0] - 1, c[1], c[2]];
}

const same = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

interface Overlay {
  start: number;
  end: number;
  unit: "byte";
  style: { fg?: Rgb | string; bg: Rgb | string };
}

export interface Entry {
  text: string;
  inlineOverlays: Overlay[];
}

/** The canvas as panel entries: one per row of cells, with no `\n` after
 *  the last (INV §8 P18), never more than rows × cols. A cell with an image
 *  pixel in both halves is `▀`, its fg the upper pixel and its bg the lower,
 *  with one byte-unit overlay at 3 bytes a cell (P3). A cell with one
 *  image half draws that half as the fg (`▀` or `▄`) over the padding's bg,
 *  so a terminal background shows there too, not its black stand-in. The
 *  rest are spaces, one overlay per run on either side, in the theme's
 *  `editor.bg` (R2, INV §8 P19). */
export function cells(c: Canvas): Entry[] {
  const bg = c.bg;
  const rows = Math.floor(c.h / 2);
  const out: Entry[] = [];
  const off = nudge(bg);
  for (let r = 0; r < rows; r++) {
    const first = r === 0 && !c.terminalBg;
    const pad: Rgb | string = first ? off : "editor.bg";
    let text = "";
    const overlays: Overlay[] = [];
    let bytes = 0;
    let runStart = -1;
    const endRun = () => {
      if (runStart < 0) return;
      overlays.push({ start: runStart, end: bytes, unit: "byte", style: { bg: pad } });
      runStart = -1;
    };
    const px = (i: number): Rgb => {
      const p: Rgb = [c.rgb[i * 3], c.rgb[i * 3 + 1], c.rgb[i * 3 + 2]];
      return first && same(p, bg) ? off : p;
    };
    for (let x = 0; x < c.w; x++) {
      const top = (2 * r) * c.w + x;
      const bottom = top + c.w;
      if (!c.inside[top] && !c.inside[bottom]) {
        if (runStart < 0) runStart = bytes;
        text += " ";
        bytes += 1;
        continue;
      }
      endRun();
      if (c.inside[top] && c.inside[bottom]) {
        overlays.push({ start: bytes, end: bytes + 3, unit: "byte", style: { fg: px(top), bg: px(bottom) } });
        text += "▀";
      } else if (c.inside[top]) {
        overlays.push({ start: bytes, end: bytes + 3, unit: "byte", style: { fg: px(top), bg: pad } });
        text += "▀";
      } else {
        overlays.push({ start: bytes, end: bytes + 3, unit: "byte", style: { fg: px(bottom), bg: pad } });
        text += "▄";
      }
      bytes += 3;
    }
    endRun();
    out.push({ text: r < rows - 1 ? text + "\n" : text, inlineOverlays: overlays });
  }
  return out;
}

/** The keys, as the header lists them (R3). */
export const KEYS = "+/- zoom  0 fit  arrows/hjkl pan  b bytes  q close";


/** `name` on one line: a control character (a `\n` in a file name) would
 *  give the 1-row header panel a second line to scroll to. */
const oneLine = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "?");

/** The header row: name, size, zoom, keys, cut to the pane (R3). */
export function header(name: string, src: Size, zoom: string, cols: number): string {
  return clip(`${oneLine(name)}  ${src.w}×${src.h}  ${zoom}  ${KEYS}`, Math.max(0, cols));
}

/** The header while the image is on its way (R1). */
export function loadingHeader(name: string, cols: number): string {
  return clip(`${oneLine(name)}  loading…`, Math.max(0, cols));
}
