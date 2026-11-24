// The side-by-side diff of one row (R14): which two versions it compares,
// when it is refused, its tab title, and the one slot that keeps at most one
// diff view open.

import { dirReason, nameReason } from "./actions.ts";
import { utf8Length } from "./stage.ts";
import { unpassable, type Entry } from "./status.ts";
import type { Group } from "./view.ts";

/** One side of a diff: nothing, a git object (`:0:<p>`, `HEAD:<p>`), or the
 *  working-tree file (repository-relative). */
export type Side = { kind: "empty" } | { kind: "blob"; spec: string } | { kind: "worktree"; path: string };

const EMPTY: Side = { kind: "empty" };

/** Conflict states whose "ours" side (HEAD's) has no version of the path:
 *  deleted by both, deleted by us, added by them. */
const OURS_ABSENT = new Set(["DD", "DU", "UA"]);

/** The index version: always stage 0. `:<p>` would read a path such as
 *  `1:x` as stage 1 of `x`. */
const indexBlob = (p: string): Side => ({ kind: "blob", spec: `:0:${p}` });
const headBlob = (p: string): Side => ({ kind: "blob", spec: `HEAD:${p}` });

/**
 * The left and right side of a row's diff (R14, INV §9.4). `unborn`: the
 * branch has no commits, so there is no HEAD version of anything.
 *
 * - Changes: the index (left) against the working tree (right). An
 *   untracked or intent-to-add path has nothing staged (left empty); a
 *   Changes `R`/`C` is a rename onto an intent-to-add path, so the same.
 * - Conflicted (Changes `!`): HEAD (left, empty when ours lacks the path)
 *   against the working tree with its markers.
 * - Staged: HEAD (left; the original path for a rename or copy; empty for an
 *   add) against the index (right; empty for a staged deletion).
 *
 * A working-tree side whose file is gone is read as empty (see `readSide`
 * in the wiring), so a deleted path diffs against an empty right side.
 */
export function sides(entry: Entry, group: Group, unborn: boolean): { left: Side; right: Side } {
  const p = entry.path;
  if (group === "changes") {
    const right: Side = { kind: "worktree", path: p };
    if (entry.marker === "!") {
      const absent = unborn || (entry.conflict !== undefined && OURS_ABSENT.has(entry.conflict));
      return { left: absent ? EMPTY : headBlob(p), right };
    }
    if (entry.marker === "U" || entry.marker === "A" || entry.marker === "R" || entry.marker === "C") {
      return { left: EMPTY, right };
    }
    return { left: indexBlob(p), right };
  }
  const left: Side =
    unborn || entry.marker === "A"
      ? EMPTY
      : headBlob((entry.marker === "R" || entry.marker === "C") && entry.orig !== undefined ? entry.orig : p);
  const right: Side = entry.marker === "D" ? EMPTY : indexBlob(p);
  return { left, right };
}

/** Largest side shown (R14): bounds the text moved through the bridge. */
export const MAX_DIFF_BYTES = 5 * 1024 * 1024;

/** Why a row's diff or one of its sides is not shown: a side is `binary`,
 *  `unreadable` (a working-tree file `readFile` gave no text for: not UTF-8,
 *  or not readable at all; it does not say which) or `too large`; a row is
 *  a `directory`, has an `unpassable name` or is a `symbolic link`
 *  (`rowRefusal`). */
export type Refusal = "binary" | "unreadable" | "too large" | "directory" | "unpassable name" | "symbolic link";

/** Whether a side of `size` bytes is too large to read (R14). Both kinds
 *  of side ask this before reading: the working-tree file by its
 *  `fileStat` size, a git object by `cat-file -s`. */
export function sizeRefusal(size: number): Refusal | null {
  return size > MAX_DIFF_BYTES ? "too large" : null;
}

/** Why a side's text cannot be shown, once read (its size passed
 *  `sizeRefusal`): `text` null (not readable as UTF-8) or with a NUL byte
 *  is binary (R14). */
export function refusal(text: string | null): Refusal | null {
  return text === null || text.includes("\0") ? "binary" : null;
}

/**
 * `refusal` for a git object's side, whose `size` is `cat-file -s`'s. Its
 * text is also binary when it is not `size` bytes of UTF-8: Fresh decodes
 * a process's stdout lossily through `runOnTarget` (bad bytes become
 * U+FFFD) and gives "" with exit 0 through `spawnHostProcess` (INV §8,
 * Review fixes), so a blob that is not UTF-8 comes back as some other text.
 */
export function blobRefusal(text: string, size: number): Refusal | null {
  return refusal(text) ?? (utf8Length(text) === size ? null : "binary");
}

/**
 * Why a row's diff is refused before anything is read, in this order:
 *
 * - a directory (a submodule or nested repository);
 * - a name that is not UTF-8, its path or its original path, whatever the
 *   marker: git and the file API cannot find it (F6);
 * - a Changes or conflicted row whose working-tree file is a symbolic link.
 *   `fileStat` and `readFile` follow links, and the API has no `lstat` or
 *   `readlink`, so the right side would be the target's contents, not the
 *   link (R14). A Staged row compares HEAD with the index, which hold the
 *   link text.
 */
export function rowRefusal(entry: Entry, group: Group): Refusal | null {
  if (entry.dir) return "directory";
  if ([entry.path, entry.orig].some((p) => p !== undefined && unpassable(p))) return "unpassable name";
  return group === "changes" && entry.link === true ? "symbolic link" : null;
}

/** The status message for a refused diff of `path` (R14). */
export function refusalMessage(path: string, why: Refusal): string {
  if (why === "directory") return dirReason(path);
  if (why === "unpassable name") return nameReason(path);
  if (why === "too large") return `${path} is larger than 5 MiB; no diff shown`;
  if (why === "unreadable") return `${path} is binary or could not be read; no diff shown`;
  return `${path} is ${why === "binary" ? "binary" : "a symbolic link"}; no diff shown`;
}

/** What a row's diff compares, by its group and, in Changes, the `!`
 *  marker: the tab title's words and the pane labels, left and right. */
const COMPARISON: Record<"staged" | "conflicted" | "changes", { what: string; panes: [string, string] }> = {
  staged: { what: "HEAD ↔ staged", panes: ["HEAD", "Staged"] },
  conflicted: { what: "HEAD ↔ working tree", panes: ["HEAD", "Working tree"] },
  changes: { what: "staged ↔ working tree", panes: ["Staged", "Working tree"] },
};

function comparison(group: Group, entry: Entry): { what: string; panes: [string, string] } {
  return COMPARISON[group === "staged" ? "staged" : entry.marker === "!" ? "conflicted" : "changes"];
}

/** The tab title: the file and the comparison (R14). */
export function tabTitle(path: string, group: Group, entry: Entry): string {
  return `${path} (${comparison(group, entry).what})`;
}

/** The pane labels, left and right, for the same comparison. */
export function paneLabels(group: Group, entry: Entry): [string, string] {
  return [...comparison(group, entry).panes];
}

/** A diff source buffer's name, `*<label>:<path>*` with no space (R21).
 *  Fresh picks a virtual buffer's grammar from its name: it strips the
 *  `*`s and takes the text after the last `:` (`detected_language.rs:
 *  229-240`, INV §10.2), so the path, or for a path that holds a `:` its
 *  last part, is looked up by file name and extension, as when the file is
 *  opened. A space there hid every file known by its name alone, such as a
 *  root `Makefile` (INV §8 P26). The labels hold no `:` (`COMPARISON`). No
 *  first line goes with the name, so a file known only by its shebang
 *  stays plain. */
export function sourceName(label: string, path: string): string {
  return `*${label}:${path}*`;
}

/** `content` without the trailing newline, as one span, for a composite
 *  source buffer. A final newline otherwise adds a phantom last line with no
 *  view line in the composite. Applied once, to the same text that goes to
 *  `computeLineDiff`: the host's line diff keeps each line's newline, so
 *  its line indices are this text's lines, and a change to the final
 *  newline alone is still a hunk (`fresh-core/src/diff.rs:36-55`).
 *  Vendored from Fresh 0.5.9's `audit_mode.ts:5124-5141` (`contentToLines`
 *  and `contentToEntries`): built-in plugin helpers cannot be imported.
 *  Their split, pop and join only ever drop one trailing "\n", so that is
 *  all this does. */
export function contentToText(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

export function contentToEntries(content: string): { text: string }[] {
  const text = contentToText(content);
  return text.length > 0 ? [{ text }] : [];
}

/** The lines a text shows in a buffer: none for "", and a final newline
 *  adds no line (`contentToText`). The same count a diff source has. */
export function lineCount(text: string): number {
  const shown = contentToText(text);
  return shown === "" ? 0 : shown.split("\n").length;
}

/** A line hunk as `computeLineDiff` returns it and `createCompositeBuffer`
 *  takes it. `ops` (one char per line: `' '`, `'-'`, `'+'`) makes the host
 *  build the rows from it alone. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  ops?: string;
}

/** The hunks to align the composite with. A side whose buffer is empty
 *  (added, untracked, deleted, or a file that is just a newline) counts as
 *  one line in Fresh 0.5.9 but draws none. Built from plain line hunks, the
 *  alignment then gets a row for that phantom line 0, and every frame logs
 *  "ViewLine missing for composite buffer" and bumps the status bar's
 *  warning count (`composite_buffer.rs:251-375`, INV §8 P22). So for an
 *  empty side, one hunk covers the phantom line with its count while `ops`
 *  lists only the other side's real lines.
 *
 *  `lineDiff` (the host's `computeLineDiff` of the two texts) is called
 *  only when both sides have lines: an empty side's hunk needs no line
 *  diff, and the call would copy the other side, up to 5 MiB, through the
 *  bridge for nothing (untracked, added and deleted files, an unborn
 *  branch). */
export function compositeHunks(leftText: string, rightText: string, lineDiff: () => Hunk[]): Hunk[] {
  const left = lineCount(leftText);
  const right = lineCount(rightText);
  if (left === 0 && right === 0) return [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: 1, ops: "" }];
  if (left === 0) return [{ oldStart: 0, oldCount: 1, newStart: 0, newCount: right, ops: "+".repeat(right) }];
  if (right === 0) return [{ oldStart: 0, oldCount: left, newStart: 0, newCount: 1, ops: "-".repeat(left) }];
  return lineDiff();
}

/** The buffers of one diff view: the composite tab and its two hidden
 *  sources; and, for Enter in it (R19), the row it is for, the hunks it was
 *  aligned with and the right side's line count. */
export interface View {
  composite: number;
  left: number;
  right: number;
  key: string;
  hunks: Hunk[];
  rightLines: number;
}

/**
 * The 0-based line on the diff's right side that Enter goes to (R19), from
 * `getCompositeCursorInfo().lines` (each pane's line on the cursor's row,
 * null where the pane shows none; INV §8 P25 c), or null for the file's
 * last line. The right side is the working tree for a Changes or
 * conflicted row and the staged version for a Staged row, so either way it
 * is the line R19 names.
 *
 * - The row shows a right line: that line.
 * - It shows only a left line (a removed line): the next right line. Without
 *   `ops`, the host pairs a hunk's lines by position
 *   (`composite_buffer.rs:314-350`), so a row with no right line is at an
 *   offset of at least `newCount` in its hunk, and the next right line is
 *   `newStart + newCount`, when the right side has one.
 * - Otherwise (no such line, or the hunk covers an empty side through
 *   `ops`, `compositeHunks`): null, the last line.
 */
export function targetLine(lines: (number | null)[], hunks: Hunk[], rightLines: number): number | null {
  const [left, right] = lines;
  if (right !== null && right !== undefined) return right;
  if (left === null || left === undefined) return null;
  const h = hunks.find((x) => left >= x.oldStart && left < x.oldStart + x.oldCount);
  if (h === undefined) return null;
  const next = h.newStart + h.newCount;
  return next < rightLines ? next : null;
}

/**
 * The 1-based line `openFile` gets for the 0-based `target` (null: the last
 * line) in a text of `count` lines, or null to open with no jump. Past a
 * buffer's end the host jumps to line 1 (`file_open_orchestrators.rs:
 * 223-245`), so the line is clamped to the last one; an empty text gives
 * line 1. With the count unknown (`readFile` gives no text for a file that
 * is not UTF-8), `target` is passed as it is, and the last line becomes no
 * jump.
 */
export function openLine(target: number | null, count: number | null): number | null {
  if (count === null) return target === null ? null : target + 1;
  if (count === 0) return 1;
  return Math.min(target ?? count - 1, count - 1) + 1;
}

/** The status message shown when a diff opens (R20): Fresh's own keys for
 *  a side-by-side view (INV §8 P25), and Enter (R19). Short: at 140
 *  columns, with the explorer shown, the status bar cuts a message after
 *  about 70 characters, and a longer hint lost its `q/Esc`. */
export const DIFF_HINT = "n/] next change, p/[ previous, Enter open file, q/Esc close";

/**
 * The one diff slot (R14 "one tab"). Each build gets a generation; a build
 * that is no longer current discards what it made. A build asked for the
 * key a pending build is already for joins it (a double-click delivers
 * clicks and then an Enter, INV §9.1).
 */
export class DiffSlot {
  private gen = 0;
  private pending: { key: string; gen: number } | null = null;
  private view: View | null = null;

  /** Start a build for `key`: its generation, or null when it joins the
   *  pending build for the same key. */
  begin(key: string): number | null {
    if (this.pending !== null && this.pending.key === key) return null;
    this.pending = { key, gen: ++this.gen };
    return this.gen;
  }

  isCurrent(gen: number): boolean {
    return gen === this.gen;
  }

  /** The build `gen` ended, shown or not. */
  done(gen: number): void {
    if (this.pending?.gen === gen) this.pending = null;
  }

  /** Every pending build is stale (an authority change, the end, or a
   *  later click whose row is refused before any build). */
  invalidate(): void {
    this.gen++;
    this.pending = null;
  }

  /** The view shown now, or null. */
  current(): View | null {
    return this.view;
  }

  /** `view` is shown now; the view it replaces, to be closed. */
  install(view: View): View | null {
    const prev = this.view;
    this.view = view;
    return prev;
  }

  /** Buffer `id` closed (the user closed the tab, or something closed a
   *  source): the current view's composite, whose state only
   *  `closeCompositeBuffer` drops (INV §9.4), and its other buffers, to be
   *  closed too; null when `id` is not part of it. */
  onClosed(id: number): { composite: number; rest: number[] } | null {
    const v = this.view;
    if (v === null || (id !== v.composite && id !== v.left && id !== v.right)) return null;
    this.view = null;
    return { composite: v.composite, rest: [v.composite, v.left, v.right].filter((b) => b !== id) };
  }
}
