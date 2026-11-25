// The Graph's lanes (R31): one text row per commit, after VS Code's Source
// Control Graph (`scmHistory.ts:293-404`, INV §12.3), ported to fixed slots.
//
// A lane waits for one commit. For each commit, in the log's topological
// order:
// - its node goes in the lowest slot whose lane waits for it, or, for a
//   branch tip, in a new lane in the lowest free slot;
// - the other lanes waiting for it converge into the node on its row (`╯`,
//   `╰`) and end;
// - its lane then waits for its first parent; each further parent gets a new
//   lane in the lowest free slot, joined to the node on its row (`╮`, `╭`);
// - a root commit, or a shallow boundary with no parents listed, ends only
//   its own lane (VS Code ends every lane there, which breaks with several
//   roots);
// - a lane whose commit is not loaded yet runs to the last row.
//
// A lane keeps its slot from the row it starts on to the row it ends on, and
// a slot freed on a row is not reused on that row, so each cell holds one
// glyph. VS Code shifts lanes sideways inside a row, which text cannot draw
// (spec, decisions). Each slot is two cells: the lane's, and the gap to the
// right of it, where a horizontal line passes.

/** The rainbow colours lanes take, by index (`editor.bracket_rainbow_1` …
 *  `_5`): `_5` and `_6` look the same in the dark theme (INV §8 P36 g). */
export const LANE_COLORS = 5;

/** One cell of a row's graph. `lane` is the lane drawn in it (a vertical, a
 *  node, a lane ending or starting there, or the vertical a horizontal
 *  crosses), else null. `color` indexes the lane colours; null for a blank. */
export interface Cell {
  text: string;
  color: number | null;
  lane: number | null;
}

/** What `layout` needs of a commit. */
export interface LaneCommit {
  id: string;
  parents: string[];
}

interface Lane {
  id: number;
  color: number;
  /** The commit this lane runs down to. */
  wait: string;
}

const BLANK: Cell = { text: " ", color: null, lane: null };

/** The lowest colour neither neighbour uses (`used`), so lanes in
 *  neighbouring columns differ (R31). */
function pickColor(used: (number | null)[]): number {
  for (let c = 0; c < LANE_COLORS; c++) if (!used.includes(c)) return c;
  return 0;
}

/** The cells of each commit's row, one row per commit, in order. Trailing
 *  blank cells are left out. */
export function layout(commits: LaneCommit[]): Cell[][] {
  const slots: (Lane | null)[] = [];
  let nextLane = 0;
  const rows: Cell[][] = [];
  for (const c of commits) {
    // Lanes drawn on this row, by slot: those present before it, and those
    // it starts. Slots freed on this row stay taken until the next one.
    const drawn: (Lane | null)[] = [...slots];
    const lowestFree = (): number => {
      let s = 0;
      while (s < drawn.length && drawn[s] !== null) s++;
      return s;
    };
    const colorAt = (s: number): number | null => drawn[s]?.color ?? null;
    const start = (wait: string): number => {
      const s = lowestFree();
      const lane: Lane = { id: nextLane++, color: pickColor([colorAt(s - 1), colorAt(s + 1)]), wait };
      drawn[s] = lane;
      slots[s] = lane;
      return s;
    };

    const waiting = slots.flatMap((l, s) => (l !== null && l.wait === c.id ? [s] : []));
    const node = waiting.length > 0 ? waiting[0] : start(c.id);
    const nodeLane = drawn[node]!;
    const converging = waiting.slice(1);
    for (const s of converging) slots[s] = null;
    // The node's lane runs on to the first parent; a root ends it.
    if (c.parents.length > 0) nodeLane.wait = c.parents[0];
    else slots[node] = null;
    const opening = c.parents.slice(1).map((p) => start(p));

    // Lines that join the node on this row, by target slot.
    const targets = new Map<number, "end" | "start">([...converging.map((s) => [s, "end"] as const), ...opening.map((s) => [s, "start"] as const)]);
    const right = [...targets.keys()].filter((s) => s > node);
    const left = [...targets.keys()].filter((s) => s < node);
    const maxRight = right.length > 0 ? Math.max(...right) : node;
    const minLeft = left.length > 0 ? Math.min(...left) : node;
    /** The colour of the horizontal at slot `s` (or the gap right of it, when
     *  `gap`): that of the nearest target at or beyond it, away from the node. */
    const hColor = (s: number, gap: boolean): number => {
      const beyond = s >= node ? right.filter((t) => t >= (gap ? s + 1 : s)) : left.filter((t) => t <= s);
      const t = s >= node ? Math.min(...beyond) : Math.max(...beyond);
      return drawn[t]!.color;
    };

    const width = Math.max(drawn.length, maxRight + 1);
    const row: Cell[] = [];
    for (let s = 0; s < width; s++) {
      const lane = drawn[s] ?? null;
      const across = (s > node && s < maxRight) || (s < node && s > minLeft);
      const kind = targets.get(s);
      let cell: Cell;
      if (s === node) cell = { text: c.parents.length > 1 ? "○" : "●", color: nodeLane.color, lane: nodeLane.id };
      else if (kind === "end") cell = { text: across ? "┴" : s > node ? "╯" : "╰", color: lane!.color, lane: lane!.id };
      else if (kind === "start") cell = { text: across ? "┬" : s > node ? "╮" : "╭", color: lane!.color, lane: lane!.id };
      else if (lane !== null) cell = { text: across ? "┼" : "│", color: lane.color, lane: lane.id };
      else cell = across ? { text: "─", color: hColor(s, false), lane: null } : BLANK;
      row.push(cell);
      // The gap right of slot s.
      const gapAcross = (s >= node && s < maxRight) || (s < node && s >= minLeft);
      row.push(gapAcross ? { text: "─", color: hColor(s, true), lane: null } : BLANK);
    }
    while (row.length > 0 && row[row.length - 1].lane === null && row[row.length - 1].text === " ") row.pop();
    rows.push(row);
    while (slots.length > 0 && slots[slots.length - 1] === null) slots.pop();
  }
  return rows;
}
