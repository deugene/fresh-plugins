import { test } from "node:test";
import assert from "node:assert/strict";
import { clampCentre, effectiveCentre, fitScale, fitView, layout, pan, sameView, scaleOf, stops, zoomIn, zoomLabel, zoomOut, type Area, type View } from "../lib/view.ts";

const BIG = { w: 4000, h: 3000 };
const A6: Area = { cols: 199, rows: 55 };
const SMALL = { w: 16, h: 16 };
const QUAD = { w: 400, h: 300 };

const pct = (v: View, src = BIG, area = A6) => Number((scaleOf(v.scale, src, area) * 100).toFixed(2));

test("fit is min(1, Wp/W, Hp/H) (R2)", () => {
  assert.equal(Number((fitScale(BIG, A6) * 100).toFixed(2)), 3.67);
  assert.equal(fitScale(SMALL, A6), 1, "fit never enlarges");
  assert.equal(fitScale(QUAD, A6), Math.min(199 / 400, 110 / 300));
});

test("the stop list: fit, then every 100%·2^k up to 800% above it (A6, spec Decisions)", () => {
  assert.deepEqual(stops(BIG, A6).map((s) => Number((s * 100).toFixed(2))), [3.67, 6.25, 12.5, 25, 50, 100, 200, 400, 800]);
  assert.deepEqual(stops(SMALL, A6), [1, 2, 4, 8]);
  assert.deepEqual(stops({ w: 398, h: 10 }, A6), [0.5, 1, 2, 4, 8], "a fit that is a stop is listed once");
});

test("+ walks up the stops and stops at 800%; - walks back the same way to fit (A6)", () => {
  let v = fitView(BIG);
  const up: number[] = [];
  for (let i = 0; i < 9; i++) {
    v = zoomIn(v, BIG, A6);
    up.push(pct(v));
  }
  assert.deepEqual(up, [6.25, 12.5, 25, 50, 100, 200, 400, 800, 800]);
  const down: (number | string)[] = [];
  for (let i = 0; i < 9; i++) {
    v = zoomOut(v, BIG, A6);
    down.push(v.scale === "fit" ? "fit" : pct(v));
  }
  assert.deepEqual(down, [400, 200, 100, 50, 25, 12.5, 6.25, "fit", "fit"]);
});

test("labels: fit and percentages (R3)", () => {
  assert.equal(zoomLabel("fit"), "fit");
  assert.equal(zoomLabel(0.0625), "6.25%");
  assert.equal(zoomLabel(0.125), "12.5%");
  assert.equal(zoomLabel(1), "100%");
  assert.equal(zoomLabel(8), "800%");
});

test("an off-list scale after a resize: + and - go to the next stop either way (R6)", () => {
  // 25% kept from a smaller area; the new area's fit is 30%.
  const area: Area = { cols: 120, rows: 45 };
  const src = { w: 400, h: 300 };
  assert.ok(fitScale(src, area) > 0.25);
  const v: View = { scale: 0.25, centre: { x: 200, y: 150 } };
  assert.equal(zoomIn(v, src, area).scale, "fit");
  assert.equal(zoomOut(v, src, area), v, "nothing below it");
  const w: View = { scale: 0.75, centre: { x: 200, y: 150 } };
  assert.equal(zoomIn(w, src, area).scale, 1);
  assert.equal(zoomOut(w, src, area).scale, 0.5);
});

test("zoom keeps the centre's source point, as far as the edges allow (R4, A7)", () => {
  const v: View = { scale: 0.25, centre: { x: 1000, y: 800 } };
  const z = zoomIn(v, BIG, A6);
  assert.deepEqual(z.centre, { x: 1000, y: 800 });
  // Near the edge the centre on screen moves only as far as it must.
  const e = zoomOut({ scale: 1, centre: { x: 3950, y: 2990 } }, BIG, A6);
  assert.deepEqual(effectiveCentre(e, BIG, A6), { x: 4000 - 199 / 0.5 / 2, y: 3000 - 110 / 0.5 / 2 });
  // The anchor is the point on screen before the zoom, not a stored point past the edge.
  assert.deepEqual(e.centre, { x: 4000 - 199 / 2, y: 3000 - 110 / 2 });
});

test("pan: a quarter of the area, at least one cell, clamped; centred along an axis that fits (R5, A8)", () => {
  const v: View = { scale: 4, centre: { x: 200, y: 150 } };
  const r = pan(v, QUAD, A6, 1, 0);
  assert.equal(r.centre.x - v.centre.x, Math.floor(199 / 4) / 4);
  assert.equal(r.centre.y, 150);
  const d = pan(v, QUAD, A6, 0, 1);
  assert.equal(d.centre.y - v.centre.y, (2 * Math.floor(55 / 4)) / 4);
  let far = v;
  for (let i = 0; i < 100; i++) far = pan(far, QUAD, A6, 1, 1);
  assert.deepEqual(far.centre, { x: 400 - 199 / 4 / 2, y: 300 - 110 / 4 / 2 });
  const tiny = pan({ scale: 8, centre: { x: 8, y: 8 } }, SMALL, { cols: 3, rows: 3 }, 1, 0);
  assert.equal(tiny.centre.x - 8, 1 / 8, "at least one cell");
  const fit = fitView(QUAD);
  assert.deepEqual(pan(fit, QUAD, A6, 1, 1).centre, fit.centre, "at fit the arrows change nothing");
  const wide = pan({ scale: 1, centre: { x: 200, y: 150 } }, { w: 400, h: 40 }, A6, 0, 1);
  assert.equal(wide.centre.y, 20, "an axis that fits stays centred");
});

test("a new area keeps the scale and the centre, drawn clamped to it (R6, A9)", () => {
  // A resize changes only the area: the view is drawn by layout() from the
  // same stored scale and centre.
  const v: View = { scale: 4, centre: { x: 120, y: 80 } };
  const area: Area = { cols: 111, rows: 40 };
  const l = layout(QUAD, area, v);
  assert.equal(l.s, 4);
  assert.deepEqual(effectiveCentre(v, QUAD, area), { x: 120, y: 80 });
  assert.ok(Math.abs(l.crop.x + l.crop.w / 2 - 120) <= 1, "centred on the same source point, within a pixel");
  const edge: View = { scale: 4, centre: { x: 5, y: 5 } };
  assert.deepEqual(effectiveCentre(edge, QUAD, area), { x: 111 / 8, y: 10 }, "drawn clamped");
  assert.equal(layout(QUAD, { cols: 50, rows: 20 }, fitView(QUAD)).s, fitScale(QUAD, { cols: 50, rows: 20 }), "fit fits the new area");
});

test("grow then shrink at 400% at the right edge comes back to the right edge (R6)", () => {
  const small: Area = { cols: 199, rows: 55 };
  const big: Area = { cols: 300, rows: 55 };
  let v: View = { scale: 4, centre: { x: 200, y: 150 } };
  for (let i = 0; i < 60; i++) v = pan(v, QUAD, small, 1, 0);
  const atEdge = layout(QUAD, small, v);
  assert.equal(atEdge.crop.x + atEdge.crop.w, 400, "at the right edge");
  const grown = layout(QUAD, big, v);
  assert.equal(grown.crop.x + grown.crop.w, 400);
  assert.ok(effectiveCentre(v, QUAD, big).x < v.centre.x, "clamped while grown");
  assert.deepEqual(layout(QUAD, small, v), atEdge, "the same view after shrinking back");
  // A press after the grow starts from the centre on screen: it is never spent.
  const left = pan(v, QUAD, big, -1, 0);
  assert.ok(effectiveCentre(left, QUAD, big).x < effectiveCentre(v, QUAD, big).x);
  assert.ok(sameView(pan(v, QUAD, big, 1, 0), v, QUAD, big), "and right, at the edge, changes nothing");
});

test("a zero or non-finite size never makes the stops endless (INV §8 P17)", () => {
  for (const [src, area] of [
    [{ w: 0, h: 0 }, A6],
    [QUAD, { cols: 0, rows: 0 }],
    [QUAD, { cols: Number.NaN, rows: 5 }],
    [{ w: Number.POSITIVE_INFINITY, h: 3 }, A6],
  ] as const) {
    assert.equal(fitScale(src, area), 1);
    assert.deepEqual(stops(src, area), [1, 2, 4, 8]);
  }
});

test("layout at fit: the whole image, scaled, centred (R2, A4)", () => {
  const l = layout(QUAD, A6, fitView(QUAD));
  assert.deepEqual(l.crop, { x: 0, y: 0, w: 400, h: 300 });
  assert.equal(l.rep, 1);
  assert.deepEqual(l.out, { w: 147, h: 110 });
  assert.deepEqual(l.place, { x: 26, y: 0 });
  const big = layout(BIG, A6, fitView(BIG));
  assert.deepEqual(big.out, { w: 147, h: 110 });
  const s = layout(SMALL, A6, fitView(SMALL));
  // Placed on a cell boundary, so 16 px tall is exactly 8 rows (A4).
  assert.deepEqual([s.out, s.rep, s.draw, s.place], [{ w: 16, h: 16 }, 1, { w: 16, h: 16 }, { x: 91, y: 46 }]);
});

test("layout below 100% with the image wider than the area: crop, then scale to the area", () => {
  const l = layout(BIG, A6, { scale: 0.0625, centre: { x: 2000, y: 1500 } });
  assert.deepEqual(l.out, { w: 199, h: 110 });
  // 199 / 0.0625 = 3184 and 110 / 0.0625 = 1760 source pixels, around the centre.
  assert.deepEqual(l.crop, { x: 2000 - 3184 / 2, y: 1500 - 1760 / 2, w: 3184, h: 1760 });
  assert.deepEqual(l.place, { x: 0, y: 0 });
});

test("layout above 100%: 1:1 output, replicated, with a phase; 16×16 at 800% (A6)", () => {
  const s = layout(SMALL, A6, { scale: 8, centre: { x: 8, y: 8 } });
  // 128 screen px wide fit the 199-cell area and centre; the 110 px tall
  // view shows 13.75 source rows from 8 − 6.875.
  assert.equal(s.rep, 8);
  assert.deepEqual(s.crop, { x: 0, y: 1, w: 16, h: 14 });
  assert.deepEqual(s.place, { x: 35, y: 0 });
  assert.equal(s.phase.y, 0, "kept to whole cells vertically");
  const q = layout(QUAD, A6, { scale: 4, centre: { x: 200, y: 150 } });
  // Left edge 200 − 199/8 = 175.125, top 150 − 110/8 = 136.25.
  assert.deepEqual(q.crop, { x: 175, y: 136, w: 50, h: 28 });
  assert.deepEqual(q.phase, { x: 0, y: 0 });
  assert.deepEqual(q.draw, { w: 199, h: 110 });
});

test("clampCentre centres an axis that fits", () => {
  assert.deepEqual(clampCentre({ x: 0, y: 0 }, 0.1, QUAD, A6), { x: 200, y: 150 });
});
