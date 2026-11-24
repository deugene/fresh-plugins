// Staging and unstaging (R15, R16): the git arguments, how a write's result
// reads, and the queue that runs one write at a time.
//
// Every write's argv starts with `--literal-pathspecs`: without it a path
// such as `a*` is a glob, and `git add -- 'a*'` also stages `ab` (INV §9.5).
// Writes take `.git/index.lock`, so they cannot use `--no-optional-locks`;
// only these user-requested writes ever take it (R11).

import { gitReason, trimSlash, type GitResult } from "./git.ts";
import { unpassable, type Entry, type Status } from "./status.ts";

export const LITERAL = "--literal-pathspecs";

/** The paths a write on `e` names. A rename names its original path too:
 *  in Changes (`.R`, a rename onto an intent-to-add path) staging only the
 *  new path would leave the original's deletion unstaged, and in Staged
 *  resetting only the new path left `D <orig>` staged (INV §9.5). A copy
 *  names only its new path: its source keeps its own change, and R15
 *  touches only the row's path. */
function writePaths(e: Entry): string[] {
  const path = trimSlash(e.path);
  return e.orig !== undefined && e.marker === "R" ? [path, e.orig] : [path];
}

/** A Changes path deleted from the working tree. */
function deletion(e: Entry): boolean {
  return e.marker === "D";
}

/**
 * What staging the Changes entry `e` does to each path it names: `removed`
 * paths leave the index, `added` ones take the working tree's state. A
 * deletion is removed, and so is a Changes rename's original path, which
 * is deleted too. Neither goes to `git add`: `add -- foo`, when the deleted
 * file `foo` is now a directory, also adds what is under `foo/` and embeds
 * a nested repository there (INV §8 P14 d, P23 e).
 */
function stagePaths(e: Entry): { removed: string[]; added: string[] } {
  const path = trimSlash(e.path);
  if (deletion(e)) return { removed: [path], added: [] };
  if (e.orig !== undefined && e.marker === "R") return { removed: [e.orig], added: [path] };
  return { removed: [], added: [path] };
}

const ADD = [LITERAL, "add", "--"];
const ADD_ALL = [LITERAL, "add", "-A", "--"];
/** Drops an entry only if its path is really gone (or is now a
 *  directory), when the command runs. `rm --cached` drops it whatever the
 *  working tree holds, so on a row read before the file came back it would
 *  stage the deletion of a file that exists. Both are idempotent here: a
 *  path no longer in the index is rc 0 (INV §8 P23). */
const REMOVE = [LITERAL, "update-index", "--remove", "--"];
const RESET = [LITERAL, "reset", "-q", "--"];

/** Whether git can be given back every path a write on `e` names (see
 *  `unpassable`). */
export function passable(e: Entry): boolean {
  return !writePaths(e).some(unpassable);
}

/** Stage one Changes path: the index takes the working tree's state of it,
 *  a deletion included (R15). The commands to run in order: the removal
 *  first, as in stage all (P14 e), so a Changes rename is two commands.
 *  Each reads the working tree when it runs, so commands built from rows
 *  that a later write or the user has overtaken still do what R15 says. */
export function stageArgs(e: Entry): string[][] {
  const { removed, added } = stagePaths(e);
  const commands: string[][] = [];
  if (removed.length > 0) commands.push([...REMOVE, ...removed]);
  if (added.length > 0) commands.push([...ADD, ...added]);
  return commands;
}

/** Unstage one Staged path, and a rename's original path (see
 *  `writePaths`): one command. `reset` with paths works on an unborn
 *  branch, where `restore --staged` fails, and never touches the working
 *  tree. */
export function unstageArgs(e: Entry): string[][] {
  return [[...RESET, ...writePaths(e)]];
}

/** Most path bytes one group command carries. Stays well under Windows'
 *  32 K-character command line, and bounds each bridge message; the
 *  process API has no stdin for `--pathspec-from-file` (INV §9.6). */
export const CHUNK_BYTES = 16 * 1024;

/** `s`'s length in UTF-8 bytes. By hand: Fresh's QuickJS runtime has no
 *  `TextEncoder`. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A surrogate pair: one code point above U+FFFF.
      n += 4;
      i++;
    } else {
      // The rest of the BMP, and a lone surrogate, which encodes as U+FFFD.
      n += 3;
    }
  }
  return n;
}

/** The size one path adds to a command line: its bytes and a separator. */
function argBytes(p: string): number {
  return utf8Length(p) + 1;
}

/**
 * Split `groups` of paths into runs of at most `limit` path bytes, in order.
 * A group (a rename's new and original path) is never split across runs, so
 * each command resets or stages both. A single group over the limit gets a
 * run of its own.
 */
export function chunk(groups: string[][], limit = CHUNK_BYTES): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const g of groups) {
    const n = g.reduce((t, p) => t + argBytes(p), 0);
    if (cur.length > 0 && size + n > limit) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(...g);
    size += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** One command of a group operation: its argv, and how many paths it
 *  names. */
export interface GroupCommand {
  args: string[];
  paths: number;
}

/** A group operation: the commands to run in order, how many paths they
 *  carry, and what was left out. */
export interface GroupPlan {
  commands: GroupCommand[];
  paths: number;
  skipped: Skipped;
}

/** Entries a group operation leaves out, by reason: conflicted (`git add`
 *  would mark them resolved), directories (it would embed a nested
 *  repository), and names git can't pass back (`unpassable`). */
export interface Skipped {
  conflicted: number;
  dirs: number;
  names: number;
}

/** Each path once over all `runs`, with its rename partner in the same
 *  group. */
function uniqueGroups(runs: string[][][]): string[][][] {
  const seen = new Set<string>();
  return runs.map((groups) => {
    const out: string[][] = [];
    for (const g of groups) {
      const fresh = g.filter((p) => !seen.has(p));
      for (const p of fresh) seen.add(p);
      if (fresh.length > 0) out.push(fresh);
    }
    return out;
  });
}

/** One command per chunk of each run, the runs in order. */
function plan(runs: { base: string[]; groups: string[][] }[], skipped: Skipped): GroupPlan {
  const unique = uniqueGroups(runs.map((r) => r.groups));
  return {
    commands: runs.flatMap((r, i) => chunk(unique[i]).map((paths) => ({ args: [...r.base, ...paths], paths: paths.length }))),
    paths: unique.flat().reduce((t, g) => t + g.length, 0),
    skipped,
  };
}

/**
 * Stage all (R16): every Changes path, past the row cap too, as R15 stages
 * one, except conflicted paths, directories and names git can't pass back
 * (INV §9.5). Always with the paths listed: a bare `git add -A` or `-u`
 * resolves conflicts.
 *
 * Deletions, and a Changes rename's original path, go first, in
 * `update-index --remove` commands of their own: once `add -A -- foo/x`
 * has replaced a deleted file `foo` with `foo/x` in the index, removing
 * `foo` fails with "is a directory" (`rm --cached`: "not removing 'foo'
 * recursively"; INV §8 P14 e, P23 f).
 */
export function stageAllPlan(status: Status): GroupPlan {
  const removed: string[][] = [];
  const added: string[][] = [];
  const skipped: Skipped = { conflicted: 0, dirs: 0, names: 0 };
  for (const e of status.changes) {
    if (e.marker === "!") skipped.conflicted++;
    else if (e.dir) skipped.dirs++;
    else if (!passable(e)) skipped.names++;
    else {
      const paths = stagePaths(e);
      if (paths.removed.length > 0) removed.push(paths.removed);
      if (paths.added.length > 0) added.push(paths.added);
    }
  }
  return plan(
    [
      { base: REMOVE, groups: removed },
      { base: ADD_ALL, groups: added },
    ],
    skipped,
  );
}

/**
 * Unstage all (R16): every Staged path and a rename's original, as R15
 * unstages one. Always with the paths listed: a bare `git reset` ends a
 * merge (it deleted `MERGE_HEAD`), and `reset -- :/` turned a `UU` into
 * ` M`. Listed paths leave both alone (INV §9.5, §8 P13).
 */
export function unstageAllPlan(status: Status): GroupPlan {
  const groups: string[][] = [];
  const skipped: Skipped = { conflicted: 0, dirs: 0, names: 0 };
  for (const e of status.staged) {
    if (!passable(e)) skipped.names++;
    else groups.push(writePaths(e));
  }
  return plan([{ base: RESET, groups }], skipped);
}

/** What a group operation's message says it left out, such as `skipped 3:
 *  1 with a merge conflict (resolve with git first), 2 directories
 *  (submodule or nested repository)`; null when it left nothing out. */
export function skippedMessage(skipped: Skipped): string | null {
  const { conflicted, dirs, names } = skipped;
  if (conflicted + dirs + names === 0) return null;
  const why = [
    conflicted > 0 ? `${conflicted} with a merge conflict (resolve with git first)` : "",
    dirs > 0 ? `${dirs} ${dirs === 1 ? "directory" : "directories"} (submodule or nested repository)` : "",
    names > 0 ? `${names} ${names === 1 ? "name" : "names"} git can't pass back (not UTF-8)` : "",
  ].filter((x) => x !== "");
  return `skipped ${conflicted + dirs + names}: ${why.join(", ")}`;
}

export type WriteOutcome = { ok: true } | { ok: false; reason: string };

/**
 * How a write went (INV §8, P13), from git's own result (`runWrite` waits
 * past the timeout for it). Exit 0 is success whatever stderr says: an
 * unstage that lists paths during a merge, cherry-pick, revert or rebase
 * prints `<path>: needs merge` for the conflicted ones and keeps them. Any
 * other exit is a failure with git's first line, such as a held
 * `index.lock`, or rc 128 for a path that vanished, which stages nothing.
 * `root` is where the write ran: paths inside it read relative to it
 * (`gitReason`).
 */
export function classifyWrite(r: GitResult, root?: string): WriteOutcome {
  return r.code === 0 ? { ok: true } : { ok: false, reason: gitReason(r, root) };
}

/**
 * One write at a time, in the order asked. A request for a key is dropped
 * while that key's write is queued or running, or has finished but no
 * refresh started after it has been drawn yet: a fast repeated Space, or a
 * double click on a button, acts once (R15).
 *
 * `writeSeq` counts finished writes. A refresh records it when it starts;
 * if it changed by the time the status came back, that status may predate
 * a write and is not drawn. Once a refresh is drawn, or fails and leaves
 * the rows as they are, `release(seq)` releases the keys its status covers.
 *
 * A write's op resolves only when git has exited, even past its timeout
 * (`runWrite`), so the next one never starts while git holds `index.lock`.
 */
export class OpQueue {
  private busy = new Set<string>();
  private awaiting = new Map<string, number>();
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;
  private readonly onDone: () => void;

  /** `onDone` runs after every write: it asks for the refresh that shows
   *  the result. */
  constructor(onDone: () => void) {
    this.onDone = onDone;
  }

  get writeSeq(): number {
    return this.seq;
  }

  /** Whether a request for `key` would be dropped now. */
  blocked(key: string): boolean {
    return this.busy.has(key) || this.awaiting.has(key);
  }

  /** Queue `op` for `key`: the promise of its run (it never rejects), or
   *  null when the request is dropped. */
  enqueue(key: string, op: () => Promise<void>): Promise<void> | null {
    if (this.blocked(key)) return null;
    this.busy.add(key);
    const done = this.tail.then(async () => {
      try {
        await op();
      } catch {
        // The caller's op logs its own errors; the queue must go on.
      } finally {
        this.busy.delete(key);
        this.seq++;
        this.awaiting.set(key, this.seq);
        try {
          this.onDone();
        } catch {
          // Same: a throwing callback must not stop the queue.
        }
      }
    });
    this.tail = done;
    return done;
  }

  /** A refresh that started at `writeSeq === seq` is done: drawn (or found
   *  nothing to change), so every write up to `seq` is on screen; or failed,
   *  so the rows on screen stay (R10), and a press on them must act again
   *  rather than be dropped in silence for as long as statuses fail. A
   *  repeat is safe: every write takes the state of its paths when it runs
   *  (`stageArgs`). A refresh the host refused to draw releases nothing. */
  release(seq: number): void {
    for (const [key, s] of this.awaiting) if (s <= seq) this.awaiting.delete(key);
  }
}
