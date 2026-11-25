// Pull and Push (R34–R36), after VS Code's git extension (INV §12.4): the
// reads they need first, the argv and environment they run with, and what
// git's result means to the user.
//
// Fresh gives a process no environment of its own and no input, yet git and
// ssh can open the editor's terminal: a credential prompt draws over the
// editor and waits forever, and killing it leaves a helper behind (INV §8
// P37 a, b). So both run as `env <assignments> git …`, with every prompt
// turned into a fast failure (P37 d, P39 a, d), and they are queued writes
// that are never killed (P37 g, h).

import { failReason, gitReason, type GitResult } from "./git.ts";

/** The branch's upstream, as its remote and the ref on it: the remote name
 *  and `refs/heads/<name>` there, NUL-separated (`%00`). Empty for a branch
 *  with none. No lock. */
export function upstreamArgs(branch: string): string[] {
  return ["--no-optional-locks", "for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${branch}`];
}

/** The repository's remotes, one per line (Publish's choices, R35). */
export const REMOTES_ARGS = ["--no-optional-locks", "remote"];

/** The repository's own ssh command, if set: rc 1 when not. */
export const SSH_CONFIG_ARGS = ["--no-optional-locks", "config", "--get", "core.sshCommand"];

/** The repository's `core.sshCommand` from what `SSH_CONFIG_ARGS` printed
 *  (null when it is not set: rc 1), or, when the read failed (a timeout, a
 *  config git cannot parse), why the `kind` must not run. A failed read is
 *  not an unset key: `GIT_SSH_COMMAND` would then stand in for the user's
 *  own command (R36 "as from a terminal"). `root` is where git ran. */
export function configuredSsh(r: GitResult, kind: "pull" | "push", root: string): { command: string | null } | { refused: string } {
  if (r.code === 0) return { command: r.stdout.trim() };
  if (r.code === 1) return { command: null };
  return { refused: `${kind} not run: could not read core.sshCommand: ${failReason(r, root)}` };
}

/** The branch checked out when a queued pull runs: `refs/heads/<name>`,
 *  or rc 1 and nothing for a detached HEAD. A pull integrates into HEAD,
 *  whatever the status on screen said (R34). */
export const HEAD_REF_ARGS = ["--no-optional-locks", "symbolic-ref", "-q", "HEAD"];

/** Why a queued pull must not run, from what `HEAD_REF_ARGS` printed when
 *  it was about to: the checked-out branch could not be read, or it is no
 *  longer `branch` (rc 1 and nothing: HEAD is detached now); null when
 *  `branch` is still checked out (R34). `root` is where git ran. */
export function pullTargetCheck(r: GitResult, branch: string, root: string): string | null {
  if (r.code !== 0 && r.code !== 1) return `pull not run: could not read the checked-out branch: ${failReason(r, root)}`;
  if (r.stdout.trim() !== `refs/heads/${branch}`) return `pull not run: the checked-out branch is no longer ${branch}`;
  return null;
}

export interface Upstream {
  remote: string;
  /** The branch on the remote, in full: `refs/heads/<name>`. */
  ref: string;
}

/** What `upstreamArgs` printed: the upstream, or null when there is none
 *  (or the read failed). */
export function parseUpstream(r: GitResult): Upstream | null {
  if (r.code !== 0) return null;
  const [remote = "", ref = ""] = r.stdout.replace(/\n+$/, "").split("\0");
  return remote !== "" && ref.startsWith("refs/heads/") ? { remote, ref } : null;
}

/** The remotes `REMOTES_ARGS` printed. */
export function parseRemotes(r: GitResult): string[] {
  return r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "") : [];
}

/** An upstream as status names it: `origin/main` for `refs/heads/main` on
 *  `origin`. */
export function upstreamName(u: Upstream): string {
  return `${u.remote}/${u.ref.slice("refs/heads/".length)}`;
}

/** The options that turn ssh's prompts into failures, and give up on a
 *  host that does not answer, within R36's 30 s (INV §8 P37 f, P39 a, b). */
const SSH_OPTIONS = "-o BatchMode=yes -o ConnectTimeout=10";

/** `s` quoted for the shell git runs an ssh command with. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The program a shell command runs: its first word, unquoted. */
function programOf(command: string): string {
  const m = /^\s*(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(command);
  return m === null ? "" : (m[1] ?? m[2] ?? m[3] ?? "");
}

/** Whether `program` is OpenSSH's client, by its file name. */
function isSsh(program: string): boolean {
  const base = program.slice(Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\")) + 1).toLowerCase();
  return base === "ssh" || base === "ssh.exe";
}

/**
 * The ssh command git should run, resolved as git resolves it (`git help
 * config`, core.sshCommand): `GIT_SSH_COMMAND`, then the repository's
 * `core.sshCommand`, then `GIT_SSH` (a program, no arguments), then `ssh`.
 * When that program is OpenSSH, the command with `SSH_OPTIONS` appended, so
 * the user's own options, keys and `~/.ssh/config` still apply (P39 b).
 * When it is not (PuTTY's plink, a wrapper script), null: the user's
 * setting is left in force, and only the environment's askpass settings
 * guard it, which stop OpenSSH inside a wrapper but not another program
 * (spec R36's exception).
 */
export function sshCommand(opts: { envCommand: string | null; configured: string | null; envSsh: string | null }): string | null {
  const set = (v: string | null): v is string => v !== null && v.trim() !== "";
  const command = set(opts.envCommand) ? opts.envCommand : set(opts.configured) ? opts.configured : null;
  if (command !== null) return isSsh(programOf(command)) ? `${command.trim()} ${SSH_OPTIONS}` : null;
  if (set(opts.envSsh)) return isSsh(opts.envSsh) ? `${shellQuote(opts.envSsh)} ${SSH_OPTIONS}` : null;
  return `ssh ${SSH_OPTIONS}`;
}

/**
 * The environment pull and push run with (R36):
 * - `LC_ALL=C`: git's messages in English, which `classifyPull` and
 *   `classifyPush` match (a gettext build translates `CONFLICT`, `From`
 *   and the rest), as `tests/fixtures/record.sh` records them. Hooks git
 *   runs (a pre-push, a post-merge) inherit it too (INV §8 P40 c);
 * - `GIT_TERMINAL_PROMPT=0`: git asks for no username or password on the
 *   terminal (P37 d);
 * - `GIT_ASKPASS=` (empty): git runs no askpass program, neither
 *   `core.askPass` nor `SSH_ASKPASS` (P39 d);
 * - `SSH_ASKPASS=false` with `SSH_ASKPASS_REQUIRE=force`: OpenSSH's
 *   passphrase and host-key questions get "no" at once, also inside a
 *   wrapper that drops BatchMode (P39 a);
 * - `GIT_SSH_COMMAND`, when `sshCommand` resolved one.
 * Credentials then come only from credential helpers and ssh agents.
 */
export function remoteEnv(ssh: string | null): string[] {
  return ["LC_ALL=C", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=false", "SSH_ASKPASS_REQUIRE=force", ...(ssh === null ? [] : [`GIT_SSH_COMMAND=${ssh}`])];
}

/** The argv of `env`, the program a pull or push runs as: the
 *  assignments, then git and its arguments (P39 j). */
export function remoteArgv(gitArgs: string[], env: string[]): string[] {
  return [...env, "git", ...gitArgs];
}

/** Pull (R34), as VS Code runs it: the upstream branch and tags from its
 *  remote, integrated as `pull.rebase` and `pull.ff` say. Never an
 *  autostash, whatever `rebase.autoStash` or `merge.autoStash` say: one that
 *  conflicts exits 0 and leaves its stash behind (P38), and R34 never
 *  stashes. With `--no-autostash`, local changes in the way make git refuse
 *  and change nothing (INV §8 P40 a). Without `--rebase` the option needs
 *  git 2.27 or later; older git refuses every such pull with git's reason. */
export function pullArgs(u: Upstream): string[] {
  return ["pull", "--tags", "--no-autostash", u.remote, u.ref];
}

/** Push (R35): the branch to its upstream branch, also under another name,
 *  never forced. */
export function pushArgs(u: Upstream, branch: string): string[] {
  return ["push", u.remote, `refs/heads/${branch}:${u.ref}`];
}

/** Publish (R35): the branch to a branch of the same name on `remote`,
 *  which becomes its upstream. */
export function publishArgs(remote: string, branch: string): string[] {
  return ["push", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`];
}

/** Lines that are no reason: where git fetched from or pushed to, its
 *  hints, and the refs it updated or left alone (` * branch …`,
 *  `   a..b main -> origin/main`). A rejected ref (` ! [rejected] …`) is
 *  kept: it says why. */
const NOT_A_REASON = /^(?:To |From |hint:)|^ [ +\-*=] .*->/;

/** git's reason for a failed pull or push (R34–R36): its first line that
 *  says something, as `gitReason` gives it (no `fatal:`, paths inside the
 *  root relative to it), with runs of spaces closed up. */
export function remoteReason(r: GitResult, root?: string): string {
  const lines = (s: string) => s.split(/\r?\n|\r/).filter((l) => l.trim() !== "" && !NOT_A_REASON.test(l));
  const line = [...lines(r.stderr), ...lines(r.stdout)][0];
  const reason = gitReason({ ...r, stderr: line ?? "", stdout: "" }, root);
  return reason.replace(/\s{2,}/g, " ");
}

/** What git prints when it needed credentials it could not ask for:
 *  http(s) with prompts off, and ssh in batch mode (P37 d, P39 a, d). */
const CREDENTIALS = /terminal prompts disabled|could not read (?:Username|Password)|Permission denied \(publickey|Host key verification failed/;

/** R36's message for a pull or push that needed credentials. */
const NEEDS_CREDENTIALS = "git needs credentials it can't ask for here";

export interface RemoteOutcome {
  ok: boolean;
  message: string;
}

/** What a pull prints when it brought nothing: a merge's `Already up to
 *  date.`, and a rebase's `Current branch <b> is up to date.` for a branch
 *  only ahead of its upstream (INV §8 P40 d). */
const UP_TO_DATE = /Already up to date|^Current branch .+ is up to date\.$/m;

/** How a pull went (R34, R36), for the upstream `name` (`origin/main`). */
export function classifyPull(r: GitResult, name: string, root?: string): RemoteOutcome {
  if (r.code === 0) return { ok: true, message: UP_TO_DATE.test(r.stdout) ? `already up to date with ${name}` : `pulled from ${name}` };
  // Conflicts: git stopped with the merge or rebase in progress, and the
  // files are listed under Changes for Resolve Conflict (R34).
  if (/^CONFLICT /m.test(r.stdout)) return { ok: false, message: `pulled from ${name} with conflicts: resolve them under Changes` };
  if (CREDENTIALS.test(r.stderr)) return { ok: false, message: `${NEEDS_CREDENTIALS}: ${remoteReason(r, root)}` };
  return { ok: false, message: `could not pull: ${remoteReason(r, root)}` };
}

/** How a push went (R35, R36), to `name` (`origin/main`). */
export function classifyPush(r: GitResult, name: string, root?: string): RemoteOutcome {
  if (r.code === 0) return { ok: true, message: /Everything up-to-date/.test(r.stderr) ? `nothing to push to ${name}` : `pushed to ${name}` };
  if (/\[rejected\].*\((?:fetch first|non-fast-forward)\)/.test(r.stderr)) return { ok: false, message: `push rejected, pull first: ${remoteReason(r, root)}` };
  if (CREDENTIALS.test(r.stderr)) return { ok: false, message: `${NEEDS_CREDENTIALS}: ${remoteReason(r, root)}` };
  return { ok: false, message: `could not push: ${remoteReason(r, root)}` };
}
