/**
 * `<slug> service install|uninstall|status` — keep the host running across
 * logins, for an install that is NOT a git checkout (the release tarball the
 * installer unpacks, or an `npm i -g`). A dev checkout keeps using
 * `deploy/install-service.sh`; both write the SAME launchd label, so this file
 * refuses to replace a checkout's job without `--force` and says which one is
 * there.
 *
 * Paths are read off the RUNNING process (`process.execPath`, this file's own
 * location), then mapped onto the installer's stable symlinks
 * (`<data>/runtime/current`, `<data>/current`) when they are inside one, so an
 * upgrade flips a symlink and the service needs no rewrite.
 *
 * The environment baked into the service is PATH (launchd's is
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which finds neither `node` nor `claude`),
 * HOME, the resolved state dir, code root and `CLAUDE_CONFIG_DIR` when named
 * (`bakedDirs`), and what the
 * person passed with `--env KEY=VALUE`. (No tmux knob: tmux is the only
 * substrate, so there is nothing to bake.) Never the
 * whole shell env — a stray `<prefix>ALLOW_PUBLIC=1` in the shell that ran
 * this would otherwise bind the LAN on every login — and never ALLOW_PUBLIC
 * itself, not even when asked: that switch is a decision made in the open,
 * in `.env`, not one buried in a service file.
 *
 * Everything that decides (plist text, unit text, conflict detection, env
 * parsing, path mapping) is pure and exported for `test/service.test.mjs`;
 * `run()` is the thin part that touches the machine. `--dry-run` prints what
 * would be written and runs nothing.
 *
 * Standalone on purpose: imports nothing from the host but `@waterplane/shared`, so
 * the CLI can load it without booting the daemon.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, LEGACY, envName, rootPick, stateDirPick } from "@waterplane/shared";
import { sleep } from "../proc.js";
import { isExecutable, onPath } from "../pathx.js";

const TAG = `[${BRAND.slug}]`;
const say = (s: string): void => console.log(`${TAG} ${s}`);
const warn = (s: string): void => console.error(`${TAG} ${s}`);

// ─── pure: arguments ──────────────────────────────────────────────────────

export interface ServiceArgs {
  cmd: "install" | "uninstall" | "status" | "help";
  dryRun: boolean;
  force: boolean;
  env: Record<string, string>;
}

/** Parse `service` argv. Throws an Error whose message is the sentence to print. */
export function parseArgs(args: readonly string[]): ServiceArgs {
  const out: ServiceArgs = { cmd: "help", dryRun: false, force: false, env: {} };
  let cmdSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--env" || a.startsWith("--env=")) {
      const kv = a === "--env" ? args[++i] : a.slice("--env=".length);
      if (kv === undefined) throw new Error("--env needs KEY=VALUE");
      const [k, v] = parseEnvPair(kv);
      out.env[k] = v;
    } else if (a === "-h" || a === "--help" || a === "help") out.cmd = "help";
    else if (!cmdSeen && (a === "install" || a === "uninstall" || a === "status")) { out.cmd = a; cmdSeen = true; }
    else throw new Error(`unknown argument: ${a} (try: service help)`);
  }
  return out;
}

/** Every spelling of the public-bind switch, current and legacy. */
const PUBLIC_KEYS = [BRAND.envPrefix, ...LEGACY.map((l) => l.envPrefix)].map((p) => `${p}ALLOW_PUBLIC`);

/** `KEY=VALUE` → `[KEY, VALUE]`, refusing what must never be baked in. */
export function parseEnvPair(kv: string): [string, string] {
  const i = kv.indexOf("=");
  if (i <= 0) throw new Error(`--env wants KEY=VALUE, got "${kv}"`);
  const k = kv.slice(0, i);
  const v = kv.slice(i + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`--env: "${k}" is not a valid variable name`);
  if (PUBLIC_KEYS.includes(k)) {
    throw new Error(`--env ${k} is refused: a service never binds a public interface. ` +
      `If you really mean it, set it in the host's .env where it is visible.`);
  }
  if (k === "PATH" || k === "HOME") throw new Error(`--env ${k} is refused: the service computes ${k} itself (see service status)`);
  if (/[\n\r\0]/.test(v)) throw new Error(`--env ${k}: the value must be one line`);
  return [k, v];
}

// ─── pure: paths ──────────────────────────────────────────────────────────

/**
 * Map the running node and CLI entry onto the installer's stable symlinks when
 * they are inside a data dir laid out by it:
 * `<data>/runtime/node-v<x>/bin/node` → `<data>/runtime/current/bin/node`,
 * `<data>/versions/<v>/bin/<slug>.mjs` → `<data>/current/bin/<slug>.mjs`.
 * Anything else (an `npm i -g`, a checkout) is returned as it is.
 */
export function stablePaths(
  p: { node: string; entry: string },
  exists: (path: string) => boolean,
): { node: string; entry: string } {
  let { node, entry } = p;
  const n = /^(.*)\/runtime\/node-v[^/]+\/bin\/node$/.exec(node);
  if (n && exists(`${n[1]}/runtime/current/bin/node`)) node = `${n[1]}/runtime/current/bin/node`;
  const e = /^(.*)\/versions\/[^/]+\/(bin\/[^/]+)$/.exec(entry);
  if (e && exists(`${e[1]}/current/${e[2]}`)) entry = `${e[1]}/current/${e[2]}`;
  return { node, entry };
}

/** PATH for the service: the given dirs first (node, claude, …), then the platform's defaults, deduped. */
export function composePath(dirs: readonly (string | null | undefined)[], platform: NodeJS.Platform): string {
  const sys = platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...dirs, ...sys]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(":");
}

// ─── pure: file text ──────────────────────────────────────────────────────

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface ServiceSpec {
  /** argv: node, entry, "start". */
  program: string[];
  workingDir: string;
  /** Exactly what the service sees, PATH and HOME included. */
  env: Record<string, string>;
}

export function plistText(spec: ServiceSpec & { label: string; outLog: string; errLog: string }): string {
  const args = spec.program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.errLog)}</string>
</dict>
</plist>
`;
}

/** One systemd word, double-quoted: `\` and `"` escaped, `%` doubled (specifier). */
const sdQuote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** WorkingDirectory= takes a bare path: systemd rejects a quoted one ("path is not absolute")
 *  and the unit never starts. Spaces are fine unquoted; only `%` specifiers need escaping. */
const sdPath = (s: string): string => s.replace(/%/g, "%%");

export function unitText(spec: ServiceSpec & { description: string }): string {
  const env = Object.entries(spec.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join("\n");
  return `[Unit]
Description=${spec.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${spec.program.map(sdQuote).join(" ")}
WorkingDirectory=${sdPath(spec.workingDir)}
${env}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// ─── pure: what is already installed ──────────────────────────────────────

/** The `ProgramArguments` strings of a plist (enough of a parser for the ones we and install-service.sh write). */
export function plistProgram(text: string): string[] {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!m) return [];
  const unxml = (s: string): string =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((x) => unxml(x[1]));
}

/** The words of a unit's `ExecStart=` (double-quoted or bare). */
export function unitProgram(text: string): string[] {
  const m = /^ExecStart=(.*)$/m.exec(text);
  if (!m) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const w of m[1].matchAll(re)) {
    out.push(w[1] !== undefined ? w[1].replace(/\\(.)/g, "$1").replace(/%%/g, "%") : w[2]);
  }
  return out;
}

/** The `EnvironmentVariables` dict of a plist. */
export function plistEnv(text: string): Record<string, string> {
  const m = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text);
  if (!m) return {};
  const unxml = (s: string): string =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const out: Record<string, string> = {};
  for (const x of m[1].matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) out[unxml(x[1])] = unxml(x[2]);
  return out;
}

/** Every `Environment=` of a unit (double-quoted `"K=V"` or bare `K=V`). */
export function unitEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^Environment=(.*)$/gm)) {
    const raw = m[1].trim();
    const kv = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1").replace(/%%/g, "%") : raw;
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

/**
 * The code root, the global state dir and the claude CLI's config dir,
 * RESOLVED now and baked into the service — `@waterplane/shared`'s precedence,
 * the same the daemon uses. Baked because launchd and systemd start the host
 * with almost no environment: a service that resolved them itself would ignore
 * the `XDG_STATE_HOME`, `<PREFIX>STATE_DIR` or `CLAUDE_CONFIG_DIR` the shell
 * that installed it had — keep its state somewhere else than `doctor` from that
 * shell reports, or read `~/.claude` while that shell's `claude` signs in to a
 * different dir (every session then opens on the sign-in screen). `--env`
 * still wins.
 *
 * The state dir is ALWAYS baked (it must not move under a running service). The
 * root and `CLAUDE_CONFIG_DIR` only when the shell NAMED them: an unnamed root
 * re-derives to the same `<HOME>/dev` from the baked HOME, and baking it would
 * make the daemon believe someone chose it — `ROOT_DEFAULTED` false, so the
 * doctor's missing-root hint never shows under the service.
 */
export function bakedDirs(e: Record<string, string | undefined>, home: string, cwd: string): Record<string, string> {
  const root = rootPick(e, home);
  const cfg = (e.CLAUDE_CONFIG_DIR ?? "").trim();
  return {
    ...(root.defaulted ? {} : { [envName("ROOT")]: resolve(cwd, root.root) }),
    [envName("STATE_DIR")]: resolve(cwd, stateDirPick(e, home).dir),
    ...(cfg ? { CLAUDE_CONFIG_DIR: resolve(cwd, cfg) } : {}),
  };
}

/** The whole service environment, in its precedence: computed PATH/HOME, baked dirs, then `--env`. */
export function serviceEnv(path: string, home: string, e: Record<string, string | undefined>, cwd: string, userEnv: Record<string, string>): Record<string, string> {
  return { PATH: path, HOME: home, ...bakedDirs(e, home, cwd), ...userEnv };
}

export type Existing =
  | { kind: "checkout"; repo: string; program: string[] }
  | { kind: "release"; program: string[] }
  | { kind: "other"; program: string[] };

/**
 * What an existing service runs. A checkout is `<repo>/packages/host/dist/main.js`
 * (what `deploy/install-service.sh` writes) where `<repo>` holds a `.git`;
 * a release is anything running `bin/<slug>.mjs`.
 */
export function classify(program: readonly string[], isGitCheckout: (dir: string) => boolean): Existing {
  for (const a of program) {
    const m = /^(.*)\/packages\/host\/dist\/main\.js$/.exec(a);
    if (m && isGitCheckout(m[1])) return { kind: "checkout", repo: m[1], program: [...program] };
  }
  const bin = new RegExp(`/bin/${BRAND.slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.mjs$`);
  if (program.some((a) => bin.test(a))) return { kind: "release", program: [...program] };
  return { kind: "other", program: [...program] };
}

/** The sentence refusing to replace a dev checkout's service, or null when there is nothing to refuse. */
export function conflictSentence(existing: Existing | null, file: string, force: boolean): string | null {
  if (!existing || existing.kind !== "checkout" || force) return null;
  return `${file} runs a development checkout at ${existing.repo} (installed by deploy/install-service.sh). ` +
    `Remove it first with: bash ${existing.repo}/deploy/uninstall-service.sh — or re-run with --force to replace it.`;
}

// ─── machine ──────────────────────────────────────────────────────────────

const HOME = homedir();
const isGitCheckout = (dir: string): boolean => existsSync(join(dir, ".git"));

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };

/** First executable `name` on PATH, then in the places Claude Code's installers put it. */
function which(name: string, extra: string[] = []): string | null {
  return onPath(name, process.env.PATH ?? "", extra);
}

/** The top of the install this file runs from: `<top>/packages/host/dist/cli/service.js`. */
function installTop(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

interface Plan extends ServiceSpec {
  node: string;
  entry: string;
  claude: string | null;
  tmux: string | null;
}

function plan(userEnv: Record<string, string>): Plan {
  const top = installTop();
  const binEntry = join(top, "bin", `${BRAND.slug}.mjs`);
  const argv1 = process.argv[1] ? resolve(process.argv[1]) : "";
  const fallback = argv1 && isFile(argv1) ? argv1 : join(top, "packages", "host", "dist", "cli", "index.js");
  const raw = { node: process.execPath, entry: existsSync(binEntry) ? binEntry : fallback };
  const stable = stablePaths(raw, existsSync);
  const entry = stable.entry;
  let node = stable.node;
  // A package manager's versioned path (`.../Cellar/node/<v>/bin/node`) dies on
  // the next upgrade; the `node` on PATH that resolves to the same binary does not.
  if (node === process.execPath) {
    const onPath = which("node");
    try { if (onPath && realpathSync(onPath) === realpathSync(node)) node = onPath; } catch { /* keep execPath */ }
  }
  const claude = which("claude", [join(HOME, ".local", "bin"), join(HOME, ".claude", "local")]);
  const tool = (n: string): string | null => { const p = which(n); return p ? dirname(p) : null; };
  const path = composePath(
    [dirname(node), claude ? dirname(claude) : null, tool("git"), tool("tmux"), tool("tailscale")],
    process.platform,
  );
  return {
    node, entry, claude, program: [node, entry, "start"], workingDir: HOME,
    env: serviceEnv(path, HOME, process.env, process.cwd(), userEnv),
    tmux: which("tmux"),
  };
}

function sh(cmd: string, args: string[], quiet = true): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
}


// ── macOS ──

const plistPath = (label: string): string => join(HOME, "Library", "LaunchAgents", `${label}.plist`);
const readExisting = (file: string, parse: (t: string) => string[]): Existing | null => {
  if (!existsSync(file)) return null;
  try { return classify(parse(readFileSync(file, "utf8")), isGitCheckout); } catch { return null; }
};

async function macInstall(a: ServiceArgs): Promise<number> {
  const label = BRAND.launchdLabel;
  const dest = plistPath(label);
  const legacy = LEGACY.map((l) => l.launchdLabel).filter((l) => l !== label);
  for (const f of [dest, ...legacy.map(plistPath)]) {
    const refuse = conflictSentence(readExisting(f, plistProgram), f, a.force);
    if (refuse) { warn(refuse); return 1; }
  }
  const p = plan(a.env);
  const logs = join(HOME, "Library", "Logs");
  const text = plistText({
    ...p, label,
    outLog: join(logs, `${BRAND.slug}-host.out.log`), errLog: join(logs, `${BRAND.slug}-host.err.log`),
  });
  if (!p.claude) warn("claude was not found; the service will start, but it cannot drive Claude Code until it is installed.");
  if (!p.tmux) warn("tmux was not found; the service will start, but it refuses to start sessions until tmux is installed (see: doctor).");
  if (a.dryRun) {
    say(`would write ${dest}:`);
    process.stdout.write(text);
    say(`would run: launchctl bootout gui/<uid>/${label}; launchctl bootstrap gui/<uid> ${dest}; launchctl kickstart -k gui/<uid>/${label}`);
    return 0;
  }
  const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
  // An install made under an older identity is a second job on the same port,
  // and KeepAlive would fight this one for it for ever: retire it.
  for (const old of legacy) {
    const f = plistPath(old);
    if (existsSync(f) || sh("launchctl", ["print", `${domain}/${old}`]).ok) {
      say(`retiring the older service ${old}`);
      sh("launchctl", ["bootout", `${domain}/${old}`]);
      rmSync(f, { force: true });
    }
  }
  mkdirSync(logs, { recursive: true });
  writeAtomic(dest, text);
  say(`wrote ${dest}`);
  sh("launchctl", ["bootout", `${domain}/${label}`]);
  // bootout returns before the job is gone; bootstrap meanwhile fails with an I/O error.
  let boot = sh("launchctl", ["bootstrap", domain, dest]);
  for (let i = 0; !boot.ok && i < 10; i++) { await sleep(500); boot = sh("launchctl", ["bootstrap", domain, dest]); }
  if (!boot.ok) { warn(`launchctl bootstrap failed: ${boot.out}`); return 1; }
  sh("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
  say(`service ${label} is running ${p.entry}`);
  say(`logs: ${logs}/${BRAND.slug}-host.{out,err}.log`);
  return 0;
}

function macUninstall(a: ServiceArgs): number {
  const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
  let any = false;
  for (const label of [BRAND.launchdLabel, ...LEGACY.map((l) => l.launchdLabel)]) {
    const f = plistPath(label);
    const ex = readExisting(f, plistProgram);
    const refuse = conflictSentence(ex, f, a.force);
    if (refuse) { warn(refuse.replace("Remove it first with", "It is not this install's to remove; use")); return 1; }
    if (!existsSync(f)) continue;
    any = true;
    if (a.dryRun) { say(`would boot out ${label} and remove ${f}`); continue; }
    sh("launchctl", ["bootout", `${domain}/${label}`]);
    rmSync(f, { force: true });
    say(`removed ${f}`);
  }
  if (!any) say("no service is installed.");
  return 0;
}

function macStatus(): number {
  const label = BRAND.launchdLabel;
  const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
  for (const l of [label, ...LEGACY.map((x) => x.launchdLabel)]) {
    const f = plistPath(l);
    if (!existsSync(f)) { if (l === label) say(`not installed (${f} does not exist)`); continue; }
    describe(f, readExisting(f, plistProgram));
    say(`  loaded: ${sh("launchctl", ["print", `${domain}/${l}`]).ok ? "yes" : "no"}`);
  }
  describePlan();
  return 0;
}

// ── Linux / WSL ──

const unitPath = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "systemd", "user", `${BRAND.slug}.service`);

/**
 * The environment the INSTALLED service starts the host with (this platform's
 * plist or unit, current label first), or null when none is installed. For the
 * doctor, which compares the state dir that env resolves to with its own.
 */
export function installedServiceEnv(): { file: string; env: Record<string, string> } | null {
  const files = process.platform === "darwin"
    ? [BRAND.launchdLabel, ...LEGACY.map((l) => l.launchdLabel)].map(plistPath)
    : [unitPath()];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    return { file, env: process.platform === "darwin" ? plistEnv(text) : unitEnv(text) };
  }
  return null;
}

const isWsl = (): boolean => {
  try { return /microsoft/i.test(readFileSync("/proc/version", "utf8")); } catch { return false; }
};
const systemdIsInit = (): boolean => {
  try { return readFileSync("/proc/1/comm", "utf8").trim() === "systemd"; } catch { return false; }
};

/** The command that starts the host, for a person to paste somewhere: the wrapper when there is one. */
function startCommand(p: Plan): string {
  const wrapper = join(HOME, ".local", "bin", BRAND.slug);
  return isExecutable(wrapper) ? `${wrapper} start` : `${p.node} ${p.entry} start`;
}

/** What to tell a WSL user (pure, so the exact Windows line is pinned by a test). */
export function wslAdviceLines(distro: string | undefined, startCmd: string, systemd: boolean): string[] {
  const d = distro || "<your distro>";
  const out: string[] = [];
  if (!systemd) {
    out.push(
      "WSL is running without systemd, so there is no user service to install. Either:",
      "  1. enable systemd: put these two lines in /etc/wsl.conf (sudo), run `wsl --shutdown` in Windows, then re-run this:",
      "       [boot]",
      "       systemd=true",
      "  2. or start it from Windows at logon (Task Scheduler; paste into a Windows terminal):",
      `       schtasks /create /tn "${BRAND.name}" /sc onlogon /tr "wsl.exe -d ${d} -e ${startCmd}"`,
    );
  }
  out.push(
    "Note: WSL stops the distro, and then its VM, once no Windows-side wsl.exe session is open and the idle",
    "  timeout passes (vmIdleTimeout in %UserProfile%\\.wslconfig). A systemd service runs only while the VM is up;",
    systemd
      ? `  it does not keep it up. To keep it up, hold a session open from Windows at logon: schtasks /create /tn "${BRAND.name} keepalive" /sc onlogon /tr "wsl.exe -d ${d} -e sleep infinity"`
      : "  it does not keep it up. The Task Scheduler line above keeps a session open, and so keeps the host reachable.",
  );
  return out;
}

const wslAdvice = (p: Plan, systemd: boolean): void =>
  wslAdviceLines(process.env.WSL_DISTRO_NAME, startCommand(p), systemd).forEach(say);

function linuxInstall(a: ServiceArgs): number {
  const p = plan(a.env);
  const wsl = isWsl();
  const systemd = systemdIsInit();
  const dest = unitPath();
  const text = unitText({ ...p, description: `${BRAND.name} host` });
  if (a.dryRun) {
    say(`would write ${dest}:`);
    process.stdout.write(text);
    say(`would run: systemctl --user daemon-reload; systemctl --user enable ${BRAND.slug}.service; systemctl --user restart ${BRAND.slug}.service`);
  }
  if (!systemd) {
    if (wsl) { wslAdvice(p, false); return 0; }
    warn(`systemd is not this machine's init, so no service ${a.dryRun ? "could be" : "was"} installed. ` +
      `Start the host from your init system or a login script: ${startCommand(p)}`);
    return 1;
  }
  const refuse = conflictSentence(readExisting(dest, unitProgram), dest, a.force);
  if (refuse) { warn(refuse); return 1; }
  if (!p.claude) warn("claude was not found; the service will start, but it cannot drive Claude Code until it is installed.");
  if (!p.tmux) warn("tmux was not found; the service will start, but it refuses to start sessions until tmux is installed (see: doctor).");
  if (a.dryRun) return 0;
  writeAtomic(dest, text);
  say(`wrote ${dest}`);
  const steps: string[][] = [["daemon-reload"], ["enable", `${BRAND.slug}.service`], ["restart", `${BRAND.slug}.service`]];
  for (const s of steps) {
    const r = sh("systemctl", ["--user", ...s]);
    if (!r.ok) { warn(`systemctl --user ${s.join(" ")} failed: ${r.out}`); return 1; }
  }
  say(`service ${BRAND.slug}.service is running ${p.entry}`);
  say(`logs: journalctl --user -u ${BRAND.slug} -f`);
  const user = process.env.USER || userInfo().username;
  const linger = sh("loginctl", ["show-user", user, "-p", "Linger"]);
  if (!/Linger=yes/.test(linger.out)) {
    say("To keep it running while you are logged out (and start it at boot), run once:");
    say(`  sudo loginctl enable-linger ${user}`);
  }
  if (wsl) wslAdvice(p, true);
  return 0;
}

function linuxUninstall(a: ServiceArgs): number {
  const dest = unitPath();
  if (!existsSync(dest)) { say("no service is installed."); return 0; }
  const refuse = conflictSentence(readExisting(dest, unitProgram), dest, a.force);
  if (refuse) { warn(refuse); return 1; }
  if (a.dryRun) { say(`would disable ${BRAND.slug}.service and remove ${dest}`); return 0; }
  sh("systemctl", ["--user", "disable", "--now", `${BRAND.slug}.service`]);
  rmSync(dest, { force: true });
  sh("systemctl", ["--user", "daemon-reload"]);
  say(`removed ${dest}`);
  return 0;
}

function linuxStatus(): number {
  const dest = unitPath();
  if (!existsSync(dest)) say(`not installed (${dest} does not exist)`);
  else {
    describe(dest, readExisting(dest, unitProgram));
    const r = sh("systemctl", ["--user", "is-active", `${BRAND.slug}.service`]);
    say(`  active: ${r.out || "unknown"}`);
  }
  if (isWsl() && !systemdIsInit()) say("WSL without systemd: run `service install` for the two ways to start it at logon.");
  describePlan();
  return 0;
}

// ── shared ──

function describe(file: string, ex: Existing | null): void {
  say(`installed: ${file}`);
  if (!ex) { say("  (could not read it)"); return; }
  const what = ex.kind === "checkout" ? `a development checkout at ${ex.repo}`
    : ex.kind === "release" ? "a release install" : "something this tool did not write";
  say(`  runs ${what}: ${ex.program.join(" ")}`);
}

function describePlan(): void {
  const p = plan({});
  say(`this install would run: ${p.program.join(" ")}`);
  say(`  with PATH=${p.env.PATH}`);
}

const HELP = `usage: ${BRAND.slug} service <install|uninstall|status> [--dry-run] [--force] [--env KEY=VALUE]...

  install     keep the host running across logins (launchd on macOS, a systemd
              user unit on Linux/WSL). Re-run after moving the install.
  uninstall   remove that service. Leaves your repos, settings and state alone.
  status      what is installed, what it runs, and what this install would run.

  --dry-run   print the service file and the commands instead of running them
  --force     replace (or remove) a service that runs a development checkout
  --env K=V   bake one variable into the service (repeatable). PATH and HOME
              are computed; ALLOW_PUBLIC is refused.`;

export async function run(args: string[]): Promise<number> {
  let a: ServiceArgs;
  try { a = parseArgs(args); } catch (e) { warn((e as Error).message); return 2; }
  if (a.cmd === "help") { console.log(HELP); return 0; }
  const mac = process.platform === "darwin";
  if (!mac && process.platform !== "linux") {
    warn(`service is supported on macOS and Linux (Windows: inside WSL2), not on ${process.platform}.`);
    return 1;
  }
  if (a.cmd === "status") return mac ? macStatus() : linuxStatus();
  if (a.cmd === "uninstall") return mac ? macUninstall(a) : linuxUninstall(a);
  return mac ? macInstall(a) : linuxInstall(a);
}
