// View geometry (R2, R4, R5, R6): where the image sits in the image area,
// and which source pixels the tool must produce for it. Pure: no editor.
//
// The area is in screen pixels: a cell is one pixel wide and two tall, so
// Wp = cols and Hp = 2·rows. The scale `s` is screen pixels per source
// pixel; 100% is s = 1 (R4).

export interface Size {
  w: number;
  h: number;
}

/** The image area in cells: the image split's text area (INV §4, P14). */
export interface Area {
  cols: number;
  rows: number;
}

export type Scale = "fit" | number;

export interface Point {
  x: number;
  y: number;
}

/** What the keys change: the zoom and the source point at the view's centre. */
export interface View {
  scale: Scale;
  centre: Point;
}

export const MAX_SCALE = 8;

const px = (area: Area): Size => ({ w: area.cols, h: area.rows * 2 });

/** The largest scale at which the whole image fits, never above 100% (R2). */
export function fitScale(src: Size, area: Area): number {
  const a = px(area);
  const f = Math.min(1, a.w / src.w, a.h / src.h);
  // A zero or non-finite size would make the stops below endless.
  return Number.isFinite(f) && f > 0 ? f : 1;
}

export function scaleOf(scale: Scale, src: Size, area: Area): number {
  return scale === "fit" ? fitScale(src, area) : scale;
}

/** The zoom stops: fit, then every 100%·2^k (k ≤ 3) above it, ascending
 *  (spec Decisions). */
export function stops(src: Size, area: Area): number[] {
  const fit = fitScale(src, area);
  const out = [fit];
  let k = Math.ceil(Math.log2(fit));
  if (2 ** k <= fit) k++;
  for (; 2 ** k <= MAX_SCALE; k++) out.push(2 ** k);
  return out;
}

/** The view's centre, moved as little as needed to keep the image's
 *  edges outside the area; along an axis that fits, the image's centre. */
export function clampCentre(c: Point, s: number, src: Size, area: Area): Point {
  const a = px(area);
  const axis = (v: number, len: number, view: number) => {
    const half = view / s / 2;
    if (half * 2 >= len) return len / 2;
    return Math.min(Math.max(v, half), len - half);
  };
  return { x: axis(c.x, src.w, a.w), y: axis(c.y, src.h, a.h) };
}

/** The source point at the centre of the screen now: the stored centre,
 *  clamped to the edges at the current scale. The stored one is kept as the
 *  user left it, so a resize that clamps it does not lose it (R6); `layout`
 *  clamps when it draws. */
export function effectiveCentre(view: View, src: Size, area: Area): Point {
  return clampCentre(view.centre, scaleOf(view.scale, src, area), src, area);
}

/** Whether two views draw the same. */
export function sameView(a: View, b: View, src: Size, area: Area): boolean {
  const ca = effectiveCentre(a, src, area);
  const cb = effectiveCentre(b, src, area);
  return a.scale === b.scale && ca.x === cb.x && ca.y === cb.y;
}

/** The view at `scale`, centred on the point at the centre now (R4). */
function at(scale: Scale, view: View, src: Size, area: Area): View {
  return { scale, centre: effectiveCentre(view, src, area) };
}

/** `+`: the smallest stop above the current scale; nothing above 800% (R4). */
export function zoomIn(view: View, src: Size, area: Area): View {
  const s = scaleOf(view.scale, src, area);
  const list = stops(src, area);
  const i = list.findIndex((x) => x > s + 1e-9);
  if (i < 0) return view;
  return at(i === 0 ? "fit" : list[i], view, src, area);
}

/** `-`: the largest stop below the current scale; nothing below fit (R4). */
export function zoomOut(view: View, src: Size, area: Area): View {
  const s = scaleOf(view.scale, src, area);
  const list = stops(src, area);
  let i = -1;
  for (let j = 0; j < list.length; j++) if (list[j] < s - 1e-9) i = j;
  if (i < 0) return view;
  return at(i === 0 ? "fit" : list[i], view, src, area);
}

/** `0`, and the first view of an image (R2, R4). */
export function fitView(src: Size): View {
  return { scale: "fit", centre: { x: src.w / 2, y: src.h / 2 } };
}

/** An arrow or `h j k l`: a quarter of the area, at least one cell, in
 *  source pixels, clamped at the edges (R5). */
export function pan(view: View, src: Size, area: Area, dx: -1 | 0 | 1, dy: -1 | 0 | 1): View {
  const s = scaleOf(view.scale, src, area);
  const stepX = Math.max(1, Math.floor(area.cols / 4)) / s;
  const stepY = (2 * Math.max(1, Math.floor(area.rows / 4))) / s;
  // From the centre on screen, so a press after a resize is never spent
  // moving an off-screen stored centre back to the edge.
  const c = effectiveCentre(view, src, area);
  const centre = { x: c.x + dx * stepX, y: c.y + dy * stepY };
  return { scale: view.scale, centre: clampCentre(centre, s, src, area) };
}

/** The header's zoom: `fit`, or a percentage such as `6.25%` (R3). */
export function zoomLabel(scale: Scale): string {
  return scale === "fit" ? "fit" : `${Number((scale * 100).toFixed(2))}%`;
}

export interface Layout {
  area: Area;
  /** Screen pixels per source pixel. */
  s: number;
  /** The source rectangle the tool crops, in source pixels. */
  crop: { x: number; y: number; w: number; h: number };
  /** The tool's output size: scaled below 100%, else the crop 1:1. */
  out: Size;
  /** Screen pixels per output pixel: 1 below 100%, else s. */
  rep: number;
  /** Screen pixels of the first output pixel that fall before the area. */
  phase: Point;
  /** Where the drawn image starts in the area, in screen pixels. */
  place: Point;
  /** The drawn image's size in screen pixels. */
  draw: Size;
}

interface Axis {
  crop: number;
  len: number;
  out: number;
  phase: number;
  place: number;
  draw: number;
}

/** One axis of the layout. `grain` is the screen pixels per cell along it
 *  (2 vertically): the placement and the phase are kept to whole cells, so
 *  a block above 100% starts on a cell boundary (A6). */
function axis(centre: number, srcLen: number, view: number, s: number, grain: number): Axis {
  const whole = (v: number) => v - (v % grain);
  if (s < 1) {
    const full = srcLen * s;
    if (full <= view + 1e-9) {
      const out = Math.min(view, Math.max(1, Math.round(full)));
      return { crop: 0, len: srcLen, out, phase: 0, place: whole(Math.floor((view - out) / 2)), draw: out };
    }
    const len = Math.min(srcLen, Math.max(1, Math.round(view / s)));
    const crop = Math.min(Math.max(Math.round(centre - len / 2), 0), srcLen - len);
    return { crop, len, out: view, phase: 0, place: 0, draw: view };
  }
  const rep = Math.round(s);
  if (srcLen * rep <= view) {
    return { crop: 0, len: srcLen, out: srcLen, phase: 0, place: whole(Math.floor((view - srcLen * rep) / 2)), draw: srcLen * rep };
  }
  const left = Math.min(Math.max(centre - view / rep / 2, 0), srcLen - view / rep);
  const crop = Math.floor(left);
  const phase = whole(Math.min(rep - 1, Math.floor((left - crop) * rep + 1e-9)));
  const len = Math.min(srcLen - crop, Math.ceil((view + phase) / rep));
  return { crop, len, out: len, phase, place: 0, draw: view };
}

/** What the tool must produce for `view` in `area`, and where it goes. */
export function layout(src: Size, area: Area, view: View): Layout {
  const s = scaleOf(view.scale, src, area);
  const a = px(area);
  const c = clampCentre(view.centre, s, src, area);
  const x = axis(c.x, src.w, a.w, s, 1);
  const y = axis(c.y, src.h, a.h, s, 2);
  return {
    area,
    s,
    crop: { x: x.crop, y: y.crop, w: x.len, h: y.len },
    out: { w: x.out, h: y.out },
    rep: s < 1 ? 1 : Math.round(s),
    phase: { x: x.phase, y: y.phase },
    place: { x: x.place, y: y.place },
    draw: { w: x.draw, h: y.draw },
  };
}
