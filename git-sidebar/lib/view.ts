// The section's tree: two groups of file rows built from a parsed status,
// then the Graph group (lib/graph.ts), a one-row notice, and the signature
// that tells whether anything changed.

import { trimSlash } from "./git.ts";
import { GRAPH_KEY, graphGroupOf, graphKind, type GraphKind } from "./graph_keys.ts";
import type { Entry, Marker, Status } from "./status.ts";

export const TREE_KEY = "git";
export const STAGED_KEY = "g:s";
export const CHANGES_KEY = "g:c";
const NOTICE_KEY = "n:notice";
/** Rows listed per group, and per commit's files, before the `… K more`
 *  row (R11). A full update of ~3,000 rows costs about 40 ms (INV §8 P36 h). */
export const ROW_CAP = 1000;

/** De-emphasised text: a directory, an original path, an author (R5, R30). */
export const DIM = "editor.line_number_fg";

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
  /** Theme keys, resolved by the host at render time (R5, R31).
   *  `strikethrough` is drawn in tree text (DTS `TextStyle`; R24); `bg` and
   *  `bold` draw a ref badge (R30, INV §8 P36 e). Each is left out, not
   *  false, on a segment that does not use it. */
  style?: { fg: string; bg?: string; bold?: boolean; strikethrough?: boolean };
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

/** What a row is, by its item key: a Staged or Changes file, or one of the
 *  Graph's kinds (`GraphKind`), whose `group` and `inert` the status groups
 *  share. `file` is a Staged or Changes row only: a commit's file is
 *  `commitFile`, so no check for `file` reaches a Graph row (R30, R32). */
export type RowKind = { kind: "file"; path: string } | GraphKind;

export function rowKind(key: string): RowKind {
  if (key === STAGED_KEY || key === CHANGES_KEY) return { kind: "group" };
  if (key.startsWith("s:") || key.startsWith("c:")) return { kind: "file", path: key.slice(2) };
  return graphKind(key) ?? { kind: "inert" };
}

/** The item key of a file row in the Staged (`s`) or Changes (`c`) group. */
function fileKey(prefix: "s" | "c", path: string): string {
  return `${prefix}:${path}`;
}

/** A row of `segments`, its text their concatenation. */
export function node(segments: Segment[], depth: number, hasChildren: boolean): Node {
  return { text: { text: segments.map((s) => s.text).join(""), segments }, depth, hasChildren };
}

/** A file row at `depth`: a status row at 1 (R5), a commit's file at 2
 *  (R32). It carries no button: `group` adds the status rows' one. */
export function fileNode(e: Entry, depth = 1): Node {
  const path = trimSlash(e.path);
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dir = slash < 0 ? "" : path.slice(0, slash);
  const fg = MARKER_COLOR[e.marker];
  // A deleted file's name is struck through, in both groups; its marker,
  // directory and original path are not, and nothing else is (R24). A
  // conflict that deletes keeps `!` as its one signal (spec, decisions).
  const nameStyle: Segment["style"] = e.marker === "D" ? { fg, strikethrough: true } : { fg };
  const segments: Segment[] = [{ text: e.marker, style: { fg } }, { text: " " }, { text: name, style: nameStyle }];
  if (dir) segments.push({ text: `  ${dir}`, style: { fg: DIM } });
  if (e.orig !== undefined) segments.push({ text: `  ← ${e.orig}`, style: { fg: DIM } });
  return node(segments, depth, false);
}

/** The button label of the row `key`, or null for none. */
export type ButtonLabel = (key: string) => string | null;

/** `n` with the button `label` gives the row `key`, if any. */
function withButton(n: Node, key: string, label: ButtonLabel | undefined): Node {
  const text = label?.(key) ?? null;
  if (text !== null) n.action = text;
  return n;
}

/** Rows and their item keys, in order. */
export interface RowList {
  nodes: Node[];
  keys: string[];
}

/** File rows for `entries` at `depth`, at most `ROW_CAP`, then a dimmed
 *  `… K more` row keyed `moreKey` when there are more (R11, R32). `row`
 *  gives an entry's node and key. */
export function pushCapped(out: RowList, entries: Entry[], depth: number, moreKey: string, row: (e: Entry) => [Node, string]): void {
  for (const e of entries.slice(0, ROW_CAP)) {
    const [n, k] = row(e);
    out.nodes.push(n);
    out.keys.push(k);
  }
  if (entries.length > ROW_CAP) {
    out.nodes.push(node([{ text: `… ${entries.length - ROW_CAP} more`, style: { fg: DIM } }], depth, false));
    out.keys.push(moreKey);
  }
}

function group(label: string, key: string, prefix: "s" | "c", entries: Entry[] | null, out: RowList, button: ButtonLabel | undefined): void {
  const count = entries === null ? "" : ` ${entries.length}`;
  out.nodes.push(withButton(node([{ text: `${label}${count}` }], 0, true), key, entries === null ? undefined : button));
  out.keys.push(key);
  if (entries === null) return;
  // `more:s` / `more:c`: no `s:` / `c:` prefix, so no file can have it.
  pushCapped(out, entries, 1, `more:${prefix}`, (e) => {
    const k = fileKey(prefix, e.path);
    return [withButton(fileNode(e), k, button), k];
  });
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

/** The three groups, Staged first, then Changes, then Graph, all always
 *  present (R3). `status` null is the placeholder drawn before the first
 *  status arrives: the groups without counts, rows or buttons. `label` puts
 *  each row's `+`/`−` on it, group rows included (R5). `graph` is the
 *  Graph's rows (`graphPart`), listed under its group row, which shows no
 *  count and has no button (R3, R30). */
export function buildTree(status: Status | null, label?: ButtonLabel, graph?: RowList): TreeSpec {
  const out: RowList = { nodes: [], keys: [] };
  group("Staged Changes", STAGED_KEY, "s", status ? status.staged : null, out, label);
  group("Changes", CHANGES_KEY, "c", status ? status.changes : null, out, label);
  out.nodes.push(node([{ text: "Graph" }], 0, true));
  out.keys.push(GRAPH_KEY);
  if (graph !== undefined) {
    out.nodes.push(...graph.nodes);
    out.keys.push(...graph.keys);
  }
  return tree(out.nodes, out.keys);
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
 *  rows and its `… N more` row, and for the Graph every one of its rows
 *  (`graphGroupOf`). Null for any other row (a notice). */
function groupOf(key: string): string | null {
  if (key === STAGED_KEY || key.startsWith("s:") || key === "more:s") return STAGED_KEY;
  if (key === CHANGES_KEY || key.startsWith("c:") || key === "more:c") return CHANGES_KEY;
  return graphGroupOf(key);
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

/**
 * The row auto-reveal selects for the file at `absPath` (R23), or null to
 * leave the selection alone. `root` is the repository's top level, in the
 * same resolved form as the editor's buffer paths (INV §8 P28 e).
 *
 * With one of the file's rows already `selectedKey`, in either group, the
 * selection stays: a Staged row the user chose is not traded for the
 * Changes row, which Space would act on instead (R23 "Both groups").
 * VS Code leaves its selection alone in the same case, a row of the file
 * in any group (INV §10.3 c).
 *
 * Otherwise the Changes row is tried first, then the Staged one, as VS Code
 * prefers. The first group that lists the file decides: when that group is
 * collapsed, or the file's row is not drawn (past the 1,000-row cap), nothing
 * is selected, and no group is expanded. A path outside the root, a
 * sibling such as `/repo2` included, is never listed.
 */
export function revealKey(
  absPath: string,
  root: string,
  entries: EntryMap,
  shownKeys: string[],
  expanded: ReadonlySet<string>,
  selectedKey: string | null,
): string | null {
  const r = trimSlash(root);
  const prefix = r === "/" ? "/" : `${r}/`;
  if (!absPath.startsWith(prefix)) return null;
  const rel = absPath.slice(prefix.length);
  if (rel === "") return null;
  if (selectedKey === fileKey("c", rel) || selectedKey === fileKey("s", rel)) return null;
  for (const [key, group] of [
    [fileKey("c", rel), CHANGES_KEY],
    [fileKey("s", rel), STAGED_KEY],
  ] as const) {
    if (!entries.has(key)) continue;
    return expanded.has(group) && shownKeys.includes(key) ? key : null;
  }
  return null;
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
