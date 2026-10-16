/**
 * The host on Windows: run INSIDE WSL from the files of this install, driven from PowerShell.
 *
 * Sessions live in tmux, which has no Windows build, so the daemon cannot run natively. It runs
 * in the WSL distro instead, straight out of `/mnt/<drive>/…`: its runtime needs only node-pty
 * (which ships a linux-x64 prebuild next to the Windows one) and pure-JS packages, so one set of
 * files serves both sides — there is no second copy to keep in sync.
 *
 * Two installs drive it, with one implementation:
 *  - a CHECKOUT (`scripts/windows/host.mjs`, reached by `npm run restart|stop|start|doctor|dev`):
 *    it builds on Windows, where the esbuild/rollup binaries were installed;
 *  - an npm GLOBAL install (`npm i -g <slug>`, then `<slug> setup|start|…` — `cli/index.ts` sends
 *    every command here on win32): prebuilt, so nothing is built, and `update` is npm's.
 *
 *   setup      a distro to run in, tmux/git (apt as WSL's root), .wslconfig mirrored networking,
 *              then provision the distro (wsl-setup.sh)
 *   start      start the host in WSL (detached, survives this shell)
 *   stop       SIGTERM it (the shutdown flush runs) and wait
 *   restart    (checkout: build,) stop, start, health-check
 *   doctor     the preflight, run where the host runs
 *   status     is it answering
 *   dev        checkout only: built host in WSL (dev origins trusted) + Vite dev here
 *   autostart [--remove]   keep it up: at logon, on wake/unlock, every 10 min
 *   update     npm install only: stop, `npm install -g <slug>@latest`, start
 *   pair …     run in WSL against the running host
 *   version    this install's name, version and commit
 *
 * The wsl.exe that runs the daemon IS what keeps the distro (and its VM) alive: WSL stops an
 * instance once no Windows-side process holds it, which would take every session with it.
 * `<PREFIX>WSL_DISTRO` picks a distro other than the default; `<PREFIX>PORT` the port. Both are
 * read from the shell, then this install's launcher file, then (checkout) the repo `.env`
 * (`resolveKnobs`). An npm install has no `.env` of its own on the Windows side, so a knob it
 * was given in the shell on `setup`/`start`/`autostart` is remembered in the launcher file — a
 * later `stop` from a plain shell must find the same port and distro — and its port, when not
 * the default, is handed to the host through the keeper.
 *
 * What one user's installs share on one machine is decided in ONE place, `launcherNames`: the
 * task, the stop flag and the log. A checkout keeps the names it always had (a box with the task
 * registered needs no migration), an npm install has its own.
 */
import { spawn, spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path, { dirname, join, resolve, win32 } from "node:path";
import { parseEnv } from "node:util";
import { BRAND } from "@waterplane/shared";
import { launcherTaskName } from "../doctorwsl.js";
import { readJsonGuarded, writeJsonAtomic, writeTextAtomic, writeTextAtomicKeepMode } from "../jsonstore.js";

/** `C:\dev\app` → `/mnt/c/dev/app`. */
export const toWsl = (p: string): string => p.replace(/^([a-z]):/i, (_, d: string) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, "/");

/** `.wslconfig` with mirrored networking turned on under `[wsl2]`, or why it was not touched. */
export function mirroredWslConfig(text: string): { text: string; changed: boolean; other: boolean } {
  if (/^\s*networkingMode\s*=\s*mirrored\s*$/im.test(text)) return { text, changed: false, other: false };
  if (/^\s*networkingMode\s*=/im.test(text)) return { text, changed: false, other: true };
  const next = /^\s*\[wsl2\]\s*$/im.test(text)
    ? text.replace(/^\s*\[wsl2\]\s*$/im, (h) => `${h}\nnetworkingMode=mirrored`)
    : `${text}${text && !text.endsWith("\n") ? "\n" : ""}[wsl2]\nnetworkingMode=mirrored\n`;
  return { text: next, changed: true, other: false };
}

const xmlEsc = (s: string): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The autostart task: a per-user scheduled task running the keeper in `-Ensure` mode. Logon alone
 * was not enough: a Windows Update "restart now" killed the keeper, the restart never completed
 * (lid shut → sleep), and with no new logon nothing brought the host back. So it also fires on
 * wake, on unlock and every 10 minutes; `-Ensure` makes each of those a no-op while the host is up,
 * being brought up, or deliberately stopped. `conhost --headless` hands it the console wsl.exe
 * needs (see `start`) without a window flashing up every 10 minutes. No elevation, no stored
 * password: it runs only while this user is logged on, which is when the PTYs have someone to
 * drive them anyway. ExecutionTimeLimit PT0S: the default 72 h would kill a keeper that ran that
 * long. Priority 5: a task's default (7) is below-normal, and the daemon and every session would
 * inherit it.
 */
export function autostartTaskXml(o: { user: string; keeperArgs: string; startBoundary: string }): string {
  const wake = "<QueryList><Query Id=\"0\" Path=\"System\"><Select Path=\"System\">*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1]]</Select></Query></QueryList>";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Keeps the ${xmlEsc(BRAND.slug)} host running in WSL (keeper.ps1 -Ensure).</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><UserId>${xmlEsc(o.user)}</UserId></LogonTrigger>
    <SessionStateChangeTrigger><StateChange>SessionUnlock</StateChange><UserId>${xmlEsc(o.user)}</UserId></SessionStateChangeTrigger>
    <EventTrigger><Subscription>${xmlEsc(wake)}</Subscription></EventTrigger>
    <TimeTrigger><StartBoundary>${o.startBoundary}</StartBoundary><Repetition><Interval>PT10M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>${xmlEsc(o.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xmlEsc(`--headless powershell.exe ${o.keeperArgs}`)}</Arguments></Exec></Actions>
</Task>`;
}

export type InstallKind = "checkout" | "npm";

/** A checkout has `.git` (a dir, or a worktree's file); anything else here is a prebuilt package. */
export const installKind = (root: string): InstallKind => (existsSync(join(root, ".git")) ? "checkout" : "npm");

/** This install's short id: a hash of its WSL path, lower-cased (a Windows drive does not care about case). */
export const installId = (lroot: string): string => createHash("sha256").update(lroot.toLowerCase()).digest("hex").slice(0, 8);

export interface LauncherNames {
  /** `installId` of the install. */
  id: string;
  /** The scheduled task `autostart` registers (`launcherTaskName`). */
  task: string;
  /** Present while the host is meant to be down: `stop` writes it, `start` clears it, the keeper reads it. */
  stopFlag: string;
  /** Flags a keeper or task registered by an older launcher may still read: written and cleared beside `stopFlag`. */
  legacyStopFlags: string[];
  log: string;
  /** Where an older keeper may still be writing. */
  legacyLogs: string[];
  /** The knobs this install was given in a shell (`resolveKnobs`). */
  knobFile: string;
}

/**
 * Every per-user name the launcher uses, for one install. Stop flag and log live in
 * `%LOCALAPPDATA%\<slug>\`, not `%TEMP%`: Storage Sense may empty Temp (a deliberately stopped
 * host would come back), and both survive a reboot — so a stopped host STAYS stopped across one,
 * as it always did, until `start`. A checkout keeps its old task name (and writes its old Temp
 * flag too, for a task or keeper registered before this), an npm install gets its own names, so
 * the two on one machine never stop or replace each other. Two CHECKOUTS still share them.
 */
export function launcherNames(o: { kind: InstallKind; lroot: string; localAppData: string; temp: string; path?: Pick<typeof win32, "join"> }): LauncherNames {
  // `path`: win32 by default (the names are Windows paths); `run` passes the running node's own, which
  // IS win32 on Windows and lets a test on macOS write the flags into a scratch dir.
  const pj = (o.path ?? win32).join;
  const id = installId(o.lroot);
  const task = launcherTaskName(o.kind);
  const dir = pj(o.localAppData, BRAND.slug);
  const old = `${BRAND.slug}-host`;
  return {
    id, task,
    stopFlag: pj(dir, `${task}.stopped`),
    legacyStopFlags: o.kind === "checkout" ? [pj(o.temp, `${old}.stopped`)] : [],
    log: pj(dir, `${task}.log`),
    legacyLogs: o.kind === "checkout" ? [pj(o.temp, `${old}.log`)] : [],
    knobFile: pj(dir, `launcher-${id}.json`),
  };
}

export type KnobSource = "shell" | "file" | "env" | "default";
export interface Knobs {
  port: number; portFrom: KnobSource;
  distro: string; distroFrom: KnobSource;
  /** The knobs the shell set, by their full env name: what `setup`/`start`/`autostart` remember. */
  fromShell: Record<string, string>;
}

/**
 * The launcher's two knobs: the shell, then this install's launcher file, then (checkout only)
 * the repo `.env`, then the default. A value that is empty or not a port falls through.
 */
export function resolveKnobs(o: {
  kind: InstallKind; shell: Record<string, string | undefined>; file: Record<string, unknown> | null; dotenv: Record<string, string | undefined> | null;
}): Knobs {
  const fromShell: Record<string, string> = {};
  const pick = (name: string, ok: (v: string) => boolean): { v: string; from: KnobSource } | null => {
    const key = `${BRAND.envPrefix}${name}`;
    const s = o.shell[key];
    if (s && ok(s)) { fromShell[key] = s; return { v: s, from: "shell" }; }
    const f = o.file?.[key];
    if (typeof f === "string" && f && ok(f)) return { v: f, from: "file" };
    const e = o.kind === "checkout" ? o.dotenv?.[key] : undefined;
    if (e && ok(e)) return { v: e, from: "env" };
    return null;
  };
  const isPort = (v: string) => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536;
  const port = pick("PORT", isPort);
  const distro = pick("WSL_DISTRO", () => true);
  return {
    port: port ? Number(port.v) : 8770, portFrom: port?.from ?? "default",
    distro: distro?.v ?? "", distroFrom: distro?.from ?? "default",
    fromShell,
  };
}

/** A string as one PowerShell single-quoted literal. */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * The PowerShell pattern a keeper of THIS install matches: `-Repo "<lroot>"` exactly, escaped —
 * a bare `*<lroot>*` let `/mnt/c/dev/app` match the keeper of `/mnt/c/dev/app-peer`, and `[`/`]`
 * in a path are wildcards. keeper.ps1's `-Ensure` builds the same pattern.
 */
export const keeperPatternPs = (lroot: string): string => `('*-Repo "' + [WildcardPattern]::Escape(${psq(lroot)}) + '"*')`;

/** A string as one bash single-quoted word. */
const shq = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * The bash that stops THIS install's daemon inside WSL, and says what it found. A process is this
 * install's daemon when it is `node` running `<lroot>/packages/host/dist/main.js` by its ABSOLUTE
 * path (today's keeper), or `node packages/host/dist/main.js` RELATIVE with its cwd at `<lroot>`
 * (`readlink /proc/<pid>/cwd`): a keeper of an older launcher runs the relative path, and every
 * keeper runs `wsl.exe --cd <lroot>`, so the cwd is what tells it apart from another install's —
 * the old port rung signalled ANY host main.js on the port, i.e. another install's daemon when two
 * shared one. The port only NARROWS: when `ss` names a listener on it that is this install's, only
 * that one is signalled (a second host started from the same tree on another port — an e2e run — is
 * left alone); else, or with no `ss` at all, every `/proc/<pid>` is walked with the same rule.
 * Never `pkill -f '…main.js'`: every install in the distro runs that, and the bash running pkill
 * carries the words too.
 *
 * The last line printed is `stop: port|proc pids=… ss=0|1`, or `stop: none ss=0|1` (`parseStopLine`).
 * `proc` is for a test only: a fake `/proc` to walk.
 */
export function stopScript(o: { port: number; lroot: string; signal: "TERM" | "KILL"; proc?: string }): string {
  const P = o.proc ?? "/proc";
  return [
    `P=${shq(P)}; ROOT=${shq(o.lroot)}; MAIN="$ROOT/packages/host/dist/main.js"`,
    // argv[0] must be node; any later argument is the absolute main.js, or the relative one with cwd = ROOT.
    "mine() { local a first=1 rel=0; while IFS= read -r -d '' a; do"
      + ` if [ $first = 1 ]; then first=0; case "\${a##*/}" in node|nodejs) ;; *) return 1;; esac; continue; fi;`
      + ` [ "$a" = "$MAIN" ] && return 0;`
      + ` case "$a" in packages/host/dist/main.js|./packages/host/dist/main.js) rel=1;; esac;`
      + ` done 2>/dev/null < "$P/$1/cmdline";`
      + ` [ $rel = 1 ] || return 1;`
      + ` [ "$(readlink "$P/$1/cwd" 2>/dev/null | tr A-Z a-z)" = "$(printf %s "$ROOT" | tr A-Z a-z)" ]; }`,
    `ss_ok=0; how=port; pids=""`,
    `if command -v ss >/dev/null 2>&1; then ss_ok=1; for p in $(ss -Hltnp ${shq(`sport = :${o.port}`)} 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do mine "$p" && pids="$pids $p"; done; fi`,
    `if [ -z "$pids" ]; then how=proc; for d in "$P"/[0-9]*; do p="\${d##*/}"; [ "$p" = "$$" ] && continue; mine "$p" && pids="$pids $p"; done; fi`,
    `if [ -n "$pids" ]; then kill -${o.signal} $pids 2>/dev/null; echo "stop: $how pids=\${pids# } ss=$ss_ok"; else echo "stop: none ss=$ss_ok"; fi`,
    "true",
  ].join("; ");
}

/** What `stopScript` found, off its output: by which rung, and whether `ss` was there. Unreadable ⇒ null. */
export function parseStopLine(out: string): { found: "port" | "proc" | "none"; ss: boolean } | null {
  const m = /^stop: (port|proc|none)\b.*\bss=([01])\s*$/m.exec(out);
  return m ? { found: m[1] as "port" | "proc" | "none", ss: m[2] === "1" } : null;
}

/**
 * The line `stop` ends with. Every forced end says WHY — the old bare "stopped (forced)" never said
 * whether the daemon got its SIGTERM (and with it the flush of the ack ledger and the stores).
 * `term` is the TERM pass's `parseStopLine`; `forced`: the port still answered 16 s later (so a KILL
 * pass ran); `keepersKilled`: keepers that outlived the stop flag and got `taskkill /F /T`.
 */
export function stopVerdict(o: { term: ReturnType<typeof parseStopLine>; forced: boolean; keepersKilled: number; port: number }): string {
  const notFound = !o.term ? "WSL did not answer the stop (is the distro up?)"
    : o.term.found === "none" ? `no daemon of this install found in WSL${o.term.ss ? "" : " (ss is not installed there, so only the /proc walk ran)"}`
    : null;
  if (o.keepersKilled) return `stopped (forced): ${notFound ?? "its keeper did not exit after the daemon stopped"} — ended the keeper with taskkill /F /T`;
  if (o.forced) {
    return notFound ? `port ${o.port} still answers: ${notFound} — whatever answers there is not this install's host, or not stoppable from here`
      : "stopped (forced): it did not exit within 16 s of SIGTERM, so it got SIGKILL";
  }
  return o.term?.found === "none" ? "stopped (nothing of this install was running)" : "stopped";
}

/**
 * A checkout's scheduled task registered by the launcher before the stop flag left `%TEMP%`: its
 * action still names the legacy flag, which `stop`/`start` keep writing and clearing for it — so it
 * works, but only until a new `autostart` moves it. A sentence, never a re-registration.
 */
export function staleTaskNote(taskArgs: string, names: Pick<LauncherNames, "legacyStopFlags">): string | null {
  const flag = /-StopFlag\s+"([^"]+)"/i.exec(taskArgs)?.[1]?.toLowerCase();
  if (!flag || !names.legacyStopFlags.some((f) => f.toLowerCase() === flag)) return null;
  return "the autostart task still uses the old %TEMP% stop flag and log — run `node scripts/windows/host.mjs autostart` again to move the task to the new paths";
}

/** `packages/host/dist/cli` → the install root, a checkout's or the npm package's. */
const ROOT = resolve(import.meta.dirname, "../../../..");

const HELP = (kind: InstallKind): string => `${BRAND.slug} on Windows — the host runs inside WSL2, driven from here.

usage: ${kind === "npm" ? BRAND.slug : "node scripts/windows/host.mjs"} <command>

  setup                 make WSL ready: a distro, tmux and git, mirrored networking, Node and claude inside it
  start | stop | restart | status
  doctor [--json]       the preflight, run inside WSL where the host runs
  autostart [--remove]  start at logon, come back on wake, unlock and within 10 minutes of a crash
${kind === "npm" ? "  update                stop, npm install -g " + BRAND.slug + "@latest, start again if it was up\n" : "  dev                   the built host in WSL + Vite dev here\n"}  pair [--json]         a pairing code for a phone, from the running host
  version | help
`;

/** What `run` reads off the machine, injectable so the dispatch is testable anywhere. */
export interface LauncherMachine {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** `%LOCALAPPDATA%` — where the stop flag, the log and the launcher file live. */
  localAppData: string;
  /** `%TEMP%` — where an older launcher kept its stop flag and log. */
  temp: string;
  /** Every child the launcher waits for (wsl.exe, powershell.exe, taskkill.exe, npm) — spawnSync's shape. */
  exec: (cmd: string, args: string[], opts: SpawnSyncOptions) => SpawnSyncReturns<string | Buffer>;
  /** Is the host answering on the launcher's port. */
  healthy: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** PIDs of the keepers running for this install. */
  keepers: () => number[];
  /** The caller has just built (`scripts/windows/host.mjs`'s first build): this run builds no second time. */
  justBuilt: boolean;
}

export async function run(argv: string[], root: string = ROOT, machine: Partial<LauncherMachine> = {}): Promise<number> {
  const platform = machine.platform ?? process.platform;
  const env = machine.env ?? process.env;
  const tag = "[host]";
  if (platform !== "win32") { console.error(`${tag} this launcher is for Windows; elsewhere use \`${BRAND.slug} start\` or \`npm run restart\`.`); return 1; }

  const kind = installKind(root);
  const [cmd = kind === "npm" ? "start" : "status", ...rest] = argv;
  // `doctor --json` owns stdout (one JSON document for a script or an agent): the launcher's own lines go to stderr then.
  const say = rest.includes("--json") ? (s: string) => console.error(`${tag} ${s}`) : (s: string) => console.log(`${tag} ${s}`);
  class Die extends Error {}
  const die = (s: string): never => { console.error(`${tag} ${s}`); throw new Die(s); };

  const LROOT = toWsl(root);
  const names = launcherNames({
    kind, lroot: LROOT,
    localAppData: machine.localAppData ?? env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    temp: machine.temp ?? tmpdir(),
    path,
  });
  const knobs = resolveKnobs({
    kind, shell: env,
    file: readJsonGuarded<Record<string, unknown> | null>(names.knobFile, null, (v) => !!v && typeof v === "object" && !Array.isArray(v)),
    dotenv: kind === "checkout" ? (() => { try { return parseEnv(readFileSync(join(root, ".env"), "utf8")); } catch { return null; } })() : null,
  });
  const PORT = knobs.port;
  const DISTRO = knobs.distro;
  const { log: LOG, stopFlag: STOP_FLAG, task: TASK } = names;
  const KEEPER = join(root, "scripts/windows/keeper.ps1");
  // A checkout's `.env` is read by the host itself; a port from the shell or the launcher file is
  // handed over, or the host and this launcher would ask two different ports.
  const ENV_PREFIX = knobs.portFrom === "shell" || knobs.portFrom === "file" ? `${BRAND.envPrefix}PORT=${PORT} ` : "";

  /**
   * An npm install remembers the knobs its shell set, so a later `stop`/`status`/`doctor` from a
   * plain shell targets the same port and distro. A checkout does not: its place for them is the
   * repo `.env`, and a remembered shell value would silently outrank an edit there.
   */
  const rememberKnobs = (): void => {
    if (kind !== "npm" || !Object.keys(knobs.fromShell).length) return;
    const prev = readJsonGuarded<Record<string, unknown>>(names.knobFile, {}, (v) => !!v && typeof v === "object" && !Array.isArray(v));
    if (Object.entries(knobs.fromShell).every(([k, v]) => prev[k] === v)) return;
    writeJsonAtomic(names.knobFile, { ...prev, ...knobs.fromShell }, { space: 2, newline: true });
    say(`remembered ${Object.entries(knobs.fromShell).map(([k, v]) => `${k}=${v}`).join(", ")} for this install (${names.knobFile})`);
  };

  /** Every flag a keeper of this install may read: today's, and (checkout) the Temp one an older launcher registered. */
  const allFlags = [STOP_FLAG, ...names.legacyStopFlags];
  const setStopFlags = (): void => { for (const f of allFlags) writeTextAtomic(f, `${new Date().toISOString()}\n`); };
  const clearStopFlags = (): void => { for (const f of allFlags) { try { unlinkSync(f); } catch { /* not stopped */ } } };
  const stopFlagSet = (): boolean => allFlags.some((f) => existsSync(f));
  /** The log being written: a keeper an older launcher started still writes its Temp one. */
  const liveLog = (): string => {
    const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return -1; } };
    return [LOG, ...names.legacyLogs].reduce((a, b) => (mtime(b) > mtime(a) ? b : a));
  };

  /** wsl.exe argv running `cmd` in a LOGIN bash at the install — login, so ~/.local/bin (node, claude) is on PATH. */
  const wslArgv = (c: string): string[] => [...(DISTRO ? ["-d", DISTRO] : []), "--cd", LROOT, "--exec", "bash", "-lc", c];
  const exec = machine.exec ?? ((c: string, a: string[], o: SpawnSyncOptions) => spawnSync(c, a, o));
  const wsl = (c: string, opts: SpawnSyncOptions = {}) => exec("wsl.exe", wslArgv(c), { stdio: "inherit", ...opts });
  const ps = (command: string) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true }) as SpawnSyncReturns<string>;

  const healthy = machine.healthy ?? (async (): Promise<boolean> => {
    try { return (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  });
  const sleep = machine.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitFor = async (want: boolean, tries = 50): Promise<boolean> => {
    for (let i = 0; i < tries; i++) { if ((await healthy()) === want) return true; await sleep(400); }
    return false;
  };
  const tail = (file: string, n = 15): string => { try { return readFileSync(file, "utf8").trimEnd().split("\n").slice(-n).join("\n"); } catch { return ""; } };

  let built = machine.justBuilt === true;
  const build = (): void => {
    if (kind !== "checkout") return;
    if (built) { built = false; return; }   // the wrapper's first build is this one: ~100 s on the first Windows box, not twice
    say("building…");
    const log = join(tmpdir(), "host-build.log");
    const fd = openSync(log, "w");
    const r = exec("npm run build", [], { cwd: root, shell: true, stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    if (r.status !== 0) die(`BUILD FAILED — host left as-is. See ${log}\n${tail(log, 8)}`);
  };

  /** PIDs of the keepers running for this install (not the asking PowerShell, whose own command line matches). */
  const keepers = machine.keepers ?? ((): number[] => {
    const r = ps(`$mine = ${keeperPatternPs(LROOT)}; Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*keeper.ps1*' -and $_.CommandLine -like $mine } | ForEach-Object ProcessId`);
    return (r.stdout ?? "").split(/\s+/).filter(Boolean).map(Number);
  });

  /** A checkout's task still registered with the `%TEMP%` paths: one sentence (`staleTaskNote`), never a re-registration. */
  const taskNote = (): void => {
    if (kind !== "checkout") return;
    const r = ps(`(Get-ScheduledTask -TaskName ${psq(TASK)} -ErrorAction SilentlyContinue).Actions[0].Arguments`);
    const note = staleTaskNote(String(r.stdout ?? ""), names);
    if (note) say(note);
  };

  const start = async (envPrefix = ENV_PREFIX): Promise<void> => {
    if (await healthy()) { clearStopFlags(); say(`already up · http://127.0.0.1:${PORT}`); return; }
    // A keeper still running (between two restarts of a crashed host) starts the daemon itself: a
    // second one would start a second daemon, and the two fight over the port.
    if (keepers().length) {
      clearStopFlags();
      say("the keeper is already restarting it — waiting…");
      if (await waitFor(true, 300)) { say(`up · http://127.0.0.1:${PORT} (log: ${liveLog()})`); return; }
      die(`no answer in 2 min — see ${liveLog()}\n${tail(liveLog())}`);
    }
    if (!existsSync(join(root, "packages/host/dist/main.js"))) build();
    // wsl.exe without a console exits at once without a word — started `detached`, or as the child
    // of a detached process. So the keeper (keeper.ps1) gets a console of its own, hidden, from
    // Start-Process: it outlives this shell and holds wsl.exe as an ordinary child.
    clearStopFlags();
    // Start-Process joins -ArgumentList with spaces, so each value carries its own double quotes.
    const arg = (name: string, v: string | number) => [psq(`-${name}`), psq(`"${v}"`)];
    const args = [
      psq("-NoProfile"), psq("-ExecutionPolicy"), psq("Bypass"), psq("-File"), psq(`"${KEEPER}"`),
      ...arg("Repo", LROOT), ...arg("Log", LOG), ...arg("StopFlag", STOP_FLAG), ...arg("Port", PORT),
      ...(DISTRO ? arg("Distro", DISTRO) : []), ...(envPrefix ? arg("EnvPrefix", envPrefix) : []),
    ];
    mkdirSync(dirname(LOG), { recursive: true });   // the keeper appends to its log from its first line
    exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Start-Process -FilePath powershell.exe -ArgumentList ${args.join(",")} -WindowStyle Hidden`], { stdio: "inherit", windowsHide: true });
    say(`starting in WSL (the first boot loads the host over /mnt${kind === "checkout" ? " and scans every repo under the root" : ""} — allow ~30 s)…`);
    if (await waitFor(true, 300)) { say(`up · http://127.0.0.1:${PORT} (log: ${LOG})`); return; }
    die(`started, but no answer in 2 min — see ${LOG}\n${tail(LOG)}`);
  };

  const stop = async (): Promise<void> => {
    setStopFlags();   // the keeper must not restart it
    // The daemon's own SIGTERM handler flushes the ack ledger and the stores; tmux keeps the sessions.
    // THIS install's daemon only: its absolute main.js, or the relative one run at this install (`stopScript`).
    const signal = (sig: "TERM" | "KILL") => parseStopLine(String(wsl(stopScript({ port: PORT, lroot: LROOT, signal: sig }),
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).stdout ?? ""));
    const term = signal("TERM");
    const forced = !(await waitFor(false, 40));
    if (forced) signal("KILL");
    // The keeper reads the flag only once its wsl.exe returns, seconds after the daemon is gone — and
    // `start` clears the flag. So wait for the keeper to leave too: one that outlives the flag starts
    // a second daemon next to the new one.
    for (let i = 0; i < 20 && keepers().length; i++) await sleep(500);
    const left = keepers();
    for (const pid of left) exec("taskkill.exe", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    say(stopVerdict({ term, forced, keepersKilled: left.length, port: PORT }));
    taskNote();
  };

  /** Mirrored networking: WSL then sees the Windows interfaces, the Tailscale 100.x among them, and
   *  shares loopback — so the daemon binds the address the phone reaches. Edits only `[wsl2]`. */
  const ensureMirrored = (): boolean => {
    const p = join(homedir(), ".wslconfig");
    let text = "";
    try { text = readFileSync(p, "utf8"); } catch { /* none yet */ }
    const m = mirroredWslConfig(text);
    if (m.other) { say(`.wslconfig sets another networkingMode — change it to \`networkingMode=mirrored\` under [wsl2] in ${p}`); return false; }
    if (!m.changed) { say(".wslconfig: mirrored networking already on"); return false; }
    writeTextAtomicKeepMode(p, m.text);
    say(`.wslconfig: mirrored networking turned on (${p})`);
    return true;
  };

  /** A distro to run in, or stop with the one command that makes one. `wsl --install` needs an admin
   *  shell and usually a reboot, and the first launch asks for a Linux user name — none of which a
   *  script can do for anyone. */
  const ensureDistro = (): void => {
    const r = exec("wsl.exe", [...(DISTRO ? ["-d", DISTRO] : []), "--exec", "true"], { stdio: "ignore", windowsHide: true });
    if (r.status === 0) return;
    die(DISTRO
      ? `WSL has no distro named ${DISTRO} (\`wsl -l -v\` lists them). Fix ${BRAND.envPrefix}WSL_DISTRO${knobs.distroFrom === "file" ? ` in ${names.knobFile}` : ""}, or install it.`
      : "No WSL distro to run the host in. In an ADMIN PowerShell: wsl --install -d Ubuntu-24.04 — reboot if it asks, " +
        "open Ubuntu once from the Start menu to create your Linux user, then run setup again.");
  };

  /** What the host needs from the distro's package manager, installed as root through `wsl -u root`
   *  — WSL's root needs no password, so there is no `sudo` prompt to get past. apt only; another
   *  package manager gets the names (wsl-setup.sh says them again). Nothing is upgraded. */
  const ensurePackages = (): void => {
    const base = DISTRO ? ["-d", DISTRO] : [];
    const probe = 'm=""; for c in tmux git curl tar xz; do command -v "$c" >/dev/null 2>&1 || m="$m $c"; done; echo $m';
    const missing = String(exec("wsl.exe", [...base, "--exec", "bash", "-c", probe], { encoding: "utf8", windowsHide: true }).stdout ?? "").trim();
    if (!missing) return;
    const pkgs = missing.split(/\s+/).map((c) => (c === "xz" ? "xz-utils" : c)).join(" ");
    const hasApt = exec("wsl.exe", [...base, "--exec", "bash", "-c", "command -v apt-get"], { stdio: "ignore", windowsHide: true }).status === 0;
    if (!hasApt) { say(`missing in WSL: ${missing} — install them with your distro's package manager, then run setup again.`); return; }
    // An empty dpkg database (the first Windows box) fails every install on a cryptic "corrupt info
    // database" after apt has tried to reinstall libc6: name it instead (wsl-setup.sh says the way out).
    const dpkgEmpty = exec("wsl.exe", [...base, "--exec", "bash", "-c", "[ ! -s /var/lib/dpkg/status ]"], { stdio: "ignore", windowsHide: true }).status === 0;
    if (dpkgEmpty) { say(`missing in WSL: ${missing} — and apt cannot install them: the distro's package database (/var/lib/dpkg/status) is empty. Reinstall the distro (back up your WSL home first).`); return; }
    say(`installing ${pkgs} in WSL (apt-get, as WSL's root — no password needed)…`);
    // Once more with apt's index cache cleared: a truncated `InRelease` (measured on the first Windows
    // box) fails every apt-get with "Splitting of clearsigned file … failed" until it is deleted.
    const install = `apt-get update -qq && apt-get install -y -qq ${pkgs}`;
    const r = exec("wsl.exe", [...base, "-u", "root", "--exec", "bash", "-c",
      `export DEBIAN_FRONTEND=noninteractive; (${install}) || (rm -rf /var/lib/apt/lists/* && ${install})`], { stdio: "inherit", windowsHide: true });
    if (r.status !== 0) say(`could not install ${pkgs} — inside WSL: sudo apt-get update && sudo apt-get install -y ${pkgs}`);
  };

  const setup = async (): Promise<void> => {
    ensureDistro();
    rememberKnobs();
    ensurePackages();
    if (ensureMirrored()) {
      if (await healthy()) say("run `wsl --shutdown` once the host is stopped, for the network change to apply");
      else { say("restarting WSL for the network change (wsl --shutdown)…"); exec("wsl.exe", ["--shutdown"], { stdio: "inherit" }); }
    }
    // The kind decides the global git settings: a checkout's repos are on /mnt/<drive>, written by
    // Git for Windows; an npm user's may be in the Linux filesystem, where autocrlf=true is wrong.
    const r = wsl(`bash scripts/windows/wsl-setup.sh --kind ${kind}`);
    if (r.status !== 0) die("the distro is not ready yet — fix the lines above, then run setup again.");
    say(`WSL is ready. Next: ${kind === "npm" ? `\`${BRAND.slug} start\`` : "`npm run restart` (or `node scripts/windows/host.mjs start`)"}.`);
  };

  const autostart = (remove: boolean): void => {
    if (kind === "checkout") {
      // The Startup-folder .cmd the first (checkout) version dropped: the task replaces it.
      const dir = join(env.APPDATA ?? join(homedir(), "AppData/Roaming"), "Microsoft/Windows/Start Menu/Programs/Startup");
      const legacy = join(dir, `${BRAND.slug}-host.cmd`);
      if (existsSync(legacy)) { unlinkSync(legacy); say(`removed the old Startup entry (${legacy})`); }
    }
    if (remove) {
      const r = ps(`Unregister-ScheduledTask -TaskName ${psq(TASK)} -Confirm:$false -ErrorAction Stop`);
      say(r.status === 0 ? `removed the scheduled task ${TASK}` : `no autostart task ${TASK}`);
      return;
    }
    rememberKnobs();
    const keeperArgs = [`-NoProfile -ExecutionPolicy Bypass -File "${KEEPER}"`, `-Repo "${LROOT}"`, `-Log "${LOG}"`,
      `-StopFlag "${STOP_FLAG}"`, `-Port ${PORT}`, ...(DISTRO ? [`-Distro "${DISTRO}"`] : []),
      ...(ENV_PREFIX ? [`-EnvPrefix "${ENV_PREFIX}"`] : []), "-Ensure"].join(" ");
    const xml = autostartTaskXml({
      user: `${env.USERDOMAIN}\\${env.USERNAME}`, keeperArgs,
      startBoundary: new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, ""),
    });
    const file = join(tmpdir(), `${TASK}-task.xml`);
    writeTextAtomic(file, xml);
    mkdirSync(dirname(LOG), { recursive: true });   // the keeper appends to its log from its first line
    const r = ps(`Register-ScheduledTask -TaskName ${psq(TASK)} -Xml (Get-Content -Raw -Encoding UTF8 ${psq(file)}) -Force -ErrorAction Stop | Out-Null`);
    try { unlinkSync(file); } catch { /* gone */ }
    if (r.status !== 0) die(`could not register the scheduled task:\n${(r.stderr || r.stdout).trim()}`);
    say(`the host now starts at logon and comes back on wake, unlock and within 10 minutes of any stop it did not ask for (task ${TASK}; \`autostart --remove\` undoes it)`);
  };

  /** A command the host's own CLI answers, run in WSL where the host runs. */
  const inWsl = (args: string[]): number =>
    wsl(`${ENV_PREFIX}node packages/host/dist/cli/entry.js ${args.map(shq).join(" ")}`).status ?? 1;

  try {
    switch (cmd) {
      case "setup": await setup(); return 0;
      case "start": rememberKnobs(); await start(); return 0;
      case "stop": await stop(); return 0;
      case "restart": rememberKnobs(); build(); await stop(); await start(); return 0;
      case "status": say((await healthy()) ? `up · http://127.0.0.1:${PORT}` : `not running${stopFlagSet() ? " (stopped: `start` brings it back)" : ""}`); taskNote(); return 0;
      case "autostart": autostart(rest.includes("--remove")); return 0;
      // The preflight checks the build the host RUNS, so a checkout builds only when there is none:
      // a rebuild here cost ~100 s of a 139 s doctor on the first Windows box. `restart` rebuilds.
      case "doctor":
        if (!existsSync(join(root, "packages/host/dist/main.js"))) build();
        return wsl(`${ENV_PREFIX}node packages/host/dist/main.js --doctor ${rest.map(shq).join(" ")}`).status ?? 1;
      case "pair": return inWsl(["pair", ...rest]);
      case "update": {
        if (kind !== "npm") die("a checkout updates with `git pull` and `npm run restart`.");
        // Up, or a keeper between two restarts of it: either way it comes back after the update.
        const wasUp = (await healthy()) || keepers().length > 0;
        const wasStopped = stopFlagSet();
        await stop();   // idempotent: nothing of this install may hold the files npm replaces
        say(`npm install -g ${BRAND.slug}@latest…`);
        const r = exec(`npm install -g ${BRAND.slug}@latest`, [], { shell: true, stdio: "inherit", windowsHide: true });
        const installed = r.status === 0;
        if (!installed) say(`npm install failed (exit ${r.status ?? "?"}) — \`${BRAND.slug} version\` says which version is installed now.`);
        // The NEW launcher starts the host, in a fresh process: this one still holds the old code.
        if (wasUp) {
          const s = exec(`${BRAND.slug} start`, [], { shell: true, stdio: "inherit", windowsHide: true });
          return installed ? (s.status ?? 1) : (r.status ?? 1);
        }
        // It was down without anyone stopping it (the autostart task may bring it back): leave it so.
        if (!wasStopped) clearStopFlags();
        return installed ? 0 : (r.status ?? 1);
      }
      case "dev": {
        if (kind !== "checkout") die("`dev` runs Vite from a checkout.");
        // `tsx watch` cannot run in WSL off this node_modules (its esbuild binary is the Windows one),
        // so dev on Windows is: the built host in WSL with the Vite port trusted, Vite here. A host
        // edit then needs `npm run restart`; a web edit hot-reloads as usual.
        build();
        await stop();
        await start(`${ENV_PREFIX}${BRAND.envPrefix}DEV=1 `);
        const vite = spawn("npm run dev:web", { cwd: root, shell: true, stdio: "inherit" });
        return await new Promise<number>((done) => {
          const down = async () => { await stop(); done(0); };
          process.on("SIGINT", () => void down());
          vite.on("exit", () => void down());
        });
      }
      case "version": case "--version": case "-v": console.log((await import("./index.js")).versionLine(root)); return 0;
      case "service":
        say(`on Windows the host runs in WSL, kept up by a scheduled task: \`${kind === "npm" ? BRAND.slug : "node scripts/windows/host.mjs"} autostart\`.`);
        return 1;
      case "help": case "--help": case "-h": console.log(HELP(kind)); return 0;
      default:
        console.error(`${tag} unknown command: ${cmd}\n\n${HELP(kind)}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof Die) return 1;
    throw e;
  }
}
