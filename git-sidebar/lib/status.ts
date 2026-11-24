// Parsing of `git status --porcelain=v2 --branch -z -uall` into the two
// groups the section shows, and the section title.

/** The status letter shown on a row (spec R5). */
export type Marker = "M" | "A" | "D" | "R" | "C" | "T" | "U" | "!";

export interface Entry {
  /** Repository-relative path, `/`-separated. */
  path: string;
  marker: Marker;
  /** Original path of a rename or copy. */
  orig?: string;
  /** A directory, not a file: a submodule, or an untracked nested
   *  repository (which git lists as `dir/`, trailing slash, even with
   *  `-uall`). */
  dir?: true;
  /** The two-letter state of an unresolved merge conflict (a `u` record):
   *  one of `DD AU UD UA DU AA UU`. Only conflicted entries carry it. */
  conflict?: string;
  /** A Changes entry whose working-tree mode (`mW` of a `1`, `2` or `u`
   *  record) is 120000: the file on disk is a symbolic link. `?` records
   *  carry no mode, so an untracked link never has it (R14). */
  link?: true;
}

export interface Status {
  /** Branch name; `null` on a detached HEAD. */
  branch: string | null;
  /** Commit id of HEAD; `null` on an unborn branch. */
  oid: string | null;
  upstream: string | null;
  /** Present only when the upstream exists (`# branch.ab`). */
  ab: { ahead: number; behind: number } | null;
  staged: Entry[];
  changes: Entry[];
}

/** Status letters shown as they are; anything else shows as M. */
const LETTERS = new Set("MTADRC");

function marker(letter: string): Marker {
  return LETTERS.has(letter) ? (letter as Marker) : "M";
}

/** The path after the first `n` space-separated fields of a record. Paths
 *  may themselves contain spaces, so the record is not split further. */
function pathAfter(record: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const sp = record.indexOf(" ", at);
    if (sp < 0) return "";
    at = sp + 1;
  }
  return record.slice(at);
}

/** Only R and C rows show where the file came from (R5). */
function entry(path: string, m: Marker, orig: string | undefined, dir: boolean): Entry {
  const e: Entry = orig !== undefined && (m === "R" || m === "C") ? { path, marker: m, orig } : { path, marker: m };
  if (dir) e.dir = true;
  return e;
}

/** Field `n` (0-based) of a record, for the fields before its path. */
function field(record: string, n: number): string {
  return record.split(" ", n + 1)[n] ?? "";
}

/** The working-tree mode of a symbolic link. */
const LINK_MODE = "120000";

/** The `<sub>` field of a `1`, `2` or `u` record (`N...`, or `S<c><m><u>`
 *  for a submodule) says whether the path is a submodule. */
function isSubmodule(record: string): boolean {
  return record[5] === "S";
}

function byPath(a: Entry, b: Entry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function parseStatus(raw: string): Status {
  const s: Status = { branch: null, oid: null, upstream: null, ab: null, staged: [], changes: [] };
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "") continue;
    if (t.startsWith("# ")) {
      const [key, ...rest] = t.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") s.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") s.branch = value === "(detached)" ? null : value;
      else if (key === "branch.upstream") s.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) s.ab = { ahead: Number(m[1]), behind: Number(m[2]) };
      }
      continue;
    }
    const kind = t[0];
    if (kind === "1" || kind === "2") {
      const x = t[2];
      const y = t[3];
      const path = pathAfter(t, kind === "1" ? 8 : 9);
      // A rename or copy record is followed by its original path as the next
      // NUL-separated token; consume it so it is not read as a record.
      const orig = kind === "2" ? tokens[++i] : undefined;
      const dir = isSubmodule(t);
      if (x !== ".") s.staged.push(entry(path, marker(x), orig, dir));
      if (y !== ".") {
        const e = entry(path, marker(y), orig, dir);
        // `1 XY sub mH mI mW …`, `2 XY sub mH mI mW …`.
        if (field(t, 5) === LINK_MODE) e.link = true;
        s.changes.push(e);
      }
    } else if (kind === "u") {
      // `u XY sub m1 m2 m3 mW h1 h2 h3 path`: the path follows 10 fields.
      const e = entry(pathAfter(t, 10), "!", undefined, isSubmodule(t));
      e.conflict = t.slice(2, 4);
      if (field(t, 6) === LINK_MODE) e.link = true;
      s.changes.push(e);
    } else if (kind === "?") {
      const path = t.slice(2);
      s.changes.push(entry(path, "U", undefined, path.endsWith("/")));
    }
    // "!" (ignored) records never appear: the command does not ask for them.
  }
  s.staged.sort(byPath);
  s.changes.sort(byPath);
  return s;
}

/** Status output is decoded lossily (INV §8, Review fixes): a path that
 *  is not valid UTF-8 comes back with U+FFFD in place of its bad bytes, so
 *  it names no file git knows, and one such path fails a whole `git add`
 *  (P13 iii). Whether `p` is such a name. */
export function unpassable(p: string): boolean {
  return p.includes("\uFFFD");
}

/** `Git · <branch>` plus ` ↑A ↓B` when the branch has an upstream (R2). */
export function title(s: Status): string {
  const head = s.branch ?? (s.oid ? s.oid.slice(0, 7) : "HEAD");
  const ab = s.ab ? ` ↑${s.ab.ahead} ↓${s.ab.behind}` : "";
  return `Git · ${head}${ab}`;
}
