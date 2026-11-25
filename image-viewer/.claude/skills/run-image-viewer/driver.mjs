#!/usr/bin/env node
// Drives image-viewer in a real Fresh, from outside: Fresh runs in a detached
// tmux session under an isolated HOME and socket dir, and each subcommand is
// one action or observation. See SKILL.md next to this file.
//
//   node driver.mjs start [--size 200x60] [--path DIRS] [--env K=V]... [--explorer] [--cwd DIR] [--rebuild] [FILE...]
//                                               builds the images once; --rebuild runs tests/live/images.sh again
//   node driver.mjs screen [--color] [--name NAME]
//   node driver.mjs cell ROW COL [COL...]       a cell's char, fg and bg (1-based screen coordinates)
//   node driver.mjs keys KEY... [--gap MS]      tmux key names: Down Enter Escape C-p M-w ...; --gap between keys (60)
//   node driver.mjs type TEXT                   literal text
//   node driver.mjs click TEXT [--nth N] [--below REGEX] [--explorer]
//                                               --explorer: only the explorer's rows, never the tab bar
//   node driver.mjs mouse BUTTON COL ROW        a raw SGR mouse event (64/65 wheel, 68/69 Shift+wheel, 66/67 horizontal)
//   node driver.mjs wait REGEX [--gone] [--timeout MS]
//   node driver.mjs time STEP... [--until RE] [--change] [--count RE] [--interval MS] [--timeout MS]
//   node driver.mjs eval 'JS' | eval -          `fresh --cmd script run` against this instance
//   node driver.mjs cmd "Image Viewer: Show Image"
//   node driver.mjs log [REGEX]
//   node driver.mjs stop
//
// Actions (keys, type, click, mouse, cmd) wait for the screen to settle and
// print nothing unless given --show.
//
// Environment, read on every call, so set it for each one:
//   IV_DRIVE_DIR      state, isolated HOME, images, shots (default /tmp/iv-drive)
//   IV_DRIVE_SESSION  the tmux session's name (default iv-drive)
//   IV_DRIVE_SOCKET   a tmux socket of its own (`tmux -L NAME`); unset, the default server
// Set all three to run beside another driver, or beside your own tmux.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UNIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// `||`, not `??`: an empty IV_DRIVE_DIR would make every path below relative
// to the cwd, and `start` wipes them.
const DIR = process.env.IV_DRIVE_DIR || "/tmp/iv-drive";
const SESSION = process.env.IV_DRIVE_SESSION || "iv-drive";
// `-L` before every tmux command: the session then lives on a server of its
// own, out of reach of the default one's sessions, and theirs of it.
const SOCKET = process.env.IV_DRIVE_SOCKET ? ["-L", process.env.IV_DRIVE_SOCKET] : [];
const HOME = path.join(DIR, "home");
// Fresh puts its control sockets in $XDG_RUNTIME_DIR/fresh, else in the
// shared /tmp/fresh-$UID, which the user's own editors use too.
const RUN = path.join(DIR, "run");
const IMGS = path.join(DIR, "imgs");
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
  return execFileSync("tmux", [...SOCKET, ...args], { encoding: "utf8" });
}
function running() {
  return spawnSync("tmux", [...SOCKET, "has-session", "-t", `=${SESSION}`]).status === 0;
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
  let prev = capture(true);
  while (Date.now() < end) {
    await sleep(150);
    const next = capture(true);
    if (next === prev) return;
    prev = next;
  }
}

async function waitFor(re, { gone = false, timeout = 10000 } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (re.test(capture()) !== gone) return true;
    await sleep(100);
  }
  return false;
}

/** Splits argv into positionals and --flags (a flag takes the next value unless boolean). */
function parse(argv, booleans = [], repeatable = []) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.length > 2) {
      const k = a.slice(2);
      if (booleans.includes(k)) opt[k] = true;
      else {
        if (i + 1 >= argv.length) die(`${a} needs a value`);
        if (repeatable.includes(k)) (opt[k] ??= []).push(argv[++i]);
        else opt[k] = argv[++i];
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

/** The cells of one captured line: [char, fg, bg], colours as [r,g,b] or null.
 *  `pen` holds the colours in effect where the line starts, and is left at
 *  those where it ends: `capture-pane -e` writes no escape at the start of a
 *  line whose first cells keep the colours the line above ended with. */
function cellsOf(line, pen = { fg: null, bg: null }) {
  const out = [];
  let { fg, bg } = pen;
  for (let i = 0; i < line.length; ) {
    const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
    if (m) {
      const p = m[1].split(";").map((x) => (x === "" ? 0 : Number(x)));
      for (let j = 0; j < p.length; j++) {
        if (p[j] === 0) fg = bg = null;
        else if (p[j] === 38 && p[j + 1] === 2) (fg = p.slice(j + 2, j + 5)), (j += 4);
        else if (p[j] === 48 && p[j + 1] === 2) (bg = p.slice(j + 2, j + 5)), (j += 4);
        else if ((p[j] === 38 || p[j] === 48) && p[j + 1] === 5) (p[j] === 38 ? (fg = [`i${p[j + 2]}`]) : (bg = [`i${p[j + 2]}`])), (j += 2);
        else if (p[j] === 39) fg = null;
        else if (p[j] === 49) bg = null;
      }
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    out.push([ch, fg, bg]);
    i += ch.length;
  }
  pen.fg = fg;
  pen.bg = bg;
  return out;
}

// ---------------------------------------------------------------- commands

async function start(argv) {
  const { pos, opt } = parse(argv, ["explorer", "rebuild"], ["env"]);
  // Before anything is stopped or wiped: `command -v` exits 1, and execFileSync throws,
  // when there is no fresh.
  let fresh = "";
  try {
    fresh = execFileSync("sh", ["-c", "command -v fresh"], { encoding: "utf8" }).trim();
  } catch {
    // reported below
  }
  if (!fresh) die("fresh is not on PATH");
  if (running()) await stop();
  const [cols, rows] = (opt.size ?? "200x60").split("x").map(Number);
  if (!cols || !rows) die("--size is COLSxROWS, e.g. 200x60");

  for (const d of [HOME, RUN, SHOTS, TOKEN]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  if (opt.rebuild || !fs.existsSync(path.join(IMGS, "quadrants.png"))) {
    execFileSync("bash", [path.join(UNIT, "tests/live/images.sh"), IMGS], { stdio: ["ignore", "ignore", "inherit"] });
  }
  const cwd = fs.realpathSync(opt.cwd ?? IMGS);

  // The package, linked as Fresh's package manager would install it.
  const pkgs = path.join(HOME, ".config/fresh/plugins/packages");
  fs.mkdirSync(pkgs, { recursive: true });
  fs.symlinkSync(UNIT, path.join(pkgs, "image-viewer"));

  // `fresh --cmd script run` needs a FRESH_CMD_TOKEN, which Fresh mints only
  // into a terminal created with allowScript (git-sidebar's run skill). Its
  // split is closed again; keys go to it until a click lands on a pane.
  fs.writeFileSync(
    path.join(HOME, ".config/fresh/init.ts"),
    `// Written by run-image-viewer/driver.mjs: mints a script token.
(async () => {
  const t = await editor.createTerminal({
    command: ["/bin/sh", "-c", '/usr/bin/env | /usr/bin/grep "^FRESH_" > "$1"; exec /bin/sleep 2147483647', "sh", ${JSON.stringify(TOKEN)}],
    allowScript: true, focus: false, title: "iv-driver-token", direction: "horizontal", ratio: 0.9,
  });
  if (t.splitId !== null) editor.closeSplit(t.splitId);
  editor.debug("iv-driver: token terminal " + JSON.stringify(t));
})().catch((e) => editor.debug("iv-driver: token terminal failed: " + e));
`,
  );

  // tmux runs the command with its server's environment, not ours, so pass
  // everything that matters explicitly. FRESH_SESSION/FRESH_CMD_TOKEN would
  // point the nested Fresh at the editor this shell runs in.
  const launch = [
    "/usr/bin/env", "-u", "FRESH_SESSION", "-u", "FRESH_CMD_TOKEN",
    `PATH=${opt.path ?? process.env.PATH}`, `HOME=${HOME}`, `XDG_RUNTIME_DIR=${RUN}`, "COLORTERM=truecolor",
    ...(opt.env ?? []),
    "/bin/sh", "-c", `"$0" --simple "$@"; echo "[fresh exited $?]"; exec /bin/sleep 86400`, fresh, ...pos,
  ];
  tmux("new-session", "-d", "-s", SESSION, "-x", String(cols), "-y", String(rows), "-c", cwd, ...launch);

  const end = Date.now() + 15000;
  while (!fs.existsSync(TOKEN) && Date.now() < end) await sleep(150);
  if (!(await waitFor(/File\s+Edit/, { timeout: Math.max(0, end - Date.now()) }))) {
    process.stdout.write(capture());
    die("Fresh did not draw its menu bar within 15 s");
  }
  const logs = fs.existsSync(LOGS) ? fs.readdirSync(LOGS).filter((f) => /^fresh-\d+\.log$/.test(f)) : [];
  const pid = logs.length ? Number(/\d+/.exec(logs[0])[0]) : null;
  const logFile = pid ? path.join(LOGS, `fresh-${pid}.log`) : null;
  fs.writeFileSync(STATE, JSON.stringify({ cwd, pid, log: logFile, cols, rows }, null, 2));

  // Wait for init.ts to close the token split, then click the last text row
  // (the image panel or an empty buffer, where a click changes nothing,
  // INV §8 P18) to take the keys back from the hidden terminal.
  const tokenDone = /iv-driver: token terminal/;
  while (Date.now() < end && !(logFile && fs.existsSync(logFile) && tokenDone.test(fs.readFileSync(logFile, "utf8")))) {
    await sleep(150);
  }
  await settle();
  await clickAt(Math.floor(cols * 0.75), rows - 2);
  await settle();
  if (opt.explorer) {
    tmux("send-keys", "-t", SESSION, "C-b");
    await waitFor(/File Explorer/, { timeout: 3000 });
    await settle();
  }
  console.error(`driver: running in tmux session ${SESSION}; cwd ${cwd}; log ${logFile ?? "?"}`);
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

function cell(argv) {
  state();
  const [row, ...cols] = argv.map(Number);
  if (!row || !cols.length) die("cell ROW COL [COL...]");
  const all = capture(true).split("\n");
  const pen = { fg: null, bg: null };
  for (const line of all.slice(0, row - 1)) cellsOf(line, pen);
  const cs = cellsOf(all[row - 1] ?? "", pen);
  for (const c of cols) console.log(JSON.stringify({ row, col: c, ch: cs[c - 1]?.[0] ?? null, fg: cs[c - 1]?.[1] ?? null, bg: cs[c - 1]?.[2] ?? null }));
}

async function keys(argv) {
  state();
  const { pos, opt } = parse(argv, ["show"]);
  if (!pos.length) die("keys needs at least one key");
  for (const k of pos) {
    tmux("send-keys", "-t", SESSION, k);
    await sleep(Number(opt.gap ?? 60));
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

/** An SGR mouse event at a 1-based cell: a press, held 200 ms, then the
 *  release. Wheel buttons (64 and up) have no release, so they send the
 *  press alone. */
async function clickAt(col, row, button = 0) {
  tmux("send-keys", "-t", SESSION, "-l", `\x1b[<${button};${col};${row}M`);
  if (button >= 64) return;
  await sleep(200);
  tmux("send-keys", "-t", SESSION, "-l", `\x1b[<${button};${col};${row}m`);
}

function findText(text, opt = {}) {
  const ls = lines();
  let from = 0;
  if (opt.below) {
    const re = new RegExp(opt.below);
    from = ls.findIndex((l) => re.test(l)) + 1;
    if (from === 0) die(`--below /${opt.below}/ matches no line`);
  }
  // --explorer: the rows under the explorer's header, left of the `┐` that
  // closes it. The tab bar shares the header's row, so a file's preview tab
  // is never taken for its explorer row.
  let border = Infinity;
  if (opt.explorer) {
    const head = ls.findIndex((l) => l.includes("File Explorer"));
    if (head === -1) die("--explorer: no file explorer on screen");
    const at = Array.from(ls[head].slice(0, ls[head].indexOf("File Explorer"))).length;
    border = Array.from(ls[head]).indexOf("┐", at);
    if (border === -1) die("--explorer: cannot find the explorer's right border");
    from = Math.max(from, head + 1);
  }
  const hits = [];
  for (let r = from; r < ls.length; r++) {
    for (let i = ls[r].indexOf(text); i !== -1; i = ls[r].indexOf(text, i + 1)) {
      if (Array.from(ls[r].slice(0, i + text.length)).length <= border) hits.push({ r, i });
    }
  }
  const hit = hits[Number(opt.nth ?? 1) - 1];
  if (!hit) die(`"${text}" found ${hits.length} time(s) on screen; wanted #${opt.nth ?? 1}`);
  // Columns in code points: right for this UI's box drawing.
  return { col: Array.from(ls[hit.r].slice(0, hit.i + Math.floor(text.length / 2))).length + 1, row: hit.r + 1, line: ls[hit.r] };
}

async function click(argv) {
  state();
  const { pos, opt } = parse(argv, ["show", "explorer"]);
  const text = pos.join(" ");
  if (!text) die("click needs the text to click");
  const { col, row, line } = findText(text, opt);
  await clickAt(col, row);
  await settle(400);
  console.error(`driver: clicked col ${col} row ${row}: ${line.trim().slice(0, 60)}`);
  await show(opt);
}

async function mouse(argv) {
  state();
  const { pos, opt } = parse(argv, ["show"]);
  const [b, col, row] = pos.map(Number);
  if (Number.isNaN(b) || !col || !row) die("mouse BUTTON COL ROW");
  await clickAt(col, row, b);
  await settle();
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

/** Frame sampling: runs STEPs (key:NAME, text:STR, click:TEXT,
 *  resize:COLSxROWS, sleep:MS, mark), then captures as fast as tmux allows. The clock starts at `mark`,
 *  or at the first step. Reports when the coloured screen first changed
 *  (--change), when --until first matched, and how long --count matched. */
async function time(argv) {
  state();
  const { pos, opt } = parse(argv, ["change"]);
  const until = opt.until ? new RegExp(opt.until) : null;
  const count = opt.count ? new RegExp(opt.count) : null;
  const timeout = Number(opt.timeout ?? 5000);
  const before = capture(true);
  let t0 = null;
  for (const s of pos) {
    const [kind, ...restParts] = s.split(":");
    const rest = restParts.join(":");
    if (kind === "mark") t0 = performance.now();
    else if (kind === "sleep") await sleep(Number(rest));
    else {
      t0 ??= performance.now();
      if (kind === "key") tmux("send-keys", "-t", SESSION, rest);
      else if (kind === "resize") {
        const [w, h] = rest.split("x");
        tmux("resize-window", "-t", SESSION, "-x", w, "-y", h);
      }
      else if (kind === "text") tmux("send-keys", "-t", SESSION, "-l", rest);
      else if (kind === "click") {
        const { col, row } = findText(rest);
        await clickAt(col, row);
      } else die(`unknown step ${s}`);
    }
  }
  t0 ??= performance.now();
  const out = { samples: 0, firstChange: null, until: null, count: 0, countFirst: null, countLast: null, settled: null };
  let last = before;
  let lastChange = null;
  while (performance.now() - t0 < timeout) {
    const color = capture(true);
    const plain = color.replace(/\x1b\[[0-9;]*m/g, "");
    const t = Math.round(performance.now() - t0);
    out.samples++;
    if (color !== last) {
      out.firstChange ??= t;
      lastChange = t;
      last = color;
    }
    if (count && count.test(plain)) {
      out.count++;
      out.countFirst ??= t;
      out.countLast = t;
    }
    if (until && out.until === null && until.test(plain)) out.until = t;
    const doneUntil = !until || out.until !== null;
    const doneChange = !opt.change || out.firstChange !== null;
    if (doneUntil && doneChange && lastChange !== null && t - lastChange > 400) break;
    if (opt.interval) await sleep(Math.max(0, Number(opt.interval) - (performance.now() - t0 - t)));
  }
  out.settled = lastChange;
  out.rate = Math.round((out.samples * 1000) / (performance.now() - t0));
  console.log(JSON.stringify(out));
}

function evalScript(argv) {
  const { cwd } = state();
  const src = argv[0] === "-" || argv.length === 0 ? fs.readFileSync(0, "utf8") : argv.join(" ");
  const r = spawnSync("fresh", ["--cmd", "script", "run", "-"], { input: src, cwd, env: scriptEnv(), encoding: "utf8" });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.stdout && !r.stdout.endsWith("\n")) process.stdout.write("\n");
  process.exit(r.status ?? 1);
}

async function cmd(argv) {
  const { cwd } = state();
  const { pos, opt } = parse(argv, ["show"]);
  const r = spawnSync("fresh", ["--cmd", "command", "run", pos.join(" ")], { cwd, env: scriptEnv(), encoding: "utf8" });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.status !== 0) process.exit(r.status ?? 1);
  await settle();
  await show(opt);
}

function log(argv) {
  const { log: file } = state();
  if (!file || !fs.existsSync(file)) die("no log file recorded");
  const re = new RegExp(argv[0] ?? "image-viewer:| WARN | ERROR ");
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
    try {
      return !/^State:\s*Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    } catch {
      return true; // no /proc (macOS): kill(pid, 0) is the answer
    }
  };
  for (let i = 0; i < 20 && alive(); i++) await sleep(150);
  if (alive()) console.error(`driver: Fresh pid ${pid} is still running after the session was killed`);
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.rmSync(STATE, { force: true });
  console.error("driver: stopped");
}

const [sub, ...rest] = process.argv.slice(2);
const table = { start, screen, cell, keys, type, click, mouse, wait, time, eval: evalScript, cmd, log, stop };
if (!table[sub]) die(`usage: node ${rel()} <${Object.keys(table).join("|")}> ...  (see the header of this file)`, 2);
await table[sub](rest);
