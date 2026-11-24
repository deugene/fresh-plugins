#!/usr/bin/env node
// Drives git-sidebar in a real Fresh, from outside: Fresh runs in a detached
// tmux session under an isolated HOME and socket dir, and each subcommand is
// one action or observation. See SKILL.md next to this file.
//
//   node driver.mjs start [--repo PATH | --fixture NAME] [--size 140x40] [--no-explorer]
//   node driver.mjs screen [--color] [--name NAME]
//   node driver.mjs keys KEY...                 tmux key names: Down Space Enter Escape C-p ...
//   node driver.mjs type TEXT                   literal text
//   node driver.mjs click TEXT [--on TEXT2] [--nth N] [--below REGEX] [--right]
//   node driver.mjs wait REGEX [--gone] [--timeout MS]
//   node driver.mjs eval 'JS' | eval -          `fresh --cmd script run` against this instance
//   node driver.mjs cmd "Git Sidebar: Stage All"
//   node driver.mjs git ARGS...                 git -C <repo> ARGS
//   node driver.mjs log [REGEX]
//   node driver.mjs stop
//
// Actions (keys, type, click, cmd) wait for the screen to settle and print
// nothing unless given --show.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR = process.env.GS_DRIVE_DIR ?? "/tmp/gs-drive";
const SESSION = process.env.GS_DRIVE_SESSION ?? "gs-drive";
const HOME = path.join(DIR, "home");
// Fresh puts its control sockets in $XDG_RUNTIME_DIR/fresh, else in the
// shared /tmp/fresh-$UID, which the user's own editors use too.
const RUN = path.join(DIR, "run");
const FIX = path.join(DIR, "fix");
const TOKEN = path.join(DIR, "token.env");
const SHOTS = path.join(DIR, "shots");
const STATE = path.join(DIR, "state.json");
const LOGS = path.join(HOME, ".local/state/fresh/logs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (msg, code = 1) => {
  console.error(`driver: ${msg}`);
  process.exit(code);
};

function tmux(...args) {
  return execFileSync("tmux", args, { encoding: "utf8" });
}
function running() {
  return spawnSync("tmux", ["has-session", "-t", `=${SESSION}`]).status === 0;
}
function state() {
  if (!running() || !fs.existsSync(STATE)) die(`not running; start it with: node ${rel()} start`);
  return JSON.parse(fs.readFileSync(STATE, "utf8"));
}
function rel() {
  return path.relative(process.cwd(), fileURLToPath(import.meta.url)) || "driver.mjs";
}
function capture(color = false) {
  return tmux("capture-pane", "-t", SESSION, "-p", ...(color ? ["-e"] : []));
}
function lines() {
  return capture().split("\n");
}

/** Waits until two captures 150 ms apart match, at most `max` ms. */
async function settle(min = 250, max = 3000) {
  await sleep(min);
  const end = Date.now() + max;
  let prev = capture();
  while (Date.now() < end) {
    await sleep(150);
    const next = capture();
    if (next === prev) return;
    prev = next;
  }
}

async function waitFor(re, { gone = false, timeout = 10000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(capture()) !== gone) return true;
    await sleep(150);
  }
  return false;
}

/** Splits argv into positionals and --flags (a flag takes the next value unless boolean). */
function parse(argv, booleans = []) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.length > 2) {
      const k = a.slice(2);
      if (booleans.includes(k)) opt[k] = true;
      else {
        if (i + 1 >= argv.length) die(`${a} needs a value`);
        opt[k] = argv[++i];
      }
    } else pos.push(a);
  }
  return { pos, opt };
}

function scriptEnv() {
  if (!fs.existsSync(TOKEN)) die(`no ${TOKEN}: init.ts did not mint a token (see SKILL.md, Troubleshooting)`);
  const env = { ...process.env, HOME, XDG_RUNTIME_DIR: RUN };
  for (const line of fs.readFileSync(TOKEN, "utf8").split("\n")) {
    const m = /^(FRESH_SESSION|FRESH_CMD_TOKEN)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function saveShot(text, name, ext) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const n = fs.readdirSync(SHOTS).length + 1;
  const file = path.join(SHOTS, `${String(n).padStart(3, "0")}${name ? `-${name}` : ""}.${ext}`);
  fs.writeFileSync(file, text);
  return file;
}

async function show(opt) {
  if (opt.show) process.stdout.write(capture());
}

// ---------------------------------------------------------------- commands

async function start(argv) {
  const { opt } = parse(argv, ["no-explorer"]);
  if (running()) await stop();
  const [cols, rows] = (opt.size ?? "140x40").split("x").map(Number);
  if (!cols || !rows) die("--size is COLSxROWS, e.g. 140x40");

  for (const d of [HOME, RUN, SHOTS, TOKEN]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });

  let repo;
  if (opt.repo) repo = fs.realpathSync(opt.repo);
  else {
    const out = execFileSync("bash", [path.join(UNIT, "tests/live/fixture.sh"), opt.fixture ?? "acceptance"], {
      encoding: "utf8",
      env: { ...process.env, GS_LIVE_BASE: FIX },
    });
    repo = fs.realpathSync(out.trim().split("\n").pop());
  }

  // The package, linked as Fresh's package manager would install it.
  const pkgs = path.join(HOME, ".config/fresh/plugins/packages");
  fs.mkdirSync(pkgs, { recursive: true });
  fs.symlinkSync(UNIT, path.join(pkgs, "git-sidebar"));

  // `fresh --cmd script run` needs a FRESH_CMD_TOKEN, which Fresh mints only
  // into a terminal created with allowScript. This one writes its env to
  // TOKEN and idles. It needs a split of its own (without `direction` it
  // opens as a focused tab that eats keys), which is closed again so the
  // layout is the usual one; the terminal lives on as a hidden buffer.
  // Even so, keys go to that terminal until a mouse click lands on a pane
  // (focusSplit, before or after the close, does not help), so start clicks.
  // QuickJS rejects a top-level await here, hence the IIFE.
  fs.writeFileSync(
    path.join(HOME, ".config/fresh/init.ts"),
    `// Written by run-git-sidebar/driver.mjs: mints a script token.
(async () => {
  const t = await editor.createTerminal({
    command: ["/bin/sh", "-c", 'env | grep "^FRESH_" > "$1"; exec sleep 2147483647', "sh", ${JSON.stringify(TOKEN)}],
    allowScript: true, focus: false, title: "gs-driver-token", direction: "horizontal", ratio: 0.9,
  });
  if (t.splitId !== null) editor.closeSplit(t.splitId);
  editor.debug("gs-driver: token terminal " + JSON.stringify(t));
})().catch((e) => editor.debug("gs-driver: token terminal failed: " + e));
`,
  );

  const fresh = execFileSync("sh", ["-c", "command -v fresh"], { encoding: "utf8" }).trim();
  if (!fresh) die("fresh is not on PATH");
  // tmux runs the command with its server's environment, not ours, so pass
  // everything that matters explicitly. FRESH_SESSION/FRESH_CMD_TOKEN would
  // point the nested Fresh at the editor this shell runs in.
  const launch = [
    "env", "-u", "FRESH_SESSION", "-u", "FRESH_CMD_TOKEN",
    `PATH=${process.env.PATH}`, `HOME=${HOME}`, `XDG_RUNTIME_DIR=${RUN}`,
    "sh", "-c", `"$0" --simple; echo "[fresh exited $?]"; exec sleep 86400`, fresh,
  ];
  tmux("new-session", "-d", "-s", SESSION, "-x", String(cols), "-y", String(rows), "-c", repo, ...launch);

  const end = Date.now() + 15000;
  while (!fs.existsSync(TOKEN) && Date.now() < end) await sleep(150);
  if (!(await waitFor(/File\s+Edit/, { timeout: Math.max(0, end - Date.now()) }))) {
    process.stdout.write(capture());
    die("Fresh did not draw its menu bar within 15 s");
  }
  const logs = fs.existsSync(LOGS) ? fs.readdirSync(LOGS).filter((f) => /^fresh-\d+\.log$/.test(f)) : [];
  const pid = logs.length ? Number(/\d+/.exec(logs[0])[0]) : null;
  const logFile = pid ? path.join(LOGS, `fresh-${pid}.log`) : null;
  fs.writeFileSync(STATE, JSON.stringify({ repo, pid, log: logFile, cols, rows }, null, 2));

  // Wait for init.ts to close the token split, then click inside the empty
  // buffer (row 3 is its first line, right of any sidebar) to take the keys
  // back from the hidden terminal.
  const tokenDone = /gs-driver: token terminal/;
  while (Date.now() < end && !(logFile && fs.existsSync(logFile) && tokenDone.test(fs.readFileSync(logFile, "utf8")))) {
    await sleep(150);
  }
  await settle();
  const [cx, cy] = [Math.floor(cols * 0.75), 3];
  tmux("send-keys", "-t", SESSION, "-l", `\x1b[<0;${cx};${cy}M`);
  await sleep(300);
  tmux("send-keys", "-t", SESSION, "-l", `\x1b[<0;${cx};${cy}m`);
  await settle();

  if (!opt["no-explorer"]) {
    // The explorer starts hidden in a new home. Retry Ctrl+B in case one is
    // dropped while Fresh is still starting.
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      tmux("send-keys", "-t", SESSION, "C-b");
      ok = await waitFor(/[├┌] [▼▶] Git\b/, { timeout: 2500 });
    }
    await settle();
    if (!ok) {
      process.stdout.write(capture());
      die("no Git section on screen (outside a repository there is none, R1)", 2);
    }
  }
  console.error(`driver: running in tmux session ${SESSION}; repo ${repo}; log ${pid ? path.join(LOGS, `fresh-${pid}.log`) : "?"}`);
  process.stdout.write(capture());
}

function screen(argv) {
  state();
  const { opt } = parse(argv, ["color"]);
  const text = capture(!!opt.color);
  const file = saveShot(text, opt.name, opt.color ? "ansi" : "txt");
  process.stdout.write(text);
  console.error(`driver: saved ${file}`);
}

async function keys(argv) {
  state();
  const { pos, opt } = parse(argv, ["show"]);
  if (!pos.length) die("keys needs at least one key");
  for (const k of pos) {
    tmux("send-keys", "-t", SESSION, k);
    await sleep(60);
  }
  await settle();
  await show(opt);
}

async function type(argv) {
  state();
  const { pos, opt } = parse(argv, ["show"]);
  tmux("send-keys", "-t", SESSION, "-l", pos.join(" "));
  await settle();
  await show(opt);
}

async function click(argv) {
  state();
  const { pos, opt } = parse(argv, ["right", "show"]);
  const text = pos.join(" ");
  if (!text) die("click needs the text to click");
  const ls = lines();
  let from = 0;
  if (opt.below) {
    const re = new RegExp(opt.below);
    from = ls.findIndex((l) => re.test(l)) + 1;
    if (from === 0) die(`--below /${opt.below}/ matches no line`);
  }
  const hits = [];
  for (let r = from; r < ls.length; r++) {
    for (let i = ls[r].indexOf(text); i !== -1; i = ls[r].indexOf(text, i + 1)) hits.push({ r, i });
  }
  const nth = Number(opt.nth ?? 1);
  const hit = hits[nth - 1];
  if (!hit) die(`"${text}" found ${hits.length} time(s) on screen${opt.below ? ` below /${opt.below}/` : ""}; wanted #${nth}`);
  let [at, len] = [hit.i, text.length];
  if (opt.on) {
    const j = ls[hit.r].indexOf(opt.on, hit.i + text.length);
    if (j === -1) die(`"${opt.on}" is not on the line after "${text}": ${ls[hit.r].trimEnd()}`);
    [at, len] = [j, opt.on.length];
  }
  // Columns are counted in code points: right for this UI's box drawing and
  // arrows, wrong after a double-width character on the same line.
  const col = Array.from(ls[hit.r].slice(0, at + Math.floor(len / 2))).length + 1;
  const row = hit.r + 1;
  const b = opt.right ? 2 : 0;
  // SGR mouse: press, hold 300 ms, release, like the INV §8 live probes.
  tmux("send-keys", "-t", SESSION, "-l", `\x1b[<${b};${col};${row}M`);
  await sleep(300);
  tmux("send-keys", "-t", SESSION, "-l", `\x1b[<${b};${col};${row}m`);
  await settle(400);
  console.error(`driver: ${opt.right ? "right-" : ""}clicked col ${col} row ${row}: ${ls[hit.r].trim().slice(0, 60)}`);
  await show(opt);
}

async function wait(argv) {
  state();
  const { pos, opt } = parse(argv, ["gone"]);
  if (!pos[0]) die("wait needs a regex");
  const ok = await waitFor(new RegExp(pos[0]), { gone: !!opt.gone, timeout: Number(opt.timeout ?? 10000) });
  if (!ok) {
    process.stdout.write(capture());
    die(`timed out waiting for /${pos[0]}/${opt.gone ? " to go" : ""}`);
  }
}

function evalScript(argv) {
  const { repo } = state();
  const src = argv[0] === "-" || argv.length === 0 ? fs.readFileSync(0, "utf8") : argv.join(" ");
  const r = spawnSync("fresh", ["--cmd", "script", "run", "-"], { input: src, cwd: repo, env: scriptEnv(), encoding: "utf8" });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.stdout && !r.stdout.endsWith("\n")) process.stdout.write("\n");
  process.exit(r.status ?? 1);
}

async function cmd(argv) {
  const { repo } = state();
  const { pos, opt } = parse(argv, ["show"]);
  const r = spawnSync("fresh", ["--cmd", "command", "run", pos.join(" ")], { cwd: repo, env: scriptEnv(), encoding: "utf8" });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  await settle();
  await show(opt);
}

function git(argv) {
  const { repo } = state();
  const r = spawnSync("git", ["-C", repo, ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

function log(argv) {
  const { log: file } = state();
  if (!file || !fs.existsSync(file)) die("no log file recorded");
  const re = new RegExp(argv[0] ?? "git-sidebar:| WARN | ERROR ");
  // eslint-disable-next-line no-control-regex
  const plain = fs.readFileSync(file, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  for (const l of plain.split("\n")) if (re.test(l)) console.log(l);
  console.error(`driver: ${file}`);
}

async function stop() {
  const pid = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")).pid : null;
  // Killing the session hangs up the pane, which ends a --simple Fresh (it
  // has no daemon) and the token terminal's sleep with it.
  if (running()) tmux("kill-session", "-t", `=${SESSION}`);
  const alive = () => {
    try {
      if (pid === null || !process.kill(pid, 0)) return false;
    } catch {
      return false;
    }
    // A zombie still answers kill(pid, 0). In a container whose PID 1 does
    // not reap (docker run without --init), every exited Fresh stays one.
    try {
      return !/^State:\s*Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    } catch {
      return true; // no /proc (macOS): kill(pid, 0) is the answer
    }
  };
  for (let i = 0; i < 20 && alive(); i++) await sleep(150);
  if (alive()) console.error(`driver: Fresh pid ${pid} is still running after the session was killed`);
  // Its sockets stay behind after it exits.
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
  console.error("driver: stopped");
}

const [sub, ...rest] = process.argv.slice(2);
const table = { start, screen, keys, type, click, wait, eval: evalScript, cmd, git, log, stop };
if (!table[sub]) die(`usage: node ${rel()} <${Object.keys(table).join("|")}> ...  (see the header of this file)`, 2);
await table[sub](rest);
