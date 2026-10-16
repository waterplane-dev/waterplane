/**
 * The Windows launcher (`cli/windows.ts`), on any machine: its pure pieces, and `run()`'s
 * dispatch with the platform, the install root and every child process injected
 * (`LauncherMachine.exec`/`healthy`/`sleep`/`keepers`). Nothing here may spawn wsl.exe or
 * powershell.exe: a case either returns before the first spawn or runs against the fake.
 * `stopScript` itself RUNS, under bash, against a fake `/proc` with `kill` shadowed.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autostartTaskXml, installId, installKind, keeperPatternPs, launcherNames, mirroredWslConfig, parseStopLine, resolveKnobs, run,
  staleTaskNote, stopScript, stopVerdict, toWsl,
} from "../dist/cli/windows.js";
import { keepTaskNames, launcherTaskName } from "../dist/doctorwsl.js";
import { BRAND } from "@waterplane/shared";

const P = BRAND.envPrefix;
const scratch = mkdtempSync(join(tmpdir(), "winlauncher-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("toWsl: a drive letter becomes its /mnt mount, lower-cased; slashes flip; anything else is left alone", () => {
  assert.equal(toWsl("C:\\dev\\app"), "/mnt/c/dev/app");
  assert.equal(toWsl("d:\\Work\\My App"), "/mnt/d/Work/My App");
  assert.equal(toWsl("C:/dev/app"), "/mnt/c/dev/app");
  assert.equal(toWsl("/home/me/app"), "/home/me/app");
  assert.equal(toWsl("\\\\server\\share"), "//server/share");
});

test("mirroredWslConfig: adds under [wsl2], never overrides another mode, keeps what is there", () => {
  assert.deepEqual(mirroredWslConfig(""), { text: "[wsl2]\nnetworkingMode=mirrored\n", changed: true, other: false });
  const withSection = mirroredWslConfig("[wsl2]\nmemory=8GB\n");
  assert.equal(withSection.changed, true);
  assert.equal(withSection.text, "[wsl2]\nnetworkingMode=mirrored\nmemory=8GB\n");
  assert.deepEqual(mirroredWslConfig("[wsl2]\nnetworkingMode=NAT\n"), { text: "[wsl2]\nnetworkingMode=NAT\n", changed: false, other: true });
  const already = "[wsl2]\r\nnetworkingMode=mirrored\r\n";
  assert.deepEqual(mirroredWslConfig(already), { text: already, changed: false, other: false });
  const crlf = mirroredWslConfig("[wsl2]\r\nmemory=8GB\r\n");
  assert.equal(crlf.changed, true);
  assert.match(crlf.text, /networkingMode=mirrored/);
  assert.match(crlf.text, /memory=8GB/);
  // No trailing newline, no [wsl2]: the section is appended on a line of its own.
  assert.equal(mirroredWslConfig("[experimental]\nautoMemoryReclaim=gradual").text,
    "[experimental]\nautoMemoryReclaim=gradual\n[wsl2]\nnetworkingMode=mirrored\n");
});

test("autostartTaskXml: escaped user, UTF-8, no time limit, normal priority, -Ensure in the action", () => {
  const xml = autostartTaskXml({ user: "DOM&AIN\\<me>", keeperArgs: '-File "C:\\a&b\\keeper.ps1" -Ensure', startBoundary: "2026-10-09T10:00:00" });
  assert.match(xml, /encoding="UTF-8"/);
  assert.match(xml, /<UserId>DOM&amp;AIN\\&lt;me&gt;<\/UserId>/);
  assert.doesNotMatch(xml, /<me>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Priority>5<\/Priority>/);
  assert.match(xml, /<Arguments>--headless powershell\.exe [^<]*-Ensure<\/Arguments>/);
  assert.match(xml, /C:\\a&amp;b\\keeper\.ps1/);
});

test("installKind: .git (dir or worktree file) is a checkout, anything else an npm install", () => {
  const co = join(scratch, "kind-co"); mkdirSync(join(co, ".git"), { recursive: true });
  const wt = join(scratch, "kind-wt"); mkdirSync(wt); writeFileSync(join(wt, ".git"), "gitdir: /x\n");
  const npm = join(scratch, "kind-npm"); mkdirSync(npm);
  assert.equal(installKind(co), "checkout");
  assert.equal(installKind(wt), "checkout");
  assert.equal(installKind(npm), "npm");
});

test("launcherNames: the checkout keeps its old task name (and its old Temp flag as legacy); npm gets its own", () => {
  const base = { localAppData: "C:\\Users\\me\\AppData\\Local", temp: "C:\\Users\\me\\AppData\\Local\\Temp" };
  const co = launcherNames({ ...base, kind: "checkout", lroot: "/mnt/c/dev/app" });
  const npm = launcherNames({ ...base, kind: "npm", lroot: "/mnt/c/Users/me/AppData/Roaming/npm/node_modules/app" });
  assert.equal(co.task, `${BRAND.slug}-host`);
  assert.equal(npm.task, `${BRAND.slug}-host-npm`);
  assert.equal(co.stopFlag, `C:\\Users\\me\\AppData\\Local\\${BRAND.slug}\\${BRAND.slug}-host.stopped`);
  assert.equal(co.log, `C:\\Users\\me\\AppData\\Local\\${BRAND.slug}\\${BRAND.slug}-host.log`);
  assert.deepEqual(co.legacyStopFlags, [`C:\\Users\\me\\AppData\\Local\\Temp\\${BRAND.slug}-host.stopped`]);
  assert.deepEqual(co.legacyLogs, [`C:\\Users\\me\\AppData\\Local\\Temp\\${BRAND.slug}-host.log`]);
  assert.deepEqual(npm.legacyStopFlags, []);
  // Nothing the two kinds write is shared.
  for (const k of ["task", "stopFlag", "log", "knobFile"]) assert.notEqual(co[k], npm[k], k);
  assert.equal(co.knobFile, `C:\\Users\\me\\AppData\\Local\\${BRAND.slug}\\launcher-${co.id}.json`);
  // The id: short, stable, case-blind (a Windows drive is), different per install.
  assert.match(co.id, /^[0-9a-f]{8}$/);
  assert.equal(installId("/mnt/c/Dev/App"), installId("/mnt/c/dev/app"));
  assert.notEqual(installId("/mnt/c/dev/app"), installId("/mnt/c/dev/app-peer"));
});

test("resolveKnobs: shell > launcher file > (checkout) .env > default; only the shell's values are remembered", () => {
  const none = resolveKnobs({ kind: "npm", shell: {}, file: null, dotenv: null });
  assert.deepEqual(none, { port: 8770, portFrom: "default", distro: "", distroFrom: "default", fromShell: {} });
  const dotenv = { [`${P}PORT`]: "8772", [`${P}WSL_DISTRO`]: "Debian" };
  const file = { [`${P}PORT`]: "8771" };
  // checkout: the file beats .env, .env beats the default
  const co = resolveKnobs({ kind: "checkout", shell: {}, file, dotenv });
  assert.equal(co.port, 8771); assert.equal(co.portFrom, "file");
  assert.equal(co.distro, "Debian"); assert.equal(co.distroFrom, "env");
  // npm: a .env is never read
  const npm = resolveKnobs({ kind: "npm", shell: {}, file: null, dotenv });
  assert.equal(npm.port, 8770); assert.equal(npm.distro, "");
  // the shell beats everything, and is what gets remembered
  const sh = resolveKnobs({ kind: "checkout", shell: { [`${P}PORT`]: "8773", [`${P}WSL_DISTRO`]: "Ubuntu" }, file, dotenv });
  assert.equal(sh.port, 8773); assert.equal(sh.portFrom, "shell");
  assert.deepEqual(sh.fromShell, { [`${P}PORT`]: "8773", [`${P}WSL_DISTRO`]: "Ubuntu" });
  // not a port, or empty: falls through to the next source
  const bad = resolveKnobs({ kind: "npm", shell: { [`${P}PORT`]: "eighty" }, file: { [`${P}PORT`]: "" }, dotenv: null });
  assert.equal(bad.port, 8770); assert.deepEqual(bad.fromShell, {});
});

test("keeperPatternPs: this install's -Repo exactly, wildcard-escaped and PowerShell-quoted", () => {
  assert.equal(keeperPatternPs("/mnt/c/dev/app"), `('*-Repo "' + [WildcardPattern]::Escape('/mnt/c/dev/app') + '"*')`);
  assert.match(keeperPatternPs("/mnt/c/it's"), /Escape\('\/mnt\/c\/it''s'\)/);
});

// ── stopScript, RUN: a fake /proc, `kill` shadowed by a function, `ss` present or not ─────────

const ROOT_A = "/mnt/c/dev/my app (2)";   // spaces and parens: quoting is part of what is pinned
const MAIN_A = `${ROOT_A}/packages/host/dist/main.js`;
const REL = "packages/host/dist/main.js";
/** A fake /proc: pid → argv, cwd. */
function fakeProc(name, procs) {
  const dir = join(scratch, name);
  for (const [pid, { argv, cwd }] of Object.entries(procs)) {
    mkdirSync(join(dir, pid), { recursive: true });
    writeFileSync(join(dir, pid, "cmdline"), argv.map((a) => `${a}\0`).join(""));
    symlinkSync(cwd, join(dir, pid, "cwd"));
  }
  return dir;
}
/** A PATH holding only what stopScript needs — and `ss` (printing `ssOut`) only when asked. */
function fakeBin(name, ssOut) {
  const dir = join(scratch, name); mkdirSync(dir);
  for (const t of ["tr", "readlink", "grep", "cut", "sort"]) {
    const at = spawnSync("/bin/sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    symlinkSync(at, join(dir, t));
  }
  if (ssOut !== undefined) writeFileSync(join(dir, "ss"), `#!/bin/sh\nprintf '%s\\n' '${ssOut}'\n`, { mode: 0o755 });
  return dir;
}
function runStop(proc, bin, signal = "TERM") {
  const script = `kill() { echo "KILL $*"; }; ${stopScript({ port: 8771, lroot: ROOT_A, signal, proc })}`;
  const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { PATH: bin } });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, killed: (/^KILL -\w+ (.*)$/m.exec(r.stdout)?.[1] ?? "").split(" ").filter(Boolean), line: parseStopLine(r.stdout) };
}
const PROCS = {
  101: { argv: ["node", MAIN_A], cwd: "/home/me" },                              // today's keeper: absolute path
  102: { argv: ["node", REL], cwd: ROOT_A },                                     // an OLD keeper: relative, cwd = this install
  103: { argv: ["node", REL], cwd: "/mnt/c/dev/my app (2)-peer" },               // another install's old-keeper daemon
  104: { argv: ["node", "/mnt/c/dev/other/packages/host/dist/main.js"], cwd: ROOT_A }, // another install's, started from here
  105: { argv: ["bash", "-lc", `exec node '${MAIN_A}'`], cwd: ROOT_A },          // the bash that carries the words
  106: { argv: ["/home/me/.local/bin/node", MAIN_A, "--x"], cwd: "/" },         // node by its full path, an extra argument
};

test("stopScript without ss: walks /proc — this install's absolute main.js, or the relative one with its cwd here; nothing else", () => {
  const r = runStop(fakeProc("proc-noss", PROCS), fakeBin("bin-noss"));
  assert.deepEqual(r.killed, ["101", "102", "106"]);
  assert.deepEqual(r.line, { found: "proc", ss: false });
  assert.equal(runStop(fakeProc("proc-noss-k", PROCS), fakeBin("bin-noss-k"), "KILL").out.match(/^KILL -KILL /m)?.length, 1);
});

test("stopScript with ss: the port only NARROWS — this install's listener alone; another install's listener is never signalled", () => {
  const procs = fakeProc("proc-ss", PROCS);
  const mine = runStop(procs, fakeBin("bin-ss-mine", 'LISTEN 0 511 *:8771 *:* users:(("node",pid=102,fd=21))'));
  assert.deepEqual(mine.killed, ["102"]);
  assert.deepEqual(mine.line, { found: "port", ss: true });
  // Two installs on one port: the listener is 103's (another install). It is left alone, and the walk finds ours.
  const theirs = runStop(procs, fakeBin("bin-ss-theirs", 'LISTEN 0 511 *:8771 *:* users:(("node",pid=103,fd=21))'));
  assert.ok(!theirs.killed.includes("103"), "never another install's daemon");
  assert.deepEqual(theirs.killed, ["101", "102", "106"]);
  assert.deepEqual(theirs.line, { found: "proc", ss: true });
});

test("stopScript: nothing of this install running ⇒ no kill, and it says none (and whether ss was there)", () => {
  const procs = fakeProc("proc-none", { 103: PROCS[103], 104: PROCS[104], 105: PROCS[105] });
  const r = runStop(procs, fakeBin("bin-none"));
  assert.deepEqual(r.killed, []);
  assert.deepEqual(r.line, { found: "none", ss: false });
  assert.doesNotMatch(stopScript({ port: 8770, lroot: "/x", signal: "TERM" }), /pkill/);
});

test("stopVerdict: a forced end says why; a plain one does not invent a reason", () => {
  assert.equal(stopVerdict({ term: { found: "port", ss: true }, forced: false, keepersKilled: 0, port: 8770 }), "stopped");
  assert.match(stopVerdict({ term: { found: "none", ss: true }, forced: false, keepersKilled: 0, port: 8770 }), /nothing of this install was running/);
  const noSs = stopVerdict({ term: { found: "none", ss: false }, forced: false, keepersKilled: 1, port: 8770 });
  assert.match(noSs, /no daemon of this install found in WSL \(ss is not installed/);
  assert.match(noSs, /taskkill \/F \/T/);
  assert.match(stopVerdict({ term: null, forced: true, keepersKilled: 1, port: 8770 }), /WSL did not answer/);
  assert.match(stopVerdict({ term: { found: "proc", ss: true }, forced: true, keepersKilled: 0, port: 8770 }), /SIGKILL/);
  assert.match(stopVerdict({ term: { found: "none", ss: true }, forced: true, keepersKilled: 0, port: 8771 }), /port 8771 still answers.*not this install's host/);
});

test("staleTaskNote: only a task whose action still names the legacy %TEMP% flag gets the sentence", () => {
  const names = launcherNames({ kind: "checkout", lroot: "/mnt/c/dev/app", localAppData: "C:\\L", temp: "C:\\T" });
  assert.match(staleTaskNote(`-File "C:\\x\\keeper.ps1" -Repo "/mnt/c/dev/app" -StopFlag "C:\\t\\${BRAND.slug}-host.stopped" -Ensure`, names), /autostart` again/);
  assert.equal(staleTaskNote(`-StopFlag "${names.stopFlag}" -Ensure`, names), null);
  assert.equal(staleTaskNote("", names), null);
  assert.equal(staleTaskNote(`-StopFlag "C:\\T\\${BRAND.slug}-host.stopped"`, launcherNames({ kind: "npm", lroot: "/x", localAppData: "C:\\L", temp: "C:\\T" })), null);
});

test("keeper.ps1 keeps the shape the launcher matches and signals: the escaped -Repo pattern, exec of the ABSOLUTE main.js", () => {
  const keeper = readFileSync(new URL("../../../scripts/windows/keeper.ps1", import.meta.url), "utf8");
  assert.ok(keeper.includes("[WildcardPattern]::Escape("), "keeper -Ensure must match keepers the way keeperPatternPs does");
  assert.ok(keeper.includes("exec node '"), "the keeper must exec main.js (absolute, quoted) — stopScript's first rule");
  assert.ok(keeper.includes('"--cd", $Repo'), "the keeper runs at the install — stopScript's cwd rule for an old relative daemon");
});

test("keepTaskNames counts both launcher tasks", () => {
  assert.ok(keepTaskNames().includes(launcherTaskName("checkout")));
  assert.ok(keepTaskNames().includes(launcherTaskName("npm")));
});

// ── run(): dispatch, with the platform and the install injected ─────────────────────────────

/** Run with stdout/stderr captured; returns the exit code and what was printed. */
async function launch(argv, root, platform = "win32", machine = {}) {
  const out = []; const err = [];
  const log = console.log; const error = console.error;
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => err.push(a.join(" "));
  try {
    const code = await run(argv, root, { platform, env: { LOCALAPPDATA: join(scratch, "lad") }, localAppData: join(scratch, "lad"), temp: join(scratch, "tmp"), ...machine });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally { console.log = log; console.error = error; }
}

/**
 * A fake Windows: every child recorded, the host "up" until a stop script reaches WSL and up again
 * once a keeper is Start-Process'd. `ps` answers a powershell command by its text.
 */
function fakeWindows({ up = true, stopOut = "stop: port pids=4242 ss=1", ps = () => "", keepers = () => [] } = {}) {
  const calls = [];
  const state = { up };
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const script = args.at(-1) ?? "";
    let stdout = "";
    if (cmd === "wsl.exe" && script.includes("MAIN=")) { state.up = false; stdout = stopOut; }
    if (cmd === "powershell.exe" && script.startsWith("Start-Process")) state.up = true;
    if (cmd === "powershell.exe" && !script.startsWith("Start-Process")) stdout = ps(script);
    return { pid: 1, status: 0, signal: null, output: [null, stdout, ""], stdout, stderr: "" };
  };
  return { calls, state, machine: { exec, healthy: async () => state.up, sleep: async () => {}, keepers } };
}
const lroot = (root) => toWsl(root);
const npmRoot = join(scratch, "npm-install");
mkdirSync(npmRoot);
// A release (the npm tarball included) carries release.json, which is what `version` reads.
writeFileSync(join(npmRoot, "release.json"), JSON.stringify({ name: BRAND.slug, version: "9.8.7", commit: "0123456789abcdef0123" }));
const coRoot = join(scratch, "checkout");
mkdirSync(join(coRoot, ".git"), { recursive: true });

test("run: not Windows ⇒ refused in words", async () => {
  const r = await launch(["status"], npmRoot, "darwin");
  assert.equal(r.code, 1);
  assert.match(r.err, /for Windows/);
});

test("run: version prints this install's identity, every spelling", async () => {
  for (const v of ["version", "--version", "-v"]) {
    const r = await launch([v], npmRoot);
    assert.equal(r.code, 0, v);
    assert.equal(r.out, `${BRAND.slug} 9.8.7 (0123456789)`);
  }
});

test("run: help names the kind's own commands", async () => {
  const npm = await launch(["help"], npmRoot);
  assert.equal(npm.code, 0);
  assert.match(npm.out, /update/); assert.doesNotMatch(npm.out, /\bdev\b/);
  const co = await launch(["--help"], coRoot);
  assert.match(co.out, /dev/); assert.doesNotMatch(co.out, /update/);
});

test("run: an unknown command exits 2 with the help", async () => {
  const r = await launch(["frobnicate"], npmRoot);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command: frobnicate/);
});

test("run: update on a checkout and dev on an npm install are refused before anything runs", async () => {
  const up = await launch(["update"], coRoot);
  assert.equal(up.code, 1);
  assert.match(up.err, /git pull/);
  const dev = await launch(["dev"], npmRoot);
  assert.equal(dev.code, 1);
  assert.match(dev.err, /checkout/);
});

// ── run(): stop / start / update against a fake Windows — the migration path ────────────────

mkdirSync(join(coRoot, "packages/host/dist"), { recursive: true });
writeFileSync(join(coRoot, "packages/host/dist/main.js"), "");   // built: start never builds
/** Per-test %LOCALAPPDATA% and %TEMP%, so one test's flags are never another's. */
function dirs(name) {
  const lad = join(scratch, `${name}-lad`); const temp = join(scratch, `${name}-temp`);
  mkdirSync(lad, { recursive: true }); mkdirSync(temp, { recursive: true });
  return { lad, temp, env: { LOCALAPPDATA: lad }, localAppData: lad };
}
const flag = (dir, task) => join(dir, BRAND.slug, `${task}.stopped`);
const legacyFlag = (temp) => join(temp, `${BRAND.slug}-host.stopped`);

test("run stop (checkout): writes the new AND the legacy %TEMP% flag, and hands stopScript to wsl.exe … bash -lc at the install", async () => {
  const d = dirs("co-stop");
  const w = fakeWindows();
  const r = await launch(["stop"], coRoot, "win32", { ...w.machine, env: d.env, localAppData: d.lad, temp: d.temp });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(flag(d.lad, `${BRAND.slug}-host`)), "today's flag");
  assert.ok(existsSync(legacyFlag(d.temp)), "the flag an already-registered task and a running OLD keeper read");
  const term = w.calls.find((c) => c.cmd === "wsl.exe");
  assert.deepEqual(term.args, ["--cd", lroot(coRoot), "--exec", "bash", "-lc", stopScript({ port: 8770, lroot: lroot(coRoot), signal: "TERM" })]);
  assert.equal(w.calls.filter((c) => c.cmd === "wsl.exe").length, 1, "it went down on TERM: no KILL pass");
  assert.ok(!w.calls.some((c) => c.cmd === "taskkill.exe"));
  assert.match(r.out, /\] stopped$/m);
});

test("run stop (checkout): a task still registered with the %TEMP% paths gets the one sentence; nothing is re-registered", async () => {
  const d = dirs("co-stale");
  const w = fakeWindows({ ps: (cmd) => (cmd.includes("Get-ScheduledTask") ? `-File "k.ps1" -StopFlag "${legacyFlag(d.temp)}" -Ensure` : "") });
  const r = await launch(["stop"], coRoot, "win32", { ...w.machine, env: d.env, localAppData: d.lad, temp: d.temp });
  assert.match(r.out, /host\.mjs autostart` again/);
  assert.ok(!w.calls.some((c) => /Register-ScheduledTask/.test(c.args.at(-1) ?? "")), "a sentence, never a re-registration");
});

test("run stop: nothing found and a keeper that will not leave ⇒ taskkill, and the line says WHY", async () => {
  const d = dirs("co-forced");
  const w = fakeWindows({ stopOut: "stop: none ss=0", keepers: () => [777] });
  w.machine.healthy = async () => false;
  const r = await launch(["stop"], coRoot, "win32", { ...w.machine, env: d.env, localAppData: d.lad, temp: d.temp });
  assert.deepEqual(w.calls.find((c) => c.cmd === "taskkill.exe").args, ["/F", "/T", "/PID", "777"]);
  assert.match(r.out, /stopped \(forced\): no daemon of this install found in WSL \(ss is not installed/);
});

test("run start (checkout): clears BOTH flags and starts a keeper on today's flag", async () => {
  const d = dirs("co-start");
  for (const f of [flag(d.lad, `${BRAND.slug}-host`), legacyFlag(d.temp)]) { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "x"); }
  const w = fakeWindows({ up: false });
  const r = await launch(["start"], coRoot, "win32", { ...w.machine, env: d.env, localAppData: d.lad, temp: d.temp });
  assert.equal(r.code, 0, r.err);
  assert.ok(!existsSync(flag(d.lad, `${BRAND.slug}-host`)));
  assert.ok(!existsSync(legacyFlag(d.temp)), "an OLD keeper or task reads this one: left behind, it would keep the host down");
  const sp = w.calls.find((c) => c.cmd === "powershell.exe" && c.args.at(-1).startsWith("Start-Process")).args.at(-1);
  assert.ok(sp.includes(`'"${flag(d.lad, `${BRAND.slug}-host`)}"'`), sp);
  assert.ok(!w.calls.some((c) => c.args.includes("npm run build") || c.cmd === "npm run build"), "built already: no build");
});

test("run stop (npm): writes only its own flag — never the checkout's, never one in %TEMP%", async () => {
  const d = dirs("npm-stop");
  const w = fakeWindows();
  const r = await launch(["stop"], npmRoot, "win32", { ...w.machine, env: d.env, localAppData: d.lad, temp: d.temp });
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(flag(d.lad, `${BRAND.slug}-host-npm`)));
  assert.ok(!existsSync(flag(d.lad, `${BRAND.slug}-host`)), "the checkout's task honours that one");
  assert.deepEqual(readdirSync(d.temp), []);
  assert.ok(!w.calls.some((c) => (c.args.at(-1) ?? "").includes("Get-ScheduledTask")), "the stale-task note is the checkout's");
});

test("run update (npm): stops, installs, then starts through a FRESH `<slug> start` — in that order", async () => {
  const d = dirs("npm-update");
  const w = fakeWindows();
  const r = await launch(["update"], npmRoot, "win32", { ...w.machine, env: d.env, localAppData: d.lad, temp: d.temp });
  assert.equal(r.code, 0, r.err);
  const at = (pred) => w.calls.findIndex(pred);
  const stopAt = at((c) => c.cmd === "wsl.exe" && (c.args.at(-1) ?? "").includes("MAIN="));
  const installAt = at((c) => c.cmd === `npm install -g ${BRAND.slug}@latest`);
  const startAt = at((c) => c.cmd === `${BRAND.slug} start`);
  assert.ok(stopAt >= 0 && installAt > stopAt && startAt > installAt, JSON.stringify(w.calls.map((c) => c.cmd)));
  assert.ok(!w.calls.some((c) => (c.args.at(-1) ?? "").startsWith("Start-Process")), "this process holds the OLD launcher: it starts nothing itself");
});

test("run restart (checkout): `justBuilt` from the wrapper skips the second build; without it, restart builds", async () => {
  const d = dirs("co-restart");
  const once = fakeWindows();
  await launch(["restart"], coRoot, "win32", { ...once.machine, env: d.env, localAppData: d.lad, temp: d.temp, justBuilt: true });
  assert.ok(!once.calls.some((c) => c.cmd === "npm run build"));
  assert.ok(once.calls.some((c) => (c.args.at(-1) ?? "").startsWith("Start-Process")), "and still restarted");
  const twice = fakeWindows();
  await launch(["restart"], coRoot, "win32", { ...twice.machine, env: d.env, localAppData: d.lad, temp: d.temp });
  assert.ok(twice.calls.some((c) => c.cmd === "npm run build"));
});

test("scripts/windows/host.mjs tells the launcher about its own first build", () => {
  const wrapper = readFileSync(new URL("../../../scripts/windows/host.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /run\(process\.argv\.slice\(2\), REPO, \{ justBuilt \}\)/);
  assert.match(wrapper, /justBuilt = true;/);
});
