import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GitResult } from "../lib/git.ts";
import {
  classifyPull,
  classifyPush,
  configuredSsh,
  HEAD_REF_ARGS,
  parseRemotes,
  parseUpstream,
  publishArgs,
  pullArgs,
  pullTargetCheck,
  pushArgs,
  remoteArgv,
  remoteEnv,
  remoteReason,
  REMOTES_ARGS,
  SSH_CONFIG_ARGS,
  sshCommand,
  upstreamArgs,
  upstreamName,
} from "../lib/remote.ts";
import { recorded } from "./helpers.ts";

/** A recorded pull or push: `rc N`, then `--- stdout` and `--- stderr`. */
function outcome(name: string): GitResult {
  const text = recorded(`remote-${name}.txt`);
  const m = /^rc (\d+)\n--- stdout\n([\s\S]*?)--- stderr\n([\s\S]*)$/.exec(text);
  if (m === null) throw new Error(`unreadable ${name}`);
  return { code: Number(m[1]), stdout: m[2], stderr: m[3], timedOut: false };
}
const ORIGIN = { remote: "origin", ref: "refs/heads/main" };
const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: "", timedOut: false });

test("the reads before a pull or push are lock-free (R11)", () => {
  assert.deepEqual(upstreamArgs("feat/x"), ["--no-optional-locks", "for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", "refs/heads/feat/x"]);
  assert.deepEqual(REMOTES_ARGS, ["--no-optional-locks", "remote"]);
  assert.deepEqual(SSH_CONFIG_ARGS, ["--no-optional-locks", "config", "--get", "core.sshCommand"]);
  assert.deepEqual(HEAD_REF_ARGS, ["--no-optional-locks", "symbolic-ref", "-q", "HEAD"]);
});

test("pullTargetCheck: a queued pull runs only while the branch asked for is checked out (R34)", () => {
  assert.equal(pullTargetCheck(ok("refs/heads/main\n"), "main", "/repo"), null);
  assert.equal(pullTargetCheck(ok("refs/heads/other\n"), "main", "/repo"), "pull not run: the checked-out branch is no longer main");
  // rc 1 and nothing: HEAD is detached now.
  assert.equal(pullTargetCheck({ code: 1, stdout: "", stderr: "", timedOut: false }, "main", "/repo"), "pull not run: the checked-out branch is no longer main");
  assert.equal(
    pullTargetCheck({ code: 128, stdout: "", stderr: "fatal: not a git repository: /repo/.git\n", timedOut: false }, "main", "/repo"),
    "pull not run: could not read the checked-out branch: not a git repository: .git",
  );
  assert.equal(pullTargetCheck({ code: -1, stdout: "", stderr: "timed out after 10000 ms", timedOut: true }, "main", "/repo"), "pull not run: could not read the checked-out branch: git timed out");
});

test("configuredSsh: set, unset (rc 1), or a failed read that stops the pull or push rather than replace the user's command (R36)", () => {
  assert.deepEqual(configuredSsh(ok("ssh -i ~/.ssh/work\n"), "push", "/repo"), { command: "ssh -i ~/.ssh/work" });
  assert.deepEqual(configuredSsh({ code: 1, stdout: "", stderr: "", timedOut: false }, "push", "/repo"), { command: null });
  assert.deepEqual(configuredSsh({ code: -1, stdout: "", stderr: "timed out after 10000 ms", timedOut: true }, "push", "/repo"), {
    refused: "push not run: could not read core.sshCommand: git timed out",
  });
  assert.deepEqual(configuredSsh({ code: 128, stdout: "", stderr: "fatal: bad config line 3 in file /repo/.git/config\n", timedOut: false }, "pull", "/repo"), {
    refused: "pull not run: could not read core.sshCommand: bad config line 3 in file .git/config",
  });
});

test("parseUpstream, parseRemotes, upstreamName", () => {
  assert.deepEqual(parseUpstream(ok("origin\0refs/heads/other\n")), { remote: "origin", ref: "refs/heads/other" });
  assert.equal(parseUpstream(ok("\0\n")), null, "no upstream");
  assert.equal(parseUpstream(ok("")), null);
  assert.equal(parseUpstream({ code: 128, stdout: "", stderr: "", timedOut: false }), null);
  assert.deepEqual(parseRemotes(ok("backup\norigin\n")), ["backup", "origin"]);
  assert.deepEqual(parseRemotes(ok("")), []);
  assert.equal(upstreamName({ remote: "origin", ref: "refs/heads/feat/x" }), "origin/feat/x");
});

test("argv: pull, push and publish, as VS Code runs them, a pull never autostashing; record.sh records the same (R34, R35)", () => {
  assert.deepEqual(pullArgs(ORIGIN), ["pull", "--tags", "--no-autostash", "origin", "refs/heads/main"]);
  assert.deepEqual(pushArgs({ remote: "origin", ref: "refs/heads/other" }, "main"), ["push", "origin", "refs/heads/main:refs/heads/other"]);
  assert.deepEqual(publishArgs("backup", "topic"), ["push", "-u", "backup", "refs/heads/topic:refs/heads/topic"]);
  const script = readFileSync(new URL("./fixtures/record.sh", import.meta.url), "utf8");
  assert.ok(script.includes(`PULL=(${pullArgs(ORIGIN).join(" ")})`));
  assert.ok(script.includes(`PUSH=(${pushArgs(ORIGIN, "main").join(" ")})`));
  assert.ok(script.includes(`push -u origin refs/heads/topic:refs/heads/topic`));
  // Every pull recorded with another remote or ref keeps the same options.
  for (const line of script.split("\n").filter((l) => /record_remote \S+ \S+ pull /.test(l))) assert.ok(line.includes("pull --tags --no-autostash "), line);
  // And the plugin's environment, the C locale included.
  assert.ok(script.includes(`export ${remoteEnv(null).join(" ")}\n`));
});

test("the environment: git's messages in English, no prompts, no askpass, ssh in batch mode; env runs git (R36, INV §8 P39 a, d, j)", () => {
  assert.deepEqual(remoteEnv("ssh -o BatchMode=yes -o ConnectTimeout=10"), [
    "LC_ALL=C",
    "GIT_TERMINAL_PROMPT=0",
    "GIT_ASKPASS=",
    "SSH_ASKPASS=false",
    "SSH_ASKPASS_REQUIRE=force",
    "GIT_SSH_COMMAND=ssh -o BatchMode=yes -o ConnectTimeout=10",
  ]);
  assert.deepEqual(remoteEnv(null), ["LC_ALL=C", "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=false", "SSH_ASKPASS_REQUIRE=force"]);
  assert.deepEqual(remoteArgv(["pull", "--tags", "o", "refs/heads/m"], ["A=1"]), ["A=1", "git", "pull", "--tags", "o", "refs/heads/m"]);
});

test("sshCommand: git's order, the options appended to OpenSSH only (R36)", () => {
  const OPTS = "-o BatchMode=yes -o ConnectTimeout=10";
  const none = { envCommand: null, configured: null, envSsh: null };
  // Nothing set: plain ssh.
  assert.equal(sshCommand(none), `ssh ${OPTS}`);
  // Each source alone.
  assert.equal(sshCommand({ ...none, envCommand: "ssh -i ~/.ssh/k" }), `ssh -i ~/.ssh/k ${OPTS}`);
  assert.equal(sshCommand({ ...none, configured: "/usr/bin/ssh -F /dev/null" }), `/usr/bin/ssh -F /dev/null ${OPTS}`);
  assert.equal(sshCommand({ ...none, envSsh: "/opt/my ssh/ssh" }), `'/opt/my ssh/ssh' ${OPTS}`, "GIT_SSH is a path, quoted");
  // GIT_SSH_COMMAND before core.sshCommand before GIT_SSH.
  assert.equal(sshCommand({ envCommand: "ssh -p 2", configured: "ssh -p 3", envSsh: "/x/ssh" }), `ssh -p 2 ${OPTS}`);
  assert.equal(sshCommand({ envCommand: null, configured: "ssh -p 3", envSsh: "/x/ssh" }), `ssh -p 3 ${OPTS}`);
  assert.equal(sshCommand({ envCommand: "", configured: "  ", envSsh: "/x/ssh" }), `/x/ssh ${OPTS}`, "empty values count as unset");
  // A program that is not OpenSSH keeps the user's setting (R36's exception).
  assert.equal(sshCommand({ ...none, configured: "plink -batch" }), null);
  assert.equal(sshCommand({ ...none, envSsh: "C:\\\\PuTTY\\\\plink.exe" }), null);
  assert.equal(sshCommand({ ...none, envCommand: "/home/u/bin/ssh-wrapper" }), null);
  assert.equal(sshCommand({ envCommand: "plink", configured: "ssh", envSsh: null }), null, "the first one set decides");
  assert.equal(sshCommand({ ...none, configured: '"/opt/open ssh/ssh" -v' }), `"/opt/open ssh/ssh" -v ${OPTS}`);
});

test("classifyPull on every recorded pull (R34, R36, INV §8 P38)", () => {
  const p = (name: string) => classifyPull(outcome(name), "origin/main", "/repo");
  assert.deepEqual(p("pull-fast-forward"), { ok: true, message: "pulled from origin/main" });
  assert.deepEqual(p("pull-rebase"), { ok: true, message: "pulled from origin/main" });
  assert.deepEqual(p("pull-up-to-date"), { ok: true, message: "already up to date with origin/main" });
  // pull.rebase on a branch only ahead: rebase's own words.
  assert.deepEqual(p("pull-rebase-up-to-date"), { ok: true, message: "already up to date with origin/main" });
  assert.deepEqual(classifyPull(ok("Current branch feat/x-1 is up to date.\n"), "origin/feat/x-1"), { ok: true, message: "already up to date with origin/feat/x-1" });
  assert.deepEqual(p("pull-conflict"), { ok: false, message: "pulled from origin/main with conflicts: resolve them under Changes" });
  assert.deepEqual(p("pull-rebase-conflict"), { ok: false, message: "pulled from origin/main with conflicts: resolve them under Changes" });
  assert.deepEqual(p("pull-diverged"), { ok: false, message: "could not pull: Need to specify how to reconcile divergent branches." });
  assert.deepEqual(p("pull-ff-only-diverged"), { ok: false, message: "could not pull: Not possible to fast-forward, aborting." });
  assert.deepEqual(p("pull-local-changes"), { ok: false, message: "could not pull: Your local changes to the following files would be overwritten by merge:" });
  assert.deepEqual(p("pull-rebase-unstaged"), { ok: false, message: "could not pull: cannot pull with rebase: You have unstaged changes." });
  // The user's rebase.autoStash or merge.autoStash: refused the same way,
  // with nothing stashed (--no-autostash).
  assert.deepEqual(p("pull-rebase-autostash"), { ok: false, message: "could not pull: cannot pull with rebase: You have unstaged changes." });
  assert.deepEqual(p("pull-merge-autostash"), { ok: false, message: "could not pull: Your local changes to the following files would be overwritten by merge:" });
  assert.deepEqual(p("pull-unmerged"), { ok: false, message: "could not pull: Pulling is not possible because you have unmerged files." });
  assert.deepEqual(p("pull-unconcluded-merge"), { ok: false, message: "could not pull: You have not concluded your merge (MERGE_HEAD exists)." });
  assert.deepEqual(p("pull-no-remote-branch"), { ok: false, message: "could not pull: couldn't find remote ref refs/heads/nosuch" });
  assert.deepEqual(p("pull-credentials"), {
    ok: false,
    message: "git needs credentials it can't ask for here: could not read Username for 'http://127.0.0.1:18441': terminal prompts disabled",
  });
});

test("classifyPush on every recorded push (R35, R36, INV §8 P38)", () => {
  const p = (name: string, to = "origin/main") => classifyPush(outcome(name), to, "/repo");
  assert.deepEqual(p("push-ok"), { ok: true, message: "pushed to origin/main" });
  assert.deepEqual(p("push-other-name", "origin/other"), { ok: true, message: "pushed to origin/other" });
  assert.deepEqual(p("publish", "origin/topic"), { ok: true, message: "pushed to origin/topic" });
  assert.deepEqual(p("push-up-to-date"), { ok: true, message: "nothing to push to origin/main" });
  assert.deepEqual(p("push-rejected-fetch-first"), { ok: false, message: "push rejected, pull first: ! [rejected] main -> main (fetch first)" });
  assert.deepEqual(p("push-rejected-non-ff"), { ok: false, message: "push rejected, pull first: ! [rejected] main -> main (non-fast-forward)" });
  assert.deepEqual(p("push-hook-declined", "origin/topic"), { ok: false, message: "could not push: remote: remote: nope from the hook" });
  assert.deepEqual(p("push-no-remote"), { ok: false, message: "could not push: 'nowhere' does not appear to be a git repository" });
  assert.deepEqual(p("push-unreachable"), { ok: false, message: "could not push: ssh: connect to host 127.0.0.1 port 1: Connection refused" });
});

test("credentials over ssh, from the live probes' messages (R36, INV §8 P39 a)", () => {
  const ssh = (stderr: string): GitResult => ({ code: 128, stdout: "", stderr, timedOut: false });
  assert.match(classifyPush(ssh("Host key verification failed.\r\nfatal: Could not read from remote repository.\n"), "o/m").message, /^git needs credentials it can't ask for here: Host key verification failed\.$/);
  assert.match(classifyPull(ssh("git@h: Permission denied (publickey,password).\r\nfatal: Could not read from remote repository.\n"), "o/m").message, /^git needs credentials/);
  // An empty result still says something.
  assert.equal(remoteReason({ code: 1, stdout: "", stderr: "", timedOut: false }), "git exited with 1");
});
