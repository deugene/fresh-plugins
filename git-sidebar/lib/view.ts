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

function group(
  label: string,
  key: string,
  prefix: "s" | "c",
  entries: Entry[] | null,
  nodes: Node[],
  keys: string[],
): void {
  const count = entries === null ? "" : ` ${entries.length}`;
  nodes.push(node([{ text: `${label}${count}` }], 0, true));
  keys.push(key);
  if (entries === null) return;
  for (const e of entries.slice(0, ROW_CAP)) {
    nodes.push(fileNode(e));
    keys.push(fileKey(prefix, e.path));
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
    cardBorders: false,
    // The sidebar is narrow: one column per level.
    indentCols: 1,
    toggleOnClick: true,
  };
}

/** The two groups, Staged first, both always present (R3). `status` null is
 *  the placeholder drawn before the first status arrives: the groups without
 *  counts or rows. */
export function buildTree(status: Status | null): TreeSpec {
  const nodes: Node[] = [];
  const keys: string[] = [];
  group("Staged Changes", STAGED_KEY, "s", status ? status.staged : null, nodes, keys);
  group("Changes", CHANGES_KEY, "c", status ? status.changes : null, nodes, keys);
  return tree(nodes, keys);
}

/** Keys of the rows that are directories (submodules, nested
 *  repositories): activating them cannot open a file. */
export function directoryKeys(status: Status): Set<string> {
  const keys = new Set<string>();
  for (const e of status.staged) if (e.dir) keys.add(fileKey("s", e.path));
  for (const e of status.changes) if (e.dir) keys.add(fileKey("c", e.path));
  return keys;
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
