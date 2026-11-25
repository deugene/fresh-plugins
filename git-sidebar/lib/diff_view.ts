// The diff view as a buffer group (R38, R39, INV §13.3): which panes it
// shows, its layout, the decorations of a two-pane diff, and moves through
// its changes. Pure: the wiring hands in what `compareBuffers` answered and
// applies what comes back. Written from the behaviour INV §13.3 and §8
// P41/P42 record; nothing here comes from Fresh's own plugins (GPL).
//
// Imports nothing from `diff.ts`, which imports this: no cycle (CLAUDE.md).

/** One side of a `compareBuffers` hunk, the fields read here (the type
 *  file's `CompareSide`): its lines, its byte range, where a jump puts the
 *  cursor, each line's text range, and for paired lines the part that
 *  differs (null: only the terminator does). */
export interface CompareSideLike {
  start: number;
  count: number;
  from: number;
  to: number;
  jump: number;
  lines: [number, number][];
  spans: ([number, number] | null)[];
}

export interface CompareHunkLike {
  left: CompareSideLike;
  right: CompareSideLike;
  eolOnly: boolean;
}

/** What `compareBuffers` answers, the fields read here. */
export interface CompareLike {
  hunks: CompareHunkLike[];
  leftLen: number;
  rightLen: number;
}

export type PaneSide = "left" | "right";

/** Which panes a diff shows (R38 "One side"): both, or only the side that
 *  has text. A zero-byte side gets no pane: Fresh 0.5.9 draws no filler rows
 *  in an empty buffer, and pairing an empty left side scrolls the right pane
 *  past its end (INV §8 P42 b). Both empty: the right side's pane. Decided
 *  from the texts' lengths, before any buffer is made. */
export type PaneSides = "both" | PaneSide;

export function paneSides(leftLen: number, rightLen: number): PaneSides {
  if (leftLen === 0) return "right";
  if (rightLen === 0) return "left";
  return "both";
}

/** The lines of `text` as the host counts them for a diff: each keeps its
 *  `\n`, and a final unterminated segment is a line (H17); "" has none. */
export function lineTotal(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text === "" || text.endsWith("\n") ? n : n + 1;
}

/** Where a hunk is on one side, for moving through it and for Enter. */
export interface ViewSide {
  start: number;
  count: number;
  /** The byte a move to the hunk puts this side's cursor on. */
  jump: number;
}

export interface ViewHunk {
  left: ViewSide;
  right: ViewSide;
}

const viewSide = (s: CompareSideLike): ViewSide => ({ start: s.start, count: s.count, jump: s.jump });

/** The hunks a two-pane diff moves through (R20, R29) and maps Enter by
 *  (R19), from `compareBuffers`. */
export function viewHunks(result: CompareLike): ViewHunk[] {
  return result.hunks.map((h) => ({ left: viewSide(h.left), right: viewSide(h.right) }));
}

/** A one-pane diff's hunks (R38 "One side"): one hunk over the whole shown
 *  side, the other side none, so `stepHunk` finds nothing past it and
 *  `facingLine` maps the right pane to itself and the left pane to no line
 *  (R19 "a deleted file"). None for an empty pane. */
export function onePaneHunks(side: PaneSide, lines: number): ViewHunk[] {
  if (lines === 0) return [];
  const shown: ViewSide = { start: 0, count: lines, jump: 0 };
  const none: ViewSide = { start: 0, count: 0, jump: 0 };
  return [side === "left" ? { left: shown, right: none } : { left: none, right: shown }];
}

/** The panel ids of a diff's group: a header above each scrollable pane
 *  (R38 "Each pane"). */
export function headerPanel(side: PaneSide, sides: PaneSides): string {
  return sides === "both" ? `${side}Header` : "header";
}

/** The group layout (`createBufferGroup`): each shown source under a
 *  one-row header, side by side for two panes (INV §8 P42 a, l). Each
 *  scrollable leaf borrows its source (`bufferId`), the panel id being its
 *  side. A fixed leaf's split ratio is ignored. */
export function diffLayout(left: number | null, right: number | null): string {
  const pane = (side: PaneSide, bufferId: number, header: string) => ({
    type: "split",
    direction: "v",
    ratio: 0.05,
    first: { type: "fixed", id: header, height: 1 },
    second: { type: "scrollable", id: side, bufferId },
  });
  if (left !== null && right !== null) {
    return JSON.stringify({ type: "split", direction: "h", ratio: 0.5, first: pane("left", left, "leftHeader"), second: pane("right", right, "rightHeader") });
  }
  if (left !== null) return JSON.stringify(pane("left", left, "header"));
  if (right !== null) return JSON.stringify(pane("right", right, "header"));
  throw new Error("diffLayout: no pane");
}

/** A header panel's content: the side's label (R38 "Each pane"). */
export function headerEntries(label: string): { text: string }[] {
  return [{ text: ` ${label}` }];
}

/** RGB, as `setLineIndicators` and `setScrollbarMarkers` take it. */
export type Rgb = [number, number, number];

/** The red and green of R39 (and of R38's gutter marks), those of Fresh's
 *  live_diff and Compare Files (INV §13.3). */
export const RED: Rgb = [220, 90, 90];
export const GREEN: Rgb = [80, 200, 120];

/** Theme keys of R38's tints (R38 "Changes"). */
const LINE_BG = { left: "editor.diff_remove_bg", right: "editor.diff_add_bg" } as const;
const SPAN_BG = { left: "editor.diff_remove_highlight_bg", right: "editor.diff_add_highlight_bg" } as const;

/** Blank rows facing the other side's lines: `count` empty virtual lines at
 *  byte `anchor`, above it or below its line. */
export interface Filler {
  anchor: number;
  above: boolean;
  count: number;
}

/** A scrollbar mark (`ScrollbarMarker`): a point, or a range whose `end` is
 *  exclusive. */
export interface Marker {
  position: number;
  end?: number;
  color: Rgb;
}

/** Everything one pane of a two-pane diff draws (R38, R39). */
export interface SidePaint {
  /** Changed lines' background, `[start, end)` bytes. */
  lines: [number, number][];
  lineBg: string;
  /** The changed parts of paired lines. */
  spans: [number, number][];
  spanBg: string;
  /** Blank rows facing the other side's lines, tinted with that side's
   *  colour. */
  fillers: Filler[];
  fillerBg: string;
  /** 0-based lines marked in the gutter. */
  gutter: number[];
  gutterSymbol: string;
  gutterColor: Rgb;
  markers: Marker[];
}

export interface Paint {
  left: SidePaint;
  right: SidePaint;
  /** `[leftLine, rightLine]` at each hunk's end, for
   *  `setScrollSyncAnchors` (R38 "Together"). */
  anchors: [number, number][];
}

/**
 * The decorations of a two-pane diff (R38 "Changes", R39), from
 * `compareBuffers`' answer, each side's length in bytes included.
 *
 * - Each changed line's background in its side's tint; an empty line still
 *   gets one byte, so it shows.
 * - A paired line's differing part in the stronger tint; none where only
 *   the terminator differs (an `eolOnly` hunk, or a null span: P42 i).
 * - Blank rows where the other side has more lines, under my last line of
 *   the hunk, else under the line before the gap (`jump`), else above byte 0
 *   at the top (the side is not empty: an empty side has no pane, P42 b).
 * - `-` in red on the left, `+` in green on the right, on each changed line.
 * - A scrollbar mark per hunk: a range over its lines in the side's colour,
 *   at least one cell; a side with no lines gets a one-cell mark at the
 *   seam, in the other side's colour, so each scrollbar shows every change
 *   (R39).
 */
export function paint(result: CompareLike): Paint {
  const side = (mine: PaneSide): SidePaint => {
    const other: PaneSide = mine === "left" ? "right" : "left";
    const len = mine === "left" ? result.leftLen : result.rightLen;
    const out: SidePaint = {
      lines: [],
      lineBg: LINE_BG[mine],
      spans: [],
      spanBg: SPAN_BG[mine],
      fillers: [],
      fillerBg: LINE_BG[other],
      gutter: [],
      gutterSymbol: mine === "left" ? "-" : "+",
      gutterColor: mine === "left" ? RED : GREEN,
      markers: [],
    };
    for (const h of result.hunks) {
      const s = h[mine];
      const t = h[other];
      const paired = Math.min(s.count, t.count);
      for (let k = 0; k < s.count; k++) {
        const [a, b] = s.lines[k];
        out.lines.push([a, Math.max(b, Math.min(a + 1, len))]);
        out.gutter.push(s.start + k);
        const span = k < paired && !h.eolOnly ? s.spans[k] : null;
        if (span !== null && span !== undefined && span[1] > span[0]) out.spans.push(span);
      }
      if (t.count > s.count) {
        const count = t.count - s.count;
        if (s.count > 0) out.fillers.push({ anchor: s.lines[s.count - 1][0], above: false, count });
        else if (s.start > 0) out.fillers.push({ anchor: s.jump, above: false, count });
        else out.fillers.push({ anchor: 0, above: true, count });
      }
      if (s.count > 0) {
        const end = Math.max(s.to - 1, s.from);
        out.markers.push(end > s.from ? { position: s.from, end, color: out.gutterColor } : { position: s.from, color: out.gutterColor });
      } else {
        out.markers.push({ position: Math.min(s.from, Math.max(0, len - 1)), color: mine === "left" ? GREEN : RED });
      }
    }
    return out;
  };
  return {
    left: side("left"),
    right: side("right"),
    anchors: result.hunks.map((h) => [h.left.start + h.left.count, h.right.start + h.right.count]),
  };
}

/**
 * The hunk a move to the next (`dir` 1) or previous (-1) change goes to,
 * from the cursor at byte `pos` on `side`: the first hunk whose jump is past
 * it, or the last one before it. Null at the end: no wrap-around (R20, R29).
 * With the cursor still on hunk `at`'s jump (the hunk the cursors were last
 * put on), the hunk beside it: hunks with no lines on `side` can share a
 * jump there (two insertions around one line), and the byte alone would
 * skip all but one.
 */
export function stepHunk(hunks: ViewHunk[], side: PaneSide, pos: number, dir: 1 | -1, at: number | null = null): number | null {
  if (at !== null && hunks[at]?.[side].jump === pos) {
    const i = at + dir;
    return i >= 0 && i < hunks.length ? i : null;
  }
  if (dir === 1) {
    const i = hunks.findIndex((h) => h[side].jump > pos);
    return i === -1 ? null : i;
  }
  for (let i = hunks.length - 1; i >= 0; i--) if (hunks[i][side].jump < pos) return i;
  return null;
}

/** The 0-based line to bring into view for a hunk's side: its first line,
 *  or for a side with none the line before the gap, where its blank rows
 *  are. */
export function centreLine(s: ViewSide): number {
  return s.count > 0 ? s.start : Math.max(0, s.start - 1);
}

/**
 * The right side's 0-based line facing line `line` of `side` (R19 "Either
 * pane"), or null for the file's last line. The right pane's own line is
 * the one. On the left, inside a hunk the lines pair by position: the k-th
 * left line faces the k-th right one, and a left line past the right's
 * count faces the next right line after the hunk (R19 "a row with no line
 * on that side"). Outside hunks, the line moves by what the hunks above it
 * added or removed. Past the right side's `rightLines` lines: null.
 */
export function facingLine(hunks: ViewHunk[], side: PaneSide, line: number, rightLines: number): number | null {
  if (side === "right") return line;
  let delta = 0;
  for (const h of hunks) {
    const { left: l, right: r } = h;
    if (line >= l.start && line < l.start + l.count) {
      const k = line - l.start;
      const to = k < r.count ? r.start + k : r.start + r.count;
      return to < rightLines ? to : null;
    }
    if (l.start + l.count <= line) delta += r.count - l.count;
  }
  const to = line + delta;
  return to < rightLines ? to : null;
}
