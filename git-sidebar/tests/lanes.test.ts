import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLog, type Commit } from "../lib/history.ts";
import { layout, LANE_COLORS, type Cell } from "../lib/lanes.ts";
import { recorded } from "./helpers.ts";

const LOGS = ["line", "a30", "cross", "octopus", "diverged", "roots", "shallow", "detached", "long"];
const commitsOf = (name: string, n = 50): Commit[] => parseLog(recorded(`log-${name}.z`), n, "origin/main").commits;
const draw = (rows: Cell[][]): string[] => rows.map((r) => r.map((c) => c.text).join(""));

type Dir = "up" | "down" | "left" | "right";
/** The sides each glyph joins. `┼` is two lines that cross: it passes
 *  straight through, never turns. */
const JOINS: Record<string, Dir[]> = {
  "│": ["up", "down"],
  "─": ["left", "right"],
  "╮": ["left", "down"],
  "╭": ["right", "down"],
  "╯": ["up", "left"],
  "╰": ["up", "right"],
  "┴": ["up", "left", "right"],
  "┬": ["down", "left", "right"],
  "┼": ["up", "down", "left", "right"],
};
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
const STEP: Record<Dir, [number, number]> = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
const isNode = (t: string) => t === "●" || t === "○";

/** The rows whose nodes the lines from row `r`'s node lead to, following
 *  them down and sideways, never up, and stopping at the first node. */
function reached(rows: Cell[][], r: number): Set<number> {
  const at = (y: number, x: number): string => rows[y]?.[x]?.text ?? " ";
  const nodeCol = rows[r].findIndex((c) => isNode(c.text));
  const out = new Set<number>();
  const seen = new Set<string>();
  const queue: [number, number, Dir][] = (["down", "left", "right"] as Dir[]).map((d) => [r, nodeCol, d]);
  while (queue.length > 0) {
    const [y, x, d] = queue.shift()!;
    const [dy, dx] = STEP[d];
    const ny = y + dy;
    const nx = x + dx;
    const t = at(ny, nx);
    const from = OPPOSITE[d];
    if (isNode(t)) {
      out.add(ny);
      continue;
    }
    const joins = JOINS[t];
    if (joins === undefined || !joins.includes(from)) continue;
    const exits = t === "┼" ? [d] : joins.filter((j) => j !== from && j !== "up");
    for (const e of exits) {
      const k = `${ny},${nx},${e}`;
      if (!seen.has(k)) {
        seen.add(k);
        queue.push([ny, nx, e]);
      }
    }
  }
  return out;
}

test("one commit per row, each row one node: ● or, for a merge, ○ (R31, A31)", () => {
  for (const name of LOGS) {
    const commits = commitsOf(name);
    const rows = layout(commits);
    assert.equal(rows.length, commits.length, name);
    for (const [i, row] of rows.entries()) {
      const nodes = row.filter((c) => isNode(c.text));
      assert.equal(nodes.length, 1, `${name} row ${i}`);
      assert.equal(nodes[0].text, commits[i].parents.length > 1 ? "○" : "●", `${name} row ${i}`);
    }
  }
});

test("from every node, the lines lead to each listed parent's node (R31, A31)", () => {
  for (const name of LOGS) {
    const commits = commitsOf(name);
    const rows = layout(commits);
    const rowOf = new Map(commits.map((c, i) => [c.id, i]));
    for (const [i, c] of commits.entries()) {
      const got = reached(rows, i);
      for (const p of c.parents) {
        const pr = rowOf.get(p);
        if (pr !== undefined) assert.ok(got.has(pr), `${name}: ${c.subject} to its parent on row ${pr}\n${draw(rows).join("\n")}`);
      }
    }
  }
});

test("each lane keeps one column for its whole length, and runs on to the last row when its commit is not loaded (R31, A31)", () => {
  for (const name of LOGS) {
    const rows = layout(commitsOf(name));
    const cols = new Map<number, Set<number>>();
    for (const row of rows) for (const [x, c] of row.entries()) if (c.lane !== null) cols.set(c.lane, (cols.get(c.lane) ?? new Set()).add(x));
    for (const [lane, xs] of cols) {
      assert.equal(xs.size, 1, `${name}: lane ${lane} in columns ${[...xs]}`);
      assert.equal([...xs][0] % 2, 0, "lanes sit on even cells, gaps on odd ones");
    }
  }
  // The diverged history without its base: both lanes wait for a commit not
  // loaded, and run down to the last row.
  const rows = layout(commitsOf("diverged").slice(0, 3));
  assert.deepEqual(draw(rows), ["●", "●", "│ ●"]);
  // The cross history cut before `a`: x1's lane runs past every row below it.
  assert.deepEqual(draw(layout(commitsOf("cross").slice(0, 6))), ["○─╮", "│ ●", "○─┼─╮", "│ │ ●", "● │ │", "●─┼─╯"]);
});

test("lanes in neighbouring columns differ in colour, one of five (R31, A31)", () => {
  for (const name of LOGS) {
    const rows = layout(commitsOf(name));
    for (const [i, row] of rows.entries()) {
      for (let x = 0; x + 2 < row.length; x += 2) {
        const a = row[x];
        const b = row[x + 2];
        if (a.lane !== null && b.lane !== null && a.lane !== b.lane) assert.notEqual(a.color, b.color, `${name} row ${i} columns ${x}, ${x + 2}`);
      }
      for (const c of row) if (c.color !== null) assert.ok(c.color >= 0 && c.color < LANE_COLORS);
    }
    // A lane is one colour along its length.
    const colorOf = new Map<number, number>();
    for (const row of rows) for (const c of row) if (c.lane !== null && c.color !== null) assert.equal(colorOf.get(c.lane) ?? c.color, colorOf.set(c.lane, c.color).get(c.lane));
  }
});

test("the drawn rows of the recordings (A31)", () => {
  // feat's lane leaves M's node, runs beside main's through f2 and f1, and
  // joins c2's node.
  assert.deepEqual(draw(layout(commitsOf("a30"))), ["●", "○─╮", "│ ●", "│ ●", "● │", "●─╯", "●"]);
  // Two merges whose lanes cross.
  assert.deepEqual(draw(layout(commitsOf("cross"))), ["○─╮", "│ ●", "○─┼─╮", "│ │ ●", "● │ │", "●─┼─╯", "●─╯"]);
  assert.deepEqual(draw(layout(commitsOf("octopus"))), ["○─┬─┬─╮", "│ │ │ ●", "│ │ ● │", "│ ● │ │", "● │ │ │", "●─┴─┴─╯"]);
  // Two roots: each ends only its own lane.
  assert.deepEqual(draw(layout(commitsOf("roots"))), ["○─╮", "│ ●", "│ ●", "●", "●"]);
  // A shallow boundary is drawn as a root: no line below it.
  assert.deepEqual(draw(layout(commitsOf("shallow"))), ["●", "●"]);
  assert.deepEqual(draw(layout(commitsOf("diverged"))), ["●", "●", "│ ●", "●─╯"]);
});

test("a new lane takes the lowest free slot, also left of the node; a slot freed on a row waits for the next (R31)", () => {
  const c = (id: string, ...parents: string[]) => ({ id, parents });
  // The tip m takes slot 1, next to t1's lane; its second parent's lane the
  // next free slot, 2. Lanes freed at r and a leave blanks, not shifts.
  const rows = layout([c("t1", "r"), c("m", "a", "b"), c("r"), c("a"), c("b")]);
  assert.deepEqual(draw(rows), ["●", "│ ○─╮", "● │ │", "  ● │", "    ●"]);
  // t1's lane ends at the root r; the next row's merge opens its second
  // parent's lane in that freed slot, left of its node.
  const rows2 = layout([c("t1", "r"), c("t2", "m"), c("r"), c("m", "a", "b"), c("a"), c("b")]);
  assert.deepEqual(draw(rows2), ["●", "│ ●", "● │", "╭─○", "│ ●", "●"]);
});
