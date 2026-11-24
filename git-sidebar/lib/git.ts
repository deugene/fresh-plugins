// Where git runs and how its result comes back (R1, R11, R13).
//
// Fresh's container authority keeps the filesystem on the host and moves
// only processes into the container (INV §7), so:
//   local  — `runOnTarget` on the window's own machine;
//   bind   — the workspace is bind-mounted into a dev container: git runs on
//            the host with `spawnHostProcess`, on the host paths Fresh uses;
//   volume — the container's sources are in a volume Fresh cannot open
//            (INV §8, P8): no git at all, a notice instead.

export type Mode = "local" | "bind" | "volume";

/** Never takes `index.lock` (R11). `-uall` lists untracked files one by one. */
export const STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "-uall"];
/** Takes no lock: rev-parse reads no index. */
export const TOPLEVEL_ARGS = ["rev-parse", "--show-toplevel"];
/** The new commit's short id and subject, one per line, read after a commit
 *  (R26): the message as git recorded it, after any hook rewrote it. A read
 *  of its own: `commit`'s summary is off (`-q`), and stdout can come back ""
 *  through `spawnHostProcess` (INV §8 P17). No signature check is printed
 *  (`log.showSignature`), and no optional lock is taken (R11). */
export const HEAD_SUMMARY_ARGS = ["--no-optional-locks", "log", "-1", "--no-show-signature", "--format=%h%n%s", "HEAD"];

/** The status message once a commit is made (R26), from the run of
 *  `HEAD_SUMMARY_ARGS`: its short id and the subject git recorded. When that
 *  read failed, or printed no id, it still says the commit was made; when
 *  git gave no subject, the one typed stands in. */
export function commitMessage(r: GitResult, typedSubject: string): string {
  const [first = "", second = ""] = r.code === 0 ? r.stdout.split("\n") : [];
  const id = first.trim();
  if (!/^[0-9a-f]{4,64}$/.test(id)) return `committed: ${typedSubject}`;
  return `committed ${id}: ${second.trim() || typedSubject}`;
}
/** A diff side's object id, then its size, then its content (R14). Reads
 *  only, so they take no lock either (R11). `spec` is `:0:<p>` or
 *  `HEAD:<p>`; the size and the content are read by the id, so a write
 *  landing between the two reads cannot pair one blob's size with another
 *  blob's text (INV §8 P24). */
export const blobIdArgs = (spec: string): string[] => ["rev-parse", spec];
export const blobSizeArgs = (oid: string): string[] => ["--no-optional-locks", "cat-file", "-s", oid];
export const blobArgs = (oid: string): string[] => ["--no-optional-locks", "cat-file", "blob", oid];

/** The object id `rev-parse` printed (SHA-1 or SHA-256), or null. Without
 *  `--verify` it echoes an argument that names a file instead, with rc 0;
 *  with it, a missing path's error is only "Needed a single revision"
 *  (INV §8 P24). */
export function objectId(stdout: string): string | null {
  const id = stdout.trim();
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id) ? id : null;
}
const GIT_TIMEOUT_MS = 10_000;
/** How long a stage, unstage or commit may take before the user is told
 *  git is still running. Writes are never killed (see `run`). */
export const WRITE_TIMEOUT_MS = 60_000;

const CONTAINER_PREFIX = "Container:";

/** The container id in an authority label such as `Container:6516756aef93`. */
export function containerId(label: string): string | null {
  return label.startsWith(CONTAINER_PREFIX) ? label.slice(CONTAINER_PREFIX.length) || null : null;
}

interface DockerMount {
  Type?: string;
  Source?: string;
  Destination?: string;
}

/** `p` without a trailing slash (but `/` stays `/`): as git lists a nested
 *  repository (`dir/`), or as a mount path may be written. `/`-separated
 *  paths only. */
export function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** Whether `dir` is `root` or inside it. */
export function within(dir: string, root: string): boolean {
  const d = trimSlash(dir);
  const r = trimSlash(root);
  return d === r || r === "/" || d.startsWith(r + "/");
}

/** A mode, or `unknown` when the container could not be asked. */
export type Detected = Mode | "unknown";

/**
 * The mode for an authority label. In a container, `pwd` is the result of
 * `pwd` run in the container with no cwd (so in its workspace folder: the
 * docker spawner's `-w <remoteWorkspaceFolder>`), and `inspect` the
 * host-side result of `docker inspect <id> --format '{{json .Mounts}}'`;
 * null when not run. `hostRoot` is the workspace folder on the host.
 *
 * The mount that covers the container's workspace W is the one whose
 * Destination is W or the longest ancestor of it. The workspace is the
 * host's (`bind`) only when that mount is a bind and maps W to `hostRoot`,
 * a folder inside it (a `workspaceFolder` below the mount), or a folder
 * that holds it (Fresh opened below the container's workspace); a volume,
 * no covering mount, or a bind of some other folder is `volume`. Either
 * command failing is `unknown`: ask again later.
 */
export function detectMode(
  label: string,
  hostRoot: string,
  pwd: { code: number; stdout: string } | null,
  inspect: { code: number; stdout: string } | null,
): { mode: Detected; reason: string } {
  if (containerId(label) === null) return { mode: "local", reason: "no container authority" };
  const w = pwd && pwd.code === 0 ? pwd.stdout.trim() : "";
  if (!w.startsWith("/")) return { mode: "unknown", reason: "pwd in the container failed" };
  if (!inspect || inspect.code !== 0) return { mode: "unknown", reason: "docker inspect failed" };
  let mounts: DockerMount[];
  try {
    const parsed: unknown = JSON.parse(inspect.stdout.trim() || "[]");
    if (!Array.isArray(parsed)) throw new Error("not an array");
    mounts = parsed as DockerMount[];
  } catch {
    return { mode: "unknown", reason: "docker inspect output unreadable" };
  }
  const ws = trimSlash(w);
  let cover: DockerMount | null = null;
  let coverDest = "";
  for (const m of mounts) {
    if (typeof m.Destination !== "string" || !m.Destination.startsWith("/")) continue;
    const dest = trimSlash(m.Destination);
    if (!within(ws, dest)) continue;
    if (cover === null || dest.length > coverDest.length) {
      cover = m;
      coverDest = dest;
    }
  }
  if (cover === null) return { mode: "volume", reason: `no mount covers ${ws}` };
  if (cover.Type !== "bind" || typeof cover.Source !== "string") {
    return { mode: "volume", reason: `${ws} is on a ${cover.Type ?? "unknown"} mount` };
  }
  const rel = ws === coverDest ? "" : coverDest === "/" ? ws : ws.slice(coverDest.length);
  const src = trimSlash(cover.Source);
  const mapped = rel === "" ? src : src === "/" ? rel : src + rel;
  return within(mapped, hostRoot) || within(hostRoot, mapped)
    ? { mode: "bind", reason: `${ws} is bind-mounted from ${mapped}` }
    : { mode: "volume", reason: `${ws} is bind-mounted from ${mapped}, not the workspace` };
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Timed out and left to finish by itself, not killed (a write): its
   *  result once git exits. It never rejects. */
  finished?: Promise<GitResult>;
}

/** git's first non-blank line (stderr, else stdout), trimmed and without
 *  its `fatal:` or `error:` tag, or `git exited with N` when it printed
 *  nothing: the reason a failed run gives the user. The message around it
 *  already says what failed, and the status bar cuts a long one. So with
 *  `root` (the repository top level git ran in), a path inside it is shown
 *  relative to it, as the section shows paths: a held lock reads
 *  `Unable to create '.git/index.lock': File exists.`. A path outside it,
 *  such as a linked worktree's git dir, stays absolute. */
export function gitReason(r: GitResult, root?: string): string {
  const line = (r.stderr || r.stdout)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return `git exited with ${r.code}`;
  const reason = line.replace(/^(?:fatal|error): +/, "");
  if (root === undefined) return reason;
  // Only where the root starts a path (the line's start, or after a space,
  // a quote or a bracket): `/x/repo/f` is not inside the root `/repo`.
  const inside = `${trimSlash(root)}/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return reason.replace(new RegExp(`(^|[\\s'"\`(])${inside}`, "g"), "$1");
}

/** A failure that will not go away by retrying: not a repository or
 *  dubious ownership (128), a git too old for the arguments (129, a usage
 *  error), git not executable or not found (126, 127), or a run that could
 *  not start at all (-1 without a timeout: a spawn failure, or workspace
 *  trust denying it). A timeout or any other code may pass. */
export function isDefinitiveFailure(r: GitResult): boolean {
  return r.code === 128 || r.code === 129 || r.code === 126 || r.code === 127 || (r.code === -1 && !r.timedOut);
}

/** `runOnTarget` resolves `{code}`, `spawnHostProcess` `{exit_code}`. */
export function normalise(r: unknown): GitResult {
  const o = (r ?? {}) as { code?: unknown; exit_code?: unknown; stdout?: unknown; stderr?: unknown };
  const code = typeof o.code === "number" ? o.code : typeof o.exit_code === "number" ? o.exit_code : -1;
  return {
    code,
    stdout: typeof o.stdout === "string" ? o.stdout : "",
    stderr: typeof o.stderr === "string" ? o.stderr : "",
    timedOut: false,
  };
}

/** The part of Fresh's `ProcessHandle` this module uses. */
export interface Handle extends PromiseLike<unknown> {
  kill(): Promise<boolean>;
}

export interface Runner {
  runOnTarget(program: string, args: string[], cwd: string): Handle;
  spawnHostProcess(program: string, args: string[], cwd: string): Handle;
  delay(ms: number): Promise<void>;
}

/** What a run does at its timeout: `kill` the process (reads), or `leave`
 *  it to finish by itself (writes). In 0.5.9 a kill is a SIGKILL, for
 *  `runOnTarget` on this machine and for `spawnHostProcess` alike (INV §8,
 *  Review fixes), so a killed `git add` cannot remove its
 *  `.git/index.lock`, and every later git write fails until someone
 *  deletes it. */
export type OnTimeout = "kill" | "leave";

/**
 * Run a command for `mode`, racing it against `timeoutMs`. Never rejects.
 *
 * On timeout with `kill` (the default, for reads) the process is killed and
 * the call waits for it to really settle (so the scheduler's duration covers
 * the whole run), for at most another `timeoutMs`, before resolving with
 * `timedOut`. In a container `kill` does nothing and the run goes to
 * completion; its result is still discarded, and one that never settles no
 * longer holds the caller.
 *
 * With `leave` (writes) it resolves at once with `timedOut`, and the
 * process goes on to finish by itself; `finished` is its eventual result
 * (`runWrite` waits for it).
 */
export function run(
  runner: Runner,
  mode: Mode,
  program: string,
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  onTimeout: OnTimeout = "kill",
): Promise<GitResult> {
  return runOn(runner, mode === "local" ? "target" : "host", program, args, cwd, timeoutMs, onTimeout);
}

/** A run that could not start, or whose handle rejected. */
function spawnFailure(e: unknown): GitResult {
  return { code: -1, stdout: "", stderr: String(e), timedOut: false };
}

/** Whole seconds, for a message. */
const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

/** `run` on an explicit side: the window's machine (`target`, in a
 *  container when attached) or the host. */
export async function runOn(
  runner: Runner,
  via: "target" | "host",
  program: string,
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  onTimeout: OnTimeout = "kill",
): Promise<GitResult> {
  let handle: Handle;
  try {
    handle = via === "target" ? runner.runOnTarget(program, args, cwd) : runner.spawnHostProcess(program, args, cwd);
  } catch (e) {
    return spawnFailure(e);
  }
  const settled: Promise<GitResult> = Promise.resolve(handle).then(normalise, spawnFailure);
  // Race on a sentinel, not on the result: the delay cannot be cancelled and
  // would keep the result (its stdout) alive for the whole timeout.
  const inTime = await Promise.race([settled.then(() => true), runner.delay(timeoutMs).then(() => false)]);
  if (inTime) return await settled;
  if (onTimeout === "leave") {
    return { code: -1, stdout: "", stderr: `still running after ${seconds(timeoutMs)}`, timedOut: true, finished: settled };
  }
  try {
    await handle.kill();
  } catch {
    // Already gone.
  }
  // Bounded: a kill that does nothing (a container) on a run that never
  // ends (a hung docker daemon) would otherwise stop every later refresh.
  await Promise.race([settled.then(() => undefined), runner.delay(timeoutMs)]);
  return { code: -1, stdout: "", stderr: `timed out after ${timeoutMs} ms`, timedOut: true };
}

/**
 * Run a stage or unstage in `cwd`, never killed (see `OnTimeout`), and
 * resolve with git's own result once it exits. One that outlives
 * `WRITE_TIMEOUT_MS` first calls `onSlow` with the left-running result
 * (`stderr`: `still running after 60 s`), so the user hears it (R15), and
 * is then awaited to its end. Anything chained on the returned promise, as
 * the write queue is, so waits until git lets go of `index.lock`: one write
 * at a time (INV §9.5).
 */
export async function runWrite(runner: Runner, mode: Mode, args: string[], cwd: string, onSlow: (left: GitResult) => void): Promise<GitResult> {
  const r = await run(runner, mode, "git", args, cwd, WRITE_TIMEOUT_MS, "leave");
  if (r.finished === undefined) return r;
  try {
    onSlow(r);
  } catch {
    // Only the message is lost: the wait below is what keeps writes apart.
  }
  return await r.finished;
}
