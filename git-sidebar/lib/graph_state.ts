// One section's Graph (R30–R32): the commits loaded, their lanes, the files
// of expanded commits, and when to read the log again. Editor-free: git runs
// through the injected runner, and the section says whether a step may still
// start git (`live`) and what to tell the user (`say`).
//
// The log runs in the same scheduler tick as the status, after it, so R11's
// 25% covers both (the tick is timed as a whole). It runs again only when
// what the Graph shows can have moved: the branch, HEAD, the upstream, the
// ahead/behind counts or the upstream's commit (a force push moves it with
// the counts the same), or when something forces it: the group expanded,
// Load more, the window active again (R28, R30).

import { failReason, objectId, run, shortId, type Mode, type Runner } from "./git.ts";
import { commitKey, graphKind, graphPart, graphRows, type Files, type GraphRows } from "./graph.ts";
import { filesArgs, logArgs, PAGE, parseDiffTree, parseLog, UPSTREAM_ID_ARGS, type Commit } from "./history.ts";
import { layout, type Cell } from "./lanes.ts";
import type { Status } from "./status.ts";
import type { RowList } from "./view.ts";

export interface GraphDeps {
  runner: Runner;
  /** Whether a step begun in `epoch` may still start git: no restart since,
   *  and the window still active (R28). */
  live: (epoch: number) => boolean;
  say: (msg: string) => void;
}

export class GraphState {
  private readonly deps: GraphDeps;
  /** Pages of `PAGE` commits asked for (R30). */
  private pages = 1;
  private commits: Commit[] = [];
  /** The listed commits' ids, each with its place in `commits`: set with
   *  `commits` (`setCommits`). */
  private listed = new Map<string, number>();
  private cells: Cell[][] = [];
  private more = false;
  private files = new Map<string, Files>();
  /** `rows()`, built once after `commits` or `files` change; null until
   *  then. Replaced, never changed in place: a caller may keep the old one. */
  private rowsCache: GraphRows | null = null;
  /** The last log parsed into `commits`: its raw output, and the page size
   *  and upstream it was parsed with. A read that prints the same for both
   *  changes nothing, so it is not parsed or laid out again. */
  private lastLog: { raw: string; n: number; upstream: string | null } | null = null;
  /** Commits whose files are being read. */
  private reading = new Set<string>();
  /** What the last good log was read for; null before it, or after a
   *  failure that was not followed by a good one. */
  private trigger: string | null = null;
  /** Read the log on the next status even when the trigger is unchanged. */
  private force = false;
  /** A Load more not yet drawn: the index of its first new commit. */
  private loading: number | null = null;
  /** The row to select once drawn: Load more's first new commit (R30). */
  private toSelect: string | null = null;

  constructor(deps: GraphDeps) {
    this.deps = deps;
  }

  /**
   * After a status was read (or found unchanged) in epoch `myEpoch`: read the
   * log when its trigger moved or something forced it; whether the Graph
   * changed and must be drawn again.
   *
   * - While the group is collapsed nothing runs, and expanding it forces the
   *   next read (R11).
   * - An unborn branch has no commits: the Graph is emptied, with no git.
   * - The upstream's commit is read (`rev-parse`, no lock) whenever the
   *   branch has one, so a force push with the counts unchanged still moves
   *   the Graph; the log names `@{upstream}` only when it exists (`ab`).
   * - A failed or timed-out log keeps the last good Graph (R10) and does not
   *   record the trigger, so the next status tries again. So does an empty
   *   one: a born branch has a commit to list, and `spawnHostProcess` (a
   *   bind-mounted dev container) gives "" with rc 0 for output that is not
   *   UTF-8, such as a Latin-1 author (INV §8 P17).
   * - A Load more while the log is read: that read used the old page count,
   *   so `force` and `loading` stay, and the refresh Load more asked for
   *   reads again with the new one (R30).
   */
  async afterStatus(status: Status, mode: Mode, root: string, myEpoch: number, graphExpanded: boolean): Promise<boolean> {
    if (!graphExpanded) {
      this.force = true;
      return false;
    }
    if (status.oid === null) {
      const had = this.commits.length > 0 || this.more;
      this.clear();
      this.trigger = null;
      return had;
    }
    let upstreamId: string | null = null;
    if (status.upstream !== null) {
      if (!this.deps.live(myEpoch)) return false;
      const r = await run(this.deps.runner, mode, "git", UPSTREAM_ID_ARGS, root);
      if (!this.deps.live(myEpoch)) return false;
      upstreamId = r.code === 0 ? objectId(r.stdout) : null;
    }
    const ab = status.ab === null ? "" : `${status.ab.ahead}/${status.ab.behind}`;
    const trigger = JSON.stringify([status.branch, status.oid, status.upstream, ab, upstreamId]);
    if (trigger === this.trigger && !this.force) return false;
    if (!this.deps.live(myEpoch)) return false;
    const pages = this.pages;
    const n = pages * PAGE;
    const r = await run(this.deps.runner, mode, "git", logArgs(n, status.ab !== null), root);
    if (!this.deps.live(myEpoch)) return false;
    if (r.code !== 0 || r.stdout === "") {
      // Keep the last good Graph, and try again on the next status.
      this.trigger = null;
      return false;
    }
    // The same output, read the same way: the same commits, refs, subjects,
    // authors and whether more exist, so nothing to parse, lay out or draw.
    const upstream = status.ab === null ? null : status.upstream;
    const last = this.lastLog;
    const changed = last === null || last.raw !== r.stdout || last.n !== n || last.upstream !== upstream;
    if (changed) {
      const { commits, hasMore } = parseLog(r.stdout, n, upstream);
      this.setCommits(commits);
      this.more = hasMore;
      this.cells = layout(commits);
      this.lastLog = { raw: r.stdout, n, upstream };
    }
    this.trigger = trigger;
    // A Load more came while this read ran: read again, with its page.
    if (this.pages !== pages) return changed;
    this.force = false;
    if (this.loading !== null) {
      const first = this.commits[this.loading];
      this.toSelect = first === undefined ? null : commitKey(first.id);
      this.loading = null;
    }
    return changed;
  }

  private setCommits(commits: Commit[]): void {
    this.commits = commits;
    this.listed = new Map(commits.map((c, i) => [c.id, i]));
    this.rowsCache = null;
  }

  private clear(): void {
    this.setCommits([]);
    this.cells = [];
    this.more = false;
    this.files.clear();
    this.loading = null;
    this.lastLog = null;
  }

  /**
   * Read the files of commit `id` if they are not read yet, or failed
   * (R32): lazily, on expanding it, and once for a commit expanded while
   * they are being read. On failure no file rows are listed and the user is
   * told git's reason. Whether the Graph changed.
   */
  async ensureFiles(id: string, mode: Mode, root: string, myEpoch: number): Promise<boolean> {
    const have = this.files.get(id);
    if ((have !== undefined && have !== "failed") || this.reading.has(id)) return false;
    const commit = this.commits.find((c) => c.id === id);
    if (commit === undefined || !this.deps.live(myEpoch)) return false;
    this.reading.add(id);
    try {
      const r = await run(this.deps.runner, mode, "git", filesArgs(id, commit.parents.length === 0), root);
      if (!this.deps.live(myEpoch)) return false;
      if (r.code !== 0) {
        this.setFiles(id, "failed");
        this.deps.say(`could not list the files of ${shortId(id)}: ${failReason(r, root)}`);
        return have !== "failed";
      }
      // "" is also a commit that changed no file, so it is not told apart
      // from output that is not UTF-8 through `spawnHostProcess` (INV §8 P17).
      this.setFiles(id, parseDiffTree(r.stdout));
      return true;
    } finally {
      this.reading.delete(id);
    }
  }

  private setFiles(id: string, files: Files): void {
    this.files.set(id, files);
    this.rowsCache = null;
  }

  /** The listed commit a key stands for, by id, or null. */
  private listedCommit(key: string): string | null {
    const k = graphKind(key);
    return k?.kind === "commit" && this.listed.has(k.id) ? k.id : null;
  }

  /** Commits that are expanded (`expanded` holds their keys) and listed,
   *  whose files are not read, in the log's order: to read after a log, as
   *  after Load more or a switch back to the window. A failed read is not
   *  retried here. */
  unread(expanded: ReadonlySet<string>): string[] {
    const ids: string[] = [];
    for (const key of expanded) {
      const id = this.listedCommit(key);
      if (id !== null && !this.files.has(id) && !this.reading.has(id)) ids.push(id);
    }
    return ids.sort((a, b) => this.listed.get(a)! - this.listed.get(b)!);
  }

  /** Load more (R30): one more page on the next log; whether it was taken.
   *  Ignored while one is still loading (a double click loads one page, R30)
   *  or when there is no more. */
  loadMore(): boolean {
    if (this.loading !== null || !this.more) return false;
    this.loading = this.commits.length;
    this.pages++;
    this.force = true;
    return true;
  }

  /** Read the log on the next status: the group was expanded, or the
   *  window became active again (R28, R30). */
  forceNext(): void {
    this.force = true;
  }

  /** The row Load more wants selected, once: its first new commit. */
  takeSelection(): string | null {
    const k = this.toSelect;
    this.toSelect = null;
    return k;
  }

  /**
   * Forget what no longer shows: the files of commits that are not listed
   * or not expanded, and the expansion of commits that are not listed (an
   * expanded commit stays expanded while it is listed, R32). `expanded` is
   * the section's set of expanded keys, changed in place; whether it
   * changed, so the caller pushes it: the host's copy changes only by a push
   * or a remount.
   */
  prune(expanded: Set<string>): boolean {
    let dropped = false;
    for (const key of [...expanded]) {
      const k = graphKind(key);
      if (k?.kind !== "commit" || this.listed.has(k.id)) continue;
      expanded.delete(key);
      dropped = true;
    }
    for (const id of [...this.files.keys()]) {
      if (this.listed.has(id) && expanded.has(commitKey(id))) continue;
      this.files.delete(id);
      this.rowsCache = null;
    }
    return dropped;
  }

  /** The Graph's rows under its group row (`graphPart`). */
  part(expanded: ReadonlySet<string>): RowList {
    return graphPart(this.commits, this.cells, expanded, this.files, this.more);
  }

  /** Every Graph row's commit, and file, by key (`graphRows`): the same map
   *  until the commits or files change. Callers must not change it. */
  rows(): GraphRows {
    if (this.rowsCache === null) this.rowsCache = graphRows(this.commits, this.files);
    return this.rowsCache;
  }

  /** How many commits are listed. */
  get size(): number {
    return this.commits.length;
  }
}
