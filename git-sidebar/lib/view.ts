// The section's tree: two groups of file rows built from a parsed status, a
// one-row notice, and the signature that tells whether anything changed.

import { trimSlash } from "./git.ts";
import type { Entry, Marker, Status } from "./status.ts";

export const TREE_KEY = "git";
export const STAGED_KEY = "g:s";
export const CHANGES_KEY = "g:c";
const NOTICE_KEY = "n:notice";
/** Rows listed per group before the `… K more` row (R11). */
export const ROW_CAP = 500;

const DIM = "editor.line_number_fg";

/** Theme keys only, resolved by the host at render time so a theme switch
 *  recolours the rows without a reload (R5). */
export const MARKER_COLOR: Record<Marker, string> = {
  M: "ui.file_status_modified_fg",
  T: "ui.file_status_modified_fg",
  A: "ui.file_status_added_fg",
  D: "ui.file_status_deleted_fg",
  R: "ui.file_status_renamed_fg",
  C: "ui.file_status_renamed_fg",
  U: "ui.file_status_untracked_fg",
  "!": "ui.file_status_conflicted_fg",
};

export interface Segment {
  text: string;
  style?: { fg: string };
}

export interface Node {
  text: { text: string; segments: Segment[] };
  depth: number;
  hasChildren: boolean;
  /** The row's one button, drawn `[ label ]` at its right edge; a press
   *  fires `action` (R5, R15, R16; INV §9.3). Absent on rows without one. */
  action?: string | null;
}

export interface TreeSpec {
  kind: "tree";
  key: string;
  nodes: Node[];
  itemKeys: string[];
  selectedIndex: number;
  expandedKeys: string[];
  checkable: boolean;
  itemHeight: number;
  cardBorders: boolean;
  indentCols: number;
  toggleOnClick: boolean;
}

/** What a row is, by its item key. */
export type RowKind = { kind: "group" } | { kind: "file"; path: string } | { kind: "inert" };

export function rowKind(key: string): RowKind {
  if (key === STAGED_KEY || key === CHANGES_KEY) return { kind: "group" };
  if (key.startsWith("s:") || key.startsWith("c:")) return { kind: "file", path: key.slice(2) };
  return { kind: "inert" };
}

/** The item key of a file row in the Staged (`s`) or Changes (`c`) group. */
function fileKey(prefix: "s" | "c", path: string): string {
  return `${prefix}:${path}`;
}

function node(segments: Segment[], depth: number, hasChildren: boolean): Node {
  return { text: { text: segments.map((s) => s.text).join(""), segments }, depth, hasChildren };
}

function fileNode(e: Entry): Node {
  const path = trimSlash(e.path);
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dir = slash < 0 ? "" : path.slice(0, slash);
  const fg = MARKER_COLOR[e.marker];
  const segments: Segment[] = [{ text: e.marker, style: { fg } }, { text: " " }, { text: name, style: { fg } }];
  if (dir) segments.push({ text: `  ${dir}`, style: { fg: DIM } });
  if (e.orig !== undefined) segments.push({ text: `  ← ${e.orig}`, style: { fg: DIM } });
  return node(segments, 1, false);
}

/** The button label of the row `key`, or null for none. */
export type ButtonLabel = (key: string) => string | null;

/** `n` with the button `label` gives the row `key`, if any. */
function withButton(n: Node, key: string, label: ButtonLabel | undefined): Node {
  const text = label?.(key) ?? null;
  if (text !== null) n.action = text;
  return n;
}

function group(
  label: string,
  key: string,
  prefix: "s" | "c",
  entries: Entry[] | null,
  nodes: Node[],
  keys: string[],
  button: ButtonLabel | undefined,
): void {
  const count = entries === null ? "" : ` ${entries.length}`;
  nodes.push(withButton(node([{ text: `${label}${count}` }], 0, true), key, entries === null ? undefined : button));
  keys.push(key);
  if (entries === null) return;
  for (const e of entries.slice(0, ROW_CAP)) {
    const k = fileKey(prefix, e.path);
    nodes.push(withButton(fileNode(e), k, button));
    keys.push(k);
  }
  if (entries.length > ROW_CAP) {
    nodes.push(node([{ text: `… ${entries.length - ROW_CAP} more`, style: { fg: DIM } }], 1, false));
    // `more:s` / `more:c`: no `s:` / `c:` prefix, so no file can have it.
    keys.push(`more:${prefix}`);
  }
}

/** Expansion and selection are left neutral: they only seed a (re)mount, and
 *  the caller that sends the spec owns them. */
function tree(nodes: Node[], itemKeys: string[]): TreeSpec {
  return {
    kind: "tree",
    key: TREE_KEY,
    nodes,
    itemKeys,
    selectedIndex: -1,
    expandedKeys: [],
    checkable: false,
    itemHeight: 1,
    // Not for cards: at `itemHeight` 1 no row is one, so the rows look the
    // same. In 0.5.9 the plain layout lays a `▌` mark over the selected row
    // of a sidebar tree, and that mark swallows every press on the row: its
    // body click, its `+`/`−` button and a right-click. `cardBorders` alone
    // picks the layout without the mark (INV §8 P21). The type file says it
    // acts only above `itemHeight` 1, so recheck this after a Fresh upgrade.
    cardBorders: true,
    // The sidebar is narrow: one column per level.
    indentCols: 1,
    toggleOnClick: true,
  };
}

/** The two groups, Staged first, both always present (R3). `status` null is
 *  the placeholder drawn before the first status arrives: the groups without
 *  counts, rows or buttons. `label` puts each row's `+`/`−` on it, group
 *  rows included (R5). */
export function buildTree(status: Status | null, label?: ButtonLabel): TreeSpec {
  const nodes: Node[] = [];
  const keys: string[] = [];
  group("Staged Changes", STAGED_KEY, "s", status ? status.staged : null, nodes, keys, label);
  group("Changes", CHANGES_KEY, "c", status ? status.changes : null, nodes, keys, label);
  return tree(nodes, keys);
}

export type Group = "staged" | "changes";

/** A file row's status entry and the group it is listed in. */
export interface Listed {
  entry: Entry;
  group: Group;
}

export type EntryMap = Map<string, Listed>;

/** Every file row's key (including rows past the cap), with its entry. */
export function entryMap(status: Status): EntryMap {
  const map: EntryMap = new Map();
  for (const entry of status.staged) map.set(fileKey("s", entry.path), { entry, group: "staged" });
  for (const entry of status.changes) map.set(fileKey("c", entry.path), { entry, group: "changes" });
  return map;
}

/** The group a row belongs to, by its key: the group row itself, its file
 *  rows and its `… N more` row. Null for any other row (a notice). */
function groupOf(key: string): string | null {
  if (key === STAGED_KEY || key.startsWith("s:") || key === "more:s") return STAGED_KEY;
  if (key === CHANGES_KEY || key.startsWith("c:") || key === "more:c") return CHANGES_KEY;
  return null;
}

/** Where a selected row sits: its group, and its offset among that group's
 *  rows (-1 for the group row itself). */
export interface Place {
  group: string | null;
  offset: number;
}

/** The place of `key` in `keys`, or null when it is not there. */
export function placeOf(keys: string[], key: string): Place | null {
  const idx = keys.indexOf(key);
  if (idx < 0) return null;
  const group = groupOf(key);
  if (group === null) return { group: null, offset: -1 };
  const g = keys.lastIndexOf(group, idx);
  return { group, offset: g < 0 ? -1 : idx - g - 1 };
}

/**
 * Where the selection belongs in `keys` (R10): its key's row while it is
 * listed. When it has gone, for example because staging moved the file to
 * the other group (R15), the row at the same offset in the same group,
 * clamped to that group's last row, or the group row when the group is
 * empty. So repeated Space works down a group, and a change in the other
 * group never moves the selection onto a group row. With no place to go by
 * (a notice was selected), the old index, clamped.
 */
export function reconcile(
  key: string | null,
  place: Place | null,
  index: number,
  keys: string[],
): { key: string | null; index: number } {
  if (key === null) return { key: null, index: -1 };
  const idx = keys.indexOf(key);
  if (idx >= 0) return { key, index: idx };
  if (place !== null && place.group !== null) {
    const g = keys.indexOf(place.group);
    if (g >= 0) {
      let end = g + 1;
      while (end < keys.length && groupOf(keys[end]) === place.group) end++;
      const rows = end - g - 1;
      if (rows === 0 || place.offset < 0) return { key: keys[g], index: g };
      const at = g + 1 + Math.min(place.offset, rows - 1);
      return { key: keys[at], index: at };
    }
  }
  const kept = Math.min(index, keys.length - 1);
  return kept >= 0 ? { key: keys[kept], index: kept } : { key: null, index: -1 };
}

export const VOLUME_NOTICE = "Sources are in a container volume; Fresh opens host files only";
export const UNKNOWN_NOTICE = "Can't tell whether this dev container's workspace is on the host — retrying";

/** A single inert row (R13 volume notice). */
export function noticeTree(text: string): TreeSpec {
  return tree([node([{ text, style: { fg: DIM } }], 0, false)], [NOTICE_KEY]);
}

/** Identity of what the section draws: the title and every row's key and
 *  text. Equal signatures mean a refresh can skip every widget call (R10). */
export function signature(title: string, spec: TreeSpec): string {
  return JSON.stringify({ title, keys: spec.itemKeys, nodes: spec.nodes });
}
