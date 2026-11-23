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
export const TOPLEVEL_ARGS = ["rev-parse", "--show-toplevel"];
const GIT_TIMEOUT_MS = 10_000;

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

/**
 * Run a command for `mode`, racing it against `timeoutMs`. Never rejects. On
 * timeout the process is killed and the call waits for it to really settle
 * (so the scheduler's duration covers the whole run), for at most another
 * `timeoutMs`, before resolving with `timedOut`. In a container `kill` does
 * nothing and the run goes to completion; its result is still discarded,
 * and one that never settles no longer holds the caller.
 */
export function run(
  runner: Runner,
  mode: Mode,
  program: string,
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  return runOn(runner, mode === "local" ? "target" : "host", program, args, cwd, timeoutMs);
}

/** A run that could not start, or whose handle rejected. */
function spawnFailure(e: unknown): GitResult {
  return { code: -1, stdout: "", stderr: String(e), timedOut: false };
}

/** `run` on an explicit side: the window's machine (`target`, in a
 *  container when attached) or the host. */
export async function runOn(
  runner: Runner,
  via: "target" | "host",
  program: string,
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
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
