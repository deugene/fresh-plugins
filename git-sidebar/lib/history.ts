// The Graph's git reads (R30–R33): the argv of `git log`, `diff-tree`, `show`
// and the commit message, and the parsers of their output. Every read starts
// with `--no-optional-locks` or is a `rev-parse`, so refreshing never takes
// `.git/index.lock` (R11).

import { objectId, trimSlash } from "./git.ts";
import { byPath, marker, type Entry } from "./status.ts";

/** Commits per page, and the first page (R30; VS Code's default, INV §12.3). */
export const PAGE = 50;

/** A ref shown as a badge on its commit's row (R30): `HEAD` on a detached
 *  HEAD's commit, the current branch, its upstream, and every other local
 *  branch, remote-tracking branch and tag. */
export interface Badge {
  kind: "head" | "current" | "upstream" | "local" | "remote" | "tag";
  name: string;
}

export interface Commit {
  /** The full object id. */
  id: string;
  /** Full ids, first parent first. Empty for a root commit, and for a
   *  shallow clone's boundary commit, whose parents are missing (R30). */
  parents: string[];
  refs: Badge[];
  author: string;
  subject: string;
}

/** The log format's fields, each ended by a NUL (`%x00`, and `-z` for the
 *  last): the one byte a subject or an author name cannot hold. Any other
 *  byte can, the unit and record separators included (INV §8 P43 a). */
const LOG_FIELDS = 5;

/**
 * The log of the first `n` commits, and one more to tell whether more exist
 * (INV §12.3): HEAD's, and with `withUpstream` the upstream's too, in git's
 * topological order (R30). `--decorate=full` names refs in full, so a branch
 * named like a tag cannot pass for one, and a remote's symbolic `HEAD` is
 * left out (R30, INV §8 P39 e). No signature check is printed
 * (`log.showSignature`), and no optional lock is taken (R11). `--` ends the
 * revisions: without it a file or directory named `HEAD` at the top level
 * (or `head` on a case-insensitive filesystem) makes git die with
 * "ambiguous argument", and the Graph would never load (INV §8 P40 b).
 * `tests/fixtures/record.sh` records with this argv.
 */
export function logArgs(n: number, withUpstream: boolean): string[] {
  return [
    "--no-optional-locks",
    "log",
    "--topo-order",
    "--no-show-signature",
    "--no-color",
    "--decorate=full",
    "--decorate-refs-exclude=refs/remotes/*/HEAD",
    "-z",
    "-n",
    String(n + 1),
    "--format=%H%x00%P%x00%D%x00%an%x00%s",
    "HEAD",
    ...(withUpstream ? ["@{upstream}"] : []),
    "--",
  ];
}

/** The badges of one commit from its `%D` (`--decorate=full`). `upstream`
 *  is the branch's upstream as status names it (`origin/main`). Anything
 *  that is not a ref, such as a shallow boundary's `grafted`, or a stash or
 *  notes ref, gets no badge (INV §8 P39 e). */
export function badges(decoration: string, upstream: string | null): Badge[] {
  const out: Badge[] = [];
  for (const part of decoration.split(", ")) {
    const d = part.trim();
    if (d === "HEAD") out.push({ kind: "head", name: "HEAD" });
    else if (d.startsWith("HEAD -> refs/heads/")) out.push({ kind: "current", name: d.slice("HEAD -> refs/heads/".length) });
    else if (d.startsWith("tag: refs/tags/")) out.push({ kind: "tag", name: d.slice("tag: refs/tags/".length) });
    else if (d.startsWith("refs/heads/")) out.push({ kind: "local", name: d.slice("refs/heads/".length) });
    else if (d.startsWith("refs/remotes/")) {
      const name = d.slice("refs/remotes/".length);
      // Excluded by the log's argv; never shown either way (R30).
      if (name.endsWith("/HEAD")) continue;
      out.push({ kind: name === upstream ? "upstream" : "remote", name });
    }
  }
  return out;
}

/** The commits `logArgs(n, …)` printed, at most `n`, and whether it found
 *  more: five NUL-ended fields a commit. One whose first field is not an
 *  object id is skipped, and a cut-off last one too. */
export function parseLog(raw: string, n: number, upstream: string | null): { commits: Commit[]; hasMore: boolean } {
  const commits: Commit[] = [];
  const t = raw.split("\0");
  // The last item is what follows the final NUL: "" in a whole output.
  for (let i = 0; i + LOG_FIELDS < t.length; i += LOG_FIELDS) {
    const id = objectId(t[i]);
    if (id === null) continue;
    commits.push({ id, parents: t[i + 1] === "" ? [] : t[i + 1].split(" "), refs: badges(t[i + 2], upstream), author: t[i + 3], subject: t[i + 4] });
  }
  return { commits: commits.slice(0, n), hasMore: commits.length > n };
}

/** The upstream's commit id, to tell when it moved with the counts the
 *  same (a force push, R30). rc 1 and no output when the
 *  branch has none. rev-parse takes no lock. */
export const UPSTREAM_ID_ARGS = ["--no-optional-locks", "rev-parse", "--verify", "-q", "@{upstream}"];

/**
 * A commit's changed files against its first parent (R32; VS Code's
 * choice, INV §12.3): a merge lists what the merged branch brought, where
 * `diff-tree <merge>` alone prints nothing. A root commit, or a shallow
 * boundary with no parent to read, against the empty tree. `--raw` gives
 * the modes, so a gitlink can be refused like a directory row (R14). `--`
 * ends the revisions, as in `logArgs`: a top-level file named as the full
 * id is ambiguous too.
 */
export function filesArgs(id: string, isRoot: boolean): string[] {
  const base = ["--no-optional-locks", "diff-tree", "-r", "-z", "--raw", "-M"];
  return isRoot ? [...base, "--root", "--no-commit-id", id, "--"] : [...base, `${id}^1`, id, "--"];
}

const GITLINK = "160000";

/**
 * The files `filesArgs` printed, sorted by path, as entries a file row
 * draws (R32): `:<mode> <mode> <id> <id> <status>`, then the path, or for a
 * rename or copy (`R<score>`, `C<score>`) the original path, then the new
 * one. A gitlink (mode 160000 on either side) is a directory row.
 */
export function parseDiffTree(raw: string): Entry[] {
  const out: Entry[] = [];
  const t = raw.split("\0");
  for (let i = 0; i < t.length; i++) {
    const head = t[i];
    if (!head.startsWith(":")) continue;
    const [srcMode, dstMode, , , status = ""] = head.slice(1).split(" ");
    const letter = status[0] ?? "M";
    const two = letter === "R" || letter === "C";
    const first = t[++i];
    if (first === undefined) break;
    // Status letters shown as they are; anything else shows as M.
    const e: Entry = { path: first, marker: marker(letter) };
    if (two) {
      const to = t[++i];
      if (to === undefined) break;
      e.path = to;
      e.orig = first;
    }
    if (srcMode === GITLINK || dstMode === GITLINK) e.dir = true;
    e.path = trimSlash(e.path);
    out.push(e);
  }
  return out.sort(byPath);
}

/**
 * View Commit's text (R33): the commit as `git show` prints it, with
 * author and committer dates (`fuller`), the files with line counts and
 * the patch against the first parent, an empty tree for a root commit
 * (INV §8 P39 f). `--root` shows a root commit's stat and patch whatever
 * `log.showRoot` says (with it false they are left out), and changes
 * nothing for any other commit (INV §8 P40 e). `--first-parent` gives a
 * merge's first-parent diff, as `--diff-merges=first-parent` does, which
 * git before 2.31 refuses; from 2.27 on `show` takes `--first-parent` the
 * same way (INV §8 P43 b). No colour, no signature check, no lock.
 * `--` ends the revisions, as in `logArgs`.
 */
export function showArgs(id: string): string[] {
  return ["--no-optional-locks", "show", "--no-color", "--no-show-signature", "--format=fuller", "--stat", "--patch", "--first-parent", "--root", id, "--"];
}

/** The commit's full message, for Copy Commit Message (R33). `--` ends the
 *  revisions, as in `logArgs`. */
export function messageArgs(id: string): string[] {
  return ["--no-optional-locks", "log", "-1", "--no-show-signature", "--format=%B", id, "--"];
}

/** The message `messageArgs` printed: git ends it with a blank line. */
export function commitMessageText(stdout: string): string {
  return stdout.replace(/\n+$/, "");
}
