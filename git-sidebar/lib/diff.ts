// The side-by-side diff of one row (R14): which two versions it compares,
// when it is refused, its tab title, and the one slot that keeps at most one
// diff view open. How the view is laid out and decorated is diff_view.ts.

import { trimSlash } from "./git.ts";
import { utf8Length } from "./stage.ts";
import { badName, dirReason, nameReason, unpassable, type Entry } from "./status.ts";
import type { Group } from "./view.ts";
import type { PaneSide, ViewHunk } from "./diff_view.ts";

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

/**
 * What a diff view compares, whatever row asked for it (R14, R32): its row's
 * key, the file's path (repository-relative, for the tab and Enter's file,
 * R19), the two sides, their pane labels (no `:`, R21), the tab title, and
 * why it is refused before anything is read, with the name that refusal
 * names.
 */
export interface DiffTarget {
  key: string;
  path: string;
  left: Side;
  right: Side;
  labels: [string, string];
  title: string;
  refusal: Refusal | null;
  refusedName: string;
}

/** A Staged, Changes or conflicted row's diff (R14): today's `sides`,
 *  `paneLabels`, `tabTitle` and `rowRefusal`, unchanged. */
export function statusDiffTarget(entry: Entry, group: Group, unborn: boolean, key: string): DiffTarget {
  const path = trimSlash(entry.path);
  const { left, right } = sides(entry, group, unborn);
  return {
    key,
    path,
    left,
    right,
    labels: paneLabels(group, entry),
    title: tabTitle(path, group, entry),
    refusal: rowRefusal(entry, group),
    refusedName: badName(entry),
  };
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

/** `content` without the trailing newline, for View Commit's tab (R33),
 *  where a final newline would add an empty last line. Not for the diff's
 *  sources: they hold the exact texts, since `compareBuffers` keeps each
 *  line's newline and a change to the final newline alone is a change (H17,
 *  INV §8 P42 i). Only ever drops one trailing "\n". */
export function contentToText(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

export function contentToEntries(content: string): { text: string }[] {
  const text = contentToText(content);
  return text.length > 0 ? [{ text }] : [];
}

/** The lines a text shows in a file's tab, as `openFile` counts them for
 *  R19's clamp: none for "", and a final newline adds no line. */
export function lineCount(text: string): number {
  const shown = contentToText(text);
  return shown === "" ? 0 : shown.split("\n").length;
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

/** R29's messages: Next or Previous Change ran where it could not move. */
export const NO_NEXT_CHANGE = "no next change";
export const NO_PREVIOUS_CHANGE = "no previous change";
/** Next or Previous Change, or a key bound to it, outside a section diff. */
export const NO_SECTION_DIFF = "no diff from the Git section is the active tab";

/** The status message shown when a diff opens (R20): every key of the
 *  diff, Tab and Shift+Tab (`(S-)Tab`) and `j`/`k` included, and Enter
 *  (R19). Most needed first, as the status bar cuts it: at 140 columns,
 *  with the explorer shown, after about 70 characters, and after about 52
 *  beside a TypeScript file's language and LSP labels (INV §8 P43 c). Then
 *  only the pane and scroll keys are lost; a hint that ended with `q/Esc`
 *  lost that. */
export const DIFF_HINT = "q/Esc close, n/] next, p/[ prev, Enter file, (S-)Tab pane, j/k scroll";

/**
 * A diff view as a buffer group (R38, INV §13.3): the group (its id is the
 * window's), the sources it shows (null where a side has no pane, R38 "One
 * side"), those not yet reported closed (`open`: each is closed exactly
 * once, H14), the row it is for, the hunks it moves through (R20, R29) and
 * maps Enter by (R19), the hunk the cursors were last put on (`stepHunk`'s
 * `at`), the right side's line count, the host split it was shown in
 * (R37), and each pane's split.
 */
export interface View {
  group: number;
  left: number | null;
  right: number | null;
  open: Set<number>;
  key: string;
  hunks: ViewHunk[];
  at: number | null;
  rightLines: number;
  split: number;
  panelSplits: Partial<Record<PaneSide, number>>;
}

/** Which side buffer `id` is in `v`, or null when it is not one of its
 *  sources. */
export function sideOf(v: View, id: number): PaneSide | null {
  if (id === v.left) return "left";
  if (id === v.right) return "right";
  return null;
}

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

  /** A request that is not a build, View Commit (R33), is now the latest:
   *  every pending build is stale, and its generation is current until the
   *  next `begin`, `claim` or `invalidate`. */
  claim(): number {
    this.invalidate();
    return this.gen;
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

  /** Take `v` out if it is the view shown now (the plugin closes it: `q`,
   *  Esc, a replace): whether it was. Taken out first, so the closes it
   *  brings find no view (R14). */
  take(v: View): boolean {
    if (this.view !== v) return false;
    this.view = null;
    return true;
  }

  /** Source `id` reported closed (`buffer_closed`): it leaves its view's
   *  `open`. The view shown now, taken out, when `id` was one of its
   *  sources: its `open` holds the sources still to close. Null otherwise. */
  onClosed(id: number): View | null {
    const v = this.view;
    if (v === null || sideOf(v, id) === null) return null;
    v.open.delete(id);
    this.view = null;
    return v;
  }

  /** Group `groupId` of this window closed (`buffer_group_closed`): the
   *  view shown now, taken out, when it is that group's; null otherwise. */
  onGroupClosed(groupId: number): View | null {
    const v = this.view;
    if (v === null || v.group !== groupId) return null;
    this.view = null;
    return v;
  }
}
