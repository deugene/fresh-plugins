// The Graph's item keys (R30–R32) and what each stands for. A module of its
// own, with no imports, so that lib/view.ts (which sorts every row into its
// group) and lib/graph.ts (which builds the Graph's rows from view.ts's file
// rows) can both use it without importing each other.
//
// Keys, none of which a Staged or Changes row can have (those start `s:`,
// `c:`, `more:s`, `more:c`):
//   g:g                the Graph group row
//   h:<id>             a commit
//   hf:<id>:<path>     a commit's file
//   more:hf:<id>       the `… N more` row of a commit's files
//   more:h             Load more

export const GRAPH_KEY = "g:g";
export const LOAD_MORE_KEY = "more:h";
const COMMIT_PREFIX = "h:";
const FILE_PREFIX = "hf:";
export const FILES_MORE_PREFIX = "more:hf:";

export const commitKey = (id: string): string => `${COMMIT_PREFIX}${id}`;
export const commitFileKey = (id: string, path: string): string => `${FILE_PREFIX}${id}:${path}`;

/** What a Graph key is: the group, a commit, a commit's file, Load more,
 *  an inert row (a file cap), or null for a key that is not the Graph's. */
export type GraphKind =
  | { kind: "group" }
  | { kind: "commit"; id: string }
  | { kind: "commitFile"; id: string; path: string }
  | { kind: "loadMore" }
  | { kind: "inert" };

export function graphKind(key: string): GraphKind | null {
  if (key === GRAPH_KEY) return { kind: "group" };
  if (key.startsWith(COMMIT_PREFIX)) return { kind: "commit", id: key.slice(COMMIT_PREFIX.length) };
  if (key.startsWith(FILE_PREFIX)) {
    const rest = key.slice(FILE_PREFIX.length);
    const colon = rest.indexOf(":");
    if (colon > 0) return { kind: "commitFile", id: rest.slice(0, colon), path: rest.slice(colon + 1) };
  }
  if (key === LOAD_MORE_KEY) return { kind: "loadMore" };
  if (key.startsWith(FILES_MORE_PREFIX)) return { kind: "inert" };
  return null;
}

/** The Graph group's key for any of its rows, or null for another key: so
 *  `placeOf` and `reconcile` keep a vanished Graph row's selection inside
 *  the Graph (R10). */
export function graphGroupOf(key: string): string | null {
  return graphKind(key) === null ? null : GRAPH_KEY;
}
