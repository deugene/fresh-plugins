import { test } from "node:test";
import assert from "node:assert/strict";
import { commitMessage, containerId, detectMode, isDefinitiveFailure, normalise, objectId, run, runWrite, within, STATUS_ARGS, WRITE_TIMEOUT_MS, type GitResult, type Handle, type Runner } from "../lib/git.ts";
import { GS_VOLUME as VOLUME, inspectResult as mounts, pwdResult as pwd } from "./helpers.ts";

const ROOT = "/Users/me/src/repo";
const HOME_BIND = { Type: "bind", Source: "/Users/me", Destination: "/home/me" };

test("no authority label: local, nothing asked", () => {
  assert.equal(detectMode("", ROOT, null, null).mode, "local");
  assert.equal(detectMode("SSH:host", ROOT, null, null).mode, "local");
});

test("the workspace bind-mounted exactly: bind", () => {
  const inspect = mounts({ Type: "bind", Source: ROOT, Destination: "/workspaces/repo" });
  assert.equal(detectMode("Container:6516756aef93", ROOT, pwd("/workspaces/repo"), inspect).mode, "bind");
  // Trailing slashes on either side do not matter.
  const slashed = mounts({ Type: "bind", Source: `${ROOT}/`, Destination: "/workspaces/repo/" });
  assert.equal(detectMode("Container:abc", `${ROOT}/`, pwd("/workspaces/repo/"), slashed).mode, "bind");
});

test("a bind of an ancestor that maps the container's workspace back to the host workspace: bind", () => {
  const inspect = mounts(HOME_BIND);
  assert.equal(detectMode("Container:abc", ROOT, pwd("/home/me/src/repo"), inspect).mode, "bind");
  // The longest covering Destination wins over a shorter one.
  const nested = mounts({ Type: "volume", Destination: "/home" }, HOME_BIND);
  assert.equal(detectMode("Container:abc", ROOT, pwd("/home/me/src/repo"), nested).mode, "bind");
  // A bind of the whole filesystem.
  const all = mounts({ Type: "bind", Source: "/", Destination: "/host" });
  assert.equal(detectMode("Container:abc", ROOT, pwd(`/host${ROOT}`), all).mode, "bind");
});

test("a bind that maps the container's workspace inside the host workspace, or above it: bind", () => {
  // devcontainer.json `workspaceFolder` below the default workspace mount.
  const repo = mounts({ Type: "bind", Source: ROOT, Destination: "/workspaces/repo" });
  assert.equal(detectMode("Container:abc", ROOT, pwd("/workspaces/repo/app"), repo).mode, "bind");
  // Fresh opened in a folder below the container's workspace.
  assert.equal(detectMode("Container:abc", `${ROOT}/app`, pwd("/workspaces/repo"), repo).mode, "bind");
});

test("a volume workspace next to a $HOME bind: volume", () => {
  const inspect = mounts(HOME_BIND, VOLUME);
  assert.equal(detectMode("Container:abc", ROOT, pwd("/workspaces/gs"), inspect).mode, "volume");
  // The shape P8 recorded on colima.
  assert.equal(detectMode("Container:88d99bb42e11", ROOT, pwd("/workspaces/gs"), mounts(VOLUME)).mode, "volume");
});

test("a bind that maps the container's workspace somewhere else: volume", () => {
  const sibling = mounts({ Type: "bind", Source: "/Users/me/src/repo2", Destination: "/w" });
  assert.equal(detectMode("Container:abc", ROOT, pwd("/w"), sibling).mode, "volume");
  // The ancestor bind covers W, but W maps to another host folder.
  assert.equal(detectMode("Container:abc", ROOT, pwd("/home/me/other"), mounts(HOME_BIND)).mode, "volume");
});

test("no mount covers the container's workspace: volume", () => {
  assert.equal(detectMode("Container:abc", ROOT, pwd("/workspaces/repo"), mounts()).mode, "volume");
  assert.equal(detectMode("Container:abc", ROOT, pwd("/workspaces/repo"), mounts(HOME_BIND)).mode, "volume");
});

test("pwd failure: unknown", () => {
  const inspect = mounts({ Type: "bind", Source: ROOT, Destination: "/workspaces/repo" });
  assert.equal(detectMode("Container:abc", ROOT, null, inspect).mode, "unknown");
  assert.equal(detectMode("Container:abc", ROOT, { code: -1, stdout: "" }, inspect).mode, "unknown");
  assert.equal(detectMode("Container:abc", ROOT, { code: 0, stdout: "\n" }, inspect).mode, "unknown");
});

test("inspect failure: unknown, never a guess", () => {
  const w = pwd("/workspaces/repo");
  assert.equal(detectMode("Container:abc", ROOT, w, null).mode, "unknown");
  assert.equal(detectMode("Container:abc", ROOT, w, { code: 1, stdout: "" }).mode, "unknown");
  assert.equal(detectMode("Container:abc", ROOT, w, { code: 0, stdout: "not json" }).mode, "unknown");
});

test("definitive failures: 128, 129, 126, 127 and a -1 that is not a timeout", () => {
  const r = (code: number, timedOut = false) => ({ code, stdout: "", stderr: "", timedOut });
  // 129: a git too old for `--no-optional-locks` or `--porcelain=v2`.
  for (const code of [128, 129, 126, 127, -1]) assert.ok(isDefinitiveFailure(r(code)), String(code));
  assert.ok(!isDefinitiveFailure(r(-1, true)), "timeout");
  assert.ok(!isDefinitiveFailure(r(1)));
  assert.ok(!isDefinitiveFailure(r(130)));
});

test("containerId", () => {
  assert.equal(containerId("Container:6516756aef93"), "6516756aef93");
  assert.equal(containerId("Container:"), null);
  assert.equal(containerId(""), null);
});

test("within", () => {
  assert.ok(within(ROOT, ROOT));
  assert.ok(within(ROOT, "/"));
  assert.ok(!within("/Users/me/src/repository", ROOT));
});

test("exit_code maps to code; code passes through", () => {
  assert.deepEqual(normalise({ exit_code: 128, stdout: "", stderr: "fatal" }), { code: 128, stdout: "", stderr: "fatal", timedOut: false });
  assert.deepEqual(normalise({ code: 0, stdout: "x", stderr: "" }), { code: 0, stdout: "x", stderr: "", timedOut: false });
  assert.equal(normalise({}).code, -1);
  assert.equal(normalise(undefined).code, -1);
});

test("status arguments never take index.lock", () => {
  assert.equal(STATUS_ARGS[0], "--no-optional-locks");
  assert.deepEqual(STATUS_ARGS, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "-uall"]);
});

function handle(result: Promise<unknown>, onKill: () => void = () => {}): Handle {
  return { then: (a, b) => result.then(a, b), kill: async () => (onKill(), true) };
}

test("run picks runOnTarget for local and spawnHostProcess otherwise", async () => {
  const seen: string[] = [];
  const runner: Runner = {
    runOnTarget: (p, a, c) => (seen.push(`target ${p} ${a[0]} ${c}`), handle(Promise.resolve({ code: 0, stdout: "t", stderr: "" }))),
    spawnHostProcess: (p, a, c) => (seen.push(`host ${p} ${a[0]} ${c}`), handle(Promise.resolve({ exit_code: 0, stdout: "h", stderr: "" }))),
    delay: () => new Promise(() => {}),
  };
  assert.equal((await run(runner, "local", "git", ["status"], "/r")).stdout, "t");
  assert.equal((await run(runner, "bind", "git", ["status"], "/r")).stdout, "h");
  assert.deepEqual(seen, ["target git status /r", "host git status /r"]);
});

test("run never rejects", async () => {
  const runner: Runner = {
    runOnTarget: () => handle(Promise.reject(new Error("boom"))),
    spawnHostProcess: () => {
      throw new Error("sync boom");
    },
    delay: () => new Promise(() => {}),
  };
  assert.equal((await run(runner, "local", "git", [], "/")).code, -1);
  assert.equal((await run(runner, "bind", "git", [], "/")).code, -1);
});

test("timeout kills and waits for the process to settle", async () => {
  let release!: (v: unknown) => void;
  const proc = new Promise((r) => (release = r));
  let killed = false;
  let fire!: () => void;
  const runner: Runner = {
    runOnTarget: () =>
      handle(proc, () => {
        killed = true;
        setTimeout(() => release({ code: -1, stdout: "", stderr: "killed" }), 5);
      }),
    spawnHostProcess: () => handle(proc),
    delay: () => new Promise<void>((r) => (fire = r)),
  };
  const p = run(runner, "local", "git", [], "/", 10_000);
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 1));
  fire();
  await new Promise((r) => setTimeout(r, 1));
  assert.ok(killed);
  assert.equal(done, false, "waits until the killed process settles");
  const r = await p;
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
});

test("a timed-out run whose kill does nothing (a container) still resolves, after another timeout", async () => {
  const fires: (() => void)[] = [];
  let killed = false;
  const runner: Runner = {
    runOnTarget: () => handle(new Promise(() => {}), () => (killed = true)),
    spawnHostProcess: () => handle(new Promise(() => {})),
    delay: () => new Promise<void>((r) => fires.push(r)),
  };
  const p = run(runner, "local", "git", [], "/", 10_000);
  let done = false;
  void p.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 1));
  fires[0]();
  await new Promise((r) => setTimeout(r, 1));
  assert.ok(killed);
  assert.equal(done, false, "waits for the process to settle first");
  assert.equal(fires.length, 2, "for one more timeout");
  fires[1]();
  const r = await p;
  assert.equal(r.timedOut, true);
  assert.equal(r.code, -1);
});

test("a run left to finish (a write) resolves at its timeout with its eventual result, and is never killed (F0)", async () => {
  const fires: (() => void)[] = [];
  let kills = 0;
  let release!: (v: unknown) => void;
  const proc = new Promise((r) => (release = r));
  const runner: Runner = {
    runOnTarget: () => handle(proc, () => kills++),
    spawnHostProcess: () => handle(proc, () => kills++),
    delay: () => new Promise<void>((r) => fires.push(r)),
  };
  const left: GitResult[] = [];
  for (const mode of ["local", "bind"] as const) {
    const p = run(runner, mode, "git", ["add"], "/", WRITE_TIMEOUT_MS, "leave");
    await new Promise((r) => setTimeout(r, 1));
    fires.shift()!();
    const r = await p;
    const { finished, ...rest } = r;
    assert.deepEqual(rest, { code: -1, stdout: "", stderr: "still running after 60 s", timedOut: true });
    assert.ok(finished instanceof Promise);
    left.push(r);
    assert.equal(fires.length, 0, "no second wait");
  }
  assert.equal(kills, 0);
  assert.equal(WRITE_TIMEOUT_MS, 60_000);
  release({ code: 0, stdout: "", stderr: "" });
  for (const r of left) assert.deepEqual(await r.finished, { code: 0, stdout: "", stderr: "", timedOut: false });
});

test("runWrite: past its timeout it says so once, then resolves only when git exits, with git's result (R15, F0)", async () => {
  const fires: (() => void)[] = [];
  let kills = 0;
  let release!: (v: unknown) => void;
  const proc = new Promise((r) => (release = r));
  const runner: Runner = {
    runOnTarget: () => handle(proc, () => kills++),
    spawnHostProcess: () => handle(proc, () => kills++),
    delay: () => new Promise<void>((r) => fires.push(r)),
  };
  const slow: string[] = [];
  let settled = false;
  const p = runWrite(runner, "local", ["add", "--", "big"], "/r", (left) => slow.push(left.stderr)).then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 1));
  fires.shift()!();
  await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(slow, ["still running after 60 s"]);
  assert.equal(settled, false, "still waiting for git: the next write must not start");
  release({ code: 128, stdout: "", stderr: "fatal: unable to write new index file\n" });
  assert.deepEqual(await p, { code: 128, stdout: "", stderr: "fatal: unable to write new index file\n", timedOut: false });
  assert.equal(kills, 0);
  // In time: no message, git's result.
  const quick: Runner = { ...runner, runOnTarget: () => handle(Promise.resolve({ code: 0, stdout: "", stderr: "" }), () => kills++) };
  const calls: string[] = [];
  assert.deepEqual(await runWrite(quick, "local", ["add"], "/r", () => calls.push("slow")), { code: 0, stdout: "", stderr: "", timedOut: false });
  assert.deepEqual(calls, []);
});

test("objectId takes only an object id from rev-parse's output", () => {
  assert.equal(objectId(`${"a".repeat(40)}\n`), "a".repeat(40));
  assert.equal(objectId(`${"0".repeat(64)}\n`), "0".repeat(64));
  // Without --verify, rev-parse echoes an argument that names a file, with rc 0.
  assert.equal(objectId("HEAD:absent\n"), null);
  assert.equal(objectId(""), null);
});

test("commitMessage: the short id and the subject git recorded; without an id, still committed (R26)", () => {
  const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  assert.equal(commitMessage(ok("abc1234\n[ABC-12] fix typo\n"), "fix typo"), "committed abc1234: [ABC-12] fix typo");
  // A subject that starts with `-` or `#` is kept; none from git: the one typed.
  assert.equal(commitMessage(ok("abc1234\n-x\n"), "-x"), "committed abc1234: -x");
  assert.equal(commitMessage(ok("abc1234\n"), "first"), "committed abc1234: first");
  // Nothing (a non-UTF-8 stdout through `spawnHostProcess`, INV §8 P17), not an id, or a failed read.
  assert.equal(commitMessage(ok(""), "first"), "committed: first");
  assert.equal(commitMessage(ok("fatal: bad\n"), "first"), "committed: first");
  assert.equal(commitMessage({ code: 128, stdout: "abc1234\nfirst\n", stderr: "fatal", timedOut: false }, "first"), "committed: first");
});
