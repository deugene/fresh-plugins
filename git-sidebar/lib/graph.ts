// The Graph group (R30–R32): its rows, what each row stands for, and the
// diff of a commit's file. Its keys are in lib/graph_keys.ts.
//
// Commit files are kept out of the status rows' `EntryMap`: every stage,
// unstage and group write reads that map, and these rows can't be written.
// They have a lookup of their own, `GraphRows`.

import { shortId } from "./git.ts";
import type { Badge, Commit } from "./history.ts";
import type { Cell } from "./lanes.ts";
import { badName, unpassable, type Entry } from "./status.ts";
import type { DiffTarget, Side } from "./diff.ts";
import { DIM, fileNode, node, pushCapped, type Node, type RowList, type Segment } from "./view.ts";
import { commitFileKey, commitKey, FILES_MORE_PREFIX, LOAD_MORE_KEY } from "./graph_keys.ts";

export { commitFileKey, commitKey, GRAPH_KEY, graphKind, LOAD_MORE_KEY } from "./graph_keys.ts";

/** The theme's lane colours, by `layout`'s colour index (R31, INV §8
 *  P36 g): theme keys, so a theme switch recolours them without a reload.
 *  One per `LANE_COLORS`. */
export const LANE_KEYS = ["editor.bracket_rainbow_1", "editor.bracket_rainbow_2", "editor.bracket_rainbow_3", "editor.bracket_rainbow_4", "editor.bracket_rainbow_5"];

/** A badge's background: the current branch and its upstream each have a
 *  colour of their own, as does a detached HEAD; the rest share one (R30). */
const BADGE_BG: Record<Badge["kind"], string> = {
  current: "ui.file_status_added_fg",
  upstream: "ui.file_status_renamed_fg",
  head: "ui.file_status_modified_fg",
  local: DIM,
  remote: DIM,
  tag: DIM,
};

/** The graph cells as segments, neighbouring cells of one colour merged. */
function laneSegments(cells: Cell[]): Segment[] {
  const out: Segment[] = [];
  for (const c of cells) {
    const last = out.at(-1);
    const fg = c.color === null ? null : LANE_KEYS[c.color];
    if (last !== undefined && (last.style?.fg ?? null) === fg) last.text += c.text;
    else out.push(fg === null ? { text: c.text } : { text: c.text, style: { fg } });
  }
  return out;
}

/** A commit's row (R30): the graph, the badges, the subject, the author
 *  de-emphasised. Badges come before the subject: the host cuts a row too
 *  wide for the section at its end (INV §8 P36 f, spec decisions). */
function commitNode(c: Commit, cells: Cell[]): Node {
  const segments: Segment[] = [...laneSegments(cells), { text: " " }];
  for (const b of c.refs) {
    segments.push({ text: ` ${b.name} `, style: { fg: "editor.bg", bg: BADGE_BG[b.kind], bold: true } }, { text: " " });
  }
  segments.push({ text: c.subject });
  if (c.author !== "") segments.push({ text: `  ${c.author}`, style: { fg: DIM } });
  return node(segments, 1, true);
}

/** A commit's files: an array once read, "failed" when they could not be. */
export type Files = Entry[] | "failed";

/**
 * The Graph's rows under its group row (R30–R32): one per commit, at depth
 * 1 with `hasChildren` so every commit's lanes line up (INV §8 P36 b); an
 * expanded commit's files at depth 2, drawn as status rows are, with no
 * button and at most `ROW_CAP` (R11, R32); then Load more when there are
 * more commits. An expanded commit whose files are not read yet, or could
 * not be, lists none.
 */
export function graphPart(
  commits: Commit[],
  cells: Cell[][],
  expanded: ReadonlySet<string>,
  files: ReadonlyMap<string, Files>,
  hasMore: boolean,
): RowList {
  const out: RowList = { nodes: [], keys: [] };
  for (const [i, c] of commits.entries()) {
    const key = commitKey(c.id);
    out.nodes.push(commitNode(c, cells[i] ?? []));
    out.keys.push(key);
    const fs = files.get(c.id);
    if (!expanded.has(key) || fs === undefined || fs === "failed") continue;
    pushCapped(out, fs, 2, `${FILES_MORE_PREFIX}${c.id}`, (e) => [fileNode(e, 2), commitFileKey(c.id, e.path)]);
  }
  if (hasMore) {
    out.nodes.push(node([{ text: "Load more", style: { fg: DIM } }], 1, false));
    out.keys.push(LOAD_MORE_KEY);
  }
  return out;
}

/** A Graph row's commit, and for a file row its entry. */
export type GraphRow = { commit: Commit; entry?: Entry };
/** Read-only: `GraphState` hands out one map until its commits or files
 *  change. */
export type GraphRows = ReadonlyMap<string, GraphRow>;

/** Every listed commit's row, and every read file's row (past the cap
 *  too), by key: commit and commit-file keys only. */
export function graphRows(commits: Commit[], files: ReadonlyMap<string, Files>): GraphRows {
  const rows = new Map<string, GraphRow>();
  for (const commit of commits) {
    rows.set(commitKey(commit.id), { commit });
    const fs = files.get(commit.id);
    if (fs === undefined || fs === "failed") continue;
    for (const entry of fs) rows.set(commitFileKey(commit.id, entry.path), { commit, entry });
  }
  return rows;
}

/** The commit a Graph row stands for: its own, or its file's (R18, R33). */
export function commitOf(key: string, rows: GraphRows): Commit | null {
  // `rows` holds commit and commit-file keys only (`graphRows`).
  return rows.get(key)?.commit ?? null;
}

/**
 * The diff of a commit's file (R32): the file in the commit's first
 * parent, for a rename or copy its original path, against the file in the
 * commit. The left side is empty for an added file and for a root commit
 * (or a shallow boundary, whose parent is missing), the right side for a
 * deleted one. Pane labels are short ids, which hold no `:` (R21), and the
 * tab title names the file and both commits. A gitlink is refused like a
 * directory row, and a name that is not UTF-8 like a status row (R14).
 */
export function commitDiffTarget(commit: Commit, entry: Entry, key: string): DiffTarget {
  const parent = commit.parents[0] ?? null;
  const id7 = shortId(commit.id);
  const p7 = parent === null ? "empty" : shortId(parent);
  const left: Side = parent === null || entry.marker === "A" ? { kind: "empty" } : { kind: "blob", spec: `${parent}:${entry.orig ?? entry.path}` };
  const right: Side = entry.marker === "D" ? { kind: "empty" } : { kind: "blob", spec: `${commit.id}:${entry.path}` };
  const bad = [entry.path, entry.orig].some((p) => p !== undefined && unpassable(p));
  return {
    key,
    path: entry.path,
    left,
    right,
    labels: [p7, id7],
    title: `${entry.path} (${p7} ↔ ${id7})`,
    refusal: entry.dir ? "directory" : bad ? "unpassable name" : null,
    refusedName: badName(entry),
  };
}
