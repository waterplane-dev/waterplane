/**
 * Install what `androidenv.ts` found missing: a JDK and the Android SDK, USER-LOCAL, resumable,
 * logged like a build, and never with sudo (`docs/analysis/first-app-plan.md`, WP3).
 *
 * The rules that make this safe to run from a phone tap:
 *
 *  - **Find first.** Every step re-probes (`probeAndroidEnv`) right before it would run and
 *    skips whatever is already there, so a second run after a failure, a restart or Android
 *    Studio being installed in between is just "the rest".
 *  - **User-local.** The JDK is a brew formula (no sudo) when brew exists, else the Adoptium
 *    tarball into `<config dir>/jdk`; the SDK goes where the probe says it is, else Android
 *    Studio's own default. Nothing is written elsewhere.
 *  - **Never sudo.** `run` refuses to start `sudo` at all. A step that cannot proceed without
 *    it (an SDK root nobody may create) ends as `needs-you` carrying the command for the
 *    PERSON to run, and the run stops there, waiting.
 *  - **A licence is accepted only with consent, and only the one the packages need.** The
 *    package install is fed `y` only when the caller passed `acceptLicences: true` (the phone's
 *    consent screen, which links the licence), so sdkmanager accepts exactly the licences of the
 *    pinned packages and the step names them. Never `--licenses`, which would accept every
 *    licence the SDK lists. Without consent the run stops at `needs-consent` BEFORE the package
 *    step; an SDK with every package and no accepted licence is `needs-you` with the command.
 *  - **Verified before unpacked.** The cmdline-tools zip is checked against the SHA-256 pinned
 *    here (Google's published value); the Adoptium JDK against the checksum its asset API lists
 *    beside the link. A mismatch deletes the file and fails the step. brew verifies its own bottles.
 *  - **Nothing here decides.** It does what the plan lists and reports each step in words.
 *
 * Network, processes, the filesystem and the clock are `ToolchainDeps`, so tests drive the
 * whole thing with fakes and never download or run an installer. Step state is persisted
 * (tmp+rename) so a restart shows where a run stopped; resuming is just running again.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  SIZE_ESTIMATE, WANT_BUILD_TOOLS, WANT_PLATFORM, invalidateAndroidProbe, probeAndroidEnv, realDeps,
  type AndroidEnvDeps, type AndroidEnvReport,
} from "./androidenv.js";
import { configDir, dataDir } from "./branddirs.js";
import { writeTextAtomic } from "./jsonstore.js";

export const TOOLCHAIN_LICENCE_URL = "https://developer.android.com/studio/terms";
/** Google's command-line tools zip. Pinned: a "latest" URL that moves is a build nobody can repeat. */
export const CMDLINE_TOOLS_BUILD = "15859902";

/**
 * The pinned zips, each with the SHA-256 Google publishes beside it on
 * https://developer.android.com/studio ("Command line tools only"), copied from that page on
 * 2026-10-02, and the byte size its server answered. A download whose hash differs is DELETED and
 * the step fails: an unverified zip is never unpacked. Bumping the build means copying all three
 * hashes again from the same page (the zip itself publishes none).
 */
export const CMDLINE_TOOLS_ZIPS: Record<"mac-arm64" | "mac-x64" | "linux", { file: string; sha256: string; bytes: number }> = {
  "mac-arm64": { file: `commandlinetools-mac_arm64-${CMDLINE_TOOLS_BUILD}_latest.zip`, sha256: "835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e", bytes: 156083281 },
  "mac-x64": { file: `commandlinetools-mac_x86_64-${CMDLINE_TOOLS_BUILD}_latest.zip`, sha256: "c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3", bytes: 156281494 },
  linux: { file: `commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip`, sha256: "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583", bytes: 181833628 },
};

export function cmdlineToolsZip(platform: NodeJS.Platform, arch: string): { url: string; file: string; sha256: string; bytes: number } {
  const z = CMDLINE_TOOLS_ZIPS[platform === "darwin" ? (arch === "arm64" ? "mac-arm64" : "mac-x64") : "linux"];
  return { ...z, url: `https://dl.google.com/android/repository/${z.file}` };
}

/** Adoptium's asset listing for the newest JDK 21: link, size and SHA-256 of each package. */
export const adoptiumAssetsUrl = (platform: NodeJS.Platform, arch: string): string =>
  `https://api.adoptium.net/v3/assets/latest/21/hotspot?os=${osWord(platform)}&architecture=${arch === "arm64" ? "aarch64" : "x64"}&image_type=jdk&vendor=eclipse`;
export const JDK_FORMULA = "openjdk@21";

export type StepId = "jdk" | "cmdline-tools" | "licences" | "sdk-packages";
export type StepStatus = "done" | "skipped" | "failed" | "needs-you" | "needs-consent";

export interface StepResult {
  id: StepId;
  status: StepStatus;
  /** One plain sentence: what happened, or why it stopped. */
  note: string;
  /** `needs-you` only: the exact command the person runs themselves. */
  command?: string;
  at: number;
}

export interface PlannedStep {
  id: StepId;
  /** Would this step do anything now? `false` ⇒ found, it will be skipped. */
  needed: boolean;
  /** What it does, in the words the consent screen can quote. */
  what: string;
}

export interface ToolchainPlan {
  steps: PlannedStep[];
  /** About how much is downloaded (the probe's estimate). */
  installBytes: number;
  /** The consent text: what, how big, where, and the licence link. */
  consent: string;
  /** Where each part will land. */
  jdkDir: string;
  sdkRoot: string;
  /** The JDK route this desktop would take. */
  jdkRoute: "brew" | "tarball";
}

export interface ToolchainDeps {
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  /** A fresh probe of the machine (called before every step). */
  probe(): AndroidEnvReport;
  /** Is `brew` runnable? */
  hasBrew(): boolean;
  /** Download `url` to `dest` (parent dirs made by the caller). Rejects on any failure. */
  fetchToFile(url: string, dest: string): Promise<void>;
  /** GET a small JSON document (the Adoptium asset listing). Rejects on any failure. */
  fetchJson(url: string): Promise<unknown>;
  /** Lower-case hex SHA-256 of a file on disk. */
  sha256(path: string): Promise<string>;
  /** Run a program (never `sudo`); stream each output line to `onLine`; resolve its exit code. */
  run(cmd: string, args: string[], o: { env?: Record<string, string>; input?: string; onLine(line: string): void }): Promise<number>;
  mkdir(path: string): void;
  rm(path: string): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  /** Persisted run state: read (null when none) and write. */
  readState(): string | null;
  writeState(text: string): void;
  /** One log line (the build-style transcript). */
  log(line: string): void;
  now(): number;
  /**
   * A FRESH directory only this user can enter, for one download: it is fetched, verified and
   * unpacked from inside it, then the step removes it. Never a shared temp dir — on Linux
   * `/tmp/<brand>-toolchain` was a path another local user could pre-create or plant a symlink
   * in between the hash and the unpack (`privateTmpUnder`).
   */
  privateTmp(): string;
  /** `<config dir>/jdk`. */
  jdkDir: string;
}

// ---------------------------------------------------------------------------------------------
// Plan

const osWord = (p: NodeJS.Platform) => (p === "darwin" ? "mac" : "linux");

export function sdkRootFor(d: Pick<ToolchainDeps, "home" | "platform">, r: AndroidEnvReport): string {
  return r.sdk?.root ?? (d.platform === "darwin" ? join(d.home, "Library", "Android", "sdk") : join(d.home, "Android", "Sdk"));
}

/**
 * The sdkmanager packages still to fetch, off the probe — what the template's build needs. The
 * EXACT pins, not "some platform": an SDK holding only android-34 cannot build a compileSdk 36
 * template, and finding it "complete" would send the first build to fail at minute three.
 */
export function wantedPackages(r: AndroidEnvReport): string[] {
  const out: string[] = [];
  if (!r.sdk?.platformTools) out.push("platform-tools");
  if (!r.sdk?.platforms.includes(WANT_PLATFORM)) out.push(`platforms;${WANT_PLATFORM}`);
  if (!r.sdk?.buildTools.includes(WANT_BUILD_TOOLS)) out.push(`build-tools;${WANT_BUILD_TOOLS}`);
  return out;
}

/** About how many bytes the needed steps download — derived from what each one fetches. */
function plannedBytes(d: Pick<ToolchainDeps, "platform" | "arch">, r: AndroidEnvReport, n: Record<StepId, boolean>): number {
  let b = 0;
  if (n.jdk) b += SIZE_ESTIMATE.jdk;
  if (n["cmdline-tools"]) b += cmdlineToolsZip(d.platform, d.arch).bytes;
  for (const p of wantedPackages(r)) {
    b += p === "platform-tools" ? SIZE_ESTIMATE.platformTools : p.startsWith("platforms;") ? SIZE_ESTIMATE.platform : SIZE_ESTIMATE.buildTools;
  }
  return b;
}

function needs(r: AndroidEnvReport): Record<StepId, boolean> {
  const pkgs = wantedPackages(r);
  return {
    jdk: !r.jdk,
    "cmdline-tools": !r.sdk?.cmdlineTools && (!r.sdk || pkgs.length > 0 || !r.sdk.licensesAccepted),
    licences: !r.sdk || !r.sdk.licensesAccepted,
    "sdk-packages": pkgs.length > 0,
  };
}

function mb(bytes: number): string {
  const n = Math.round(bytes / 1048576 / 10) * 10;
  return n >= 1000 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`;
}

export function planToolchain(d: ToolchainDeps, r: AndroidEnvReport = d.probe()): ToolchainPlan {
  const n = needs(r);
  const jdkRoute = d.hasBrew() ? "brew" : "tarball";
  const sdkRoot = sdkRootFor(d, r);
  const steps: PlannedStep[] = [
    { id: "jdk", needed: n.jdk, what: jdkRoute === "brew" ? `a JDK 21 (brew install ${JDK_FORMULA})` : `a JDK 21 (Adoptium tarball into ${d.jdkDir})` },
    { id: "cmdline-tools", needed: n["cmdline-tools"], what: `the Android SDK command-line tools (from Google, into ${sdkRoot})` },
    { id: "licences", needed: n.licences, what: `accept the Android SDK licence those packages need, and no other (${TOOLCHAIN_LICENCE_URL})` },
    { id: "sdk-packages", needed: n["sdk-packages"], what: `the SDK packages ${wantedPackages(r).join(", ") || "(none missing)"}` },
  ];
  const todo = steps.filter((s) => s.needed).map((s) => s.what);
  const installBytes = plannedBytes(d, r, n);
  return {
    steps, installBytes, jdkDir: d.jdkDir, sdkRoot, jdkRoute,
    consent: `Install ${todo.join("; ") || "nothing (all found)"}. About ${mb(installBytes)} is downloaded, ` +
      `into your home directory, no sudo. By continuing you accept the Android SDK licence: ${TOOLCHAIN_LICENCE_URL}.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Run

export interface ToolchainResult {
  /** Every step done or skipped AND a fresh probe finds nothing missing. */
  ok: boolean;
  steps: StepResult[];
  /** The probe after the run. */
  report: AndroidEnvReport;
  /** One sentence for the phone. */
  summary: string;
}

interface Persisted { steps: Partial<Record<StepId, StepResult>>; updatedAt: number; running?: boolean }

const EACCES = /EACCES|EPERM|EROFS/;

export async function runToolchainInstall(
  opts: { acceptLicences?: boolean } = {},
  d: ToolchainDeps = realToolchainDeps(),
): Promise<ToolchainResult> {
  const results: StepResult[] = [];
  const persist = (running: boolean) => {
    const steps: Persisted["steps"] = {};
    for (const s of results) steps[s.id] = s;
    try { d.writeState(JSON.stringify({ steps, updatedAt: d.now(), running } satisfies Persisted)); } catch { /* state is a convenience */ }
  };
  const push = (id: StepId, status: StepStatus, note: string, command?: string) => {
    const r: StepResult = { id, status, note, at: d.now(), ...(command ? { command } : {}) };
    results.push(r);
    d.log(`[${id}] ${status}: ${note}${command ? ` — run yourself: ${command}` : ""}`);
    persist(true);
    return r;
  };
  const onLine = (id: StepId) => (line: string) => d.log(`[${id}] ${line}`);
  const stopped = () => results.some((s) => s.status === "failed" || s.status === "needs-you" || s.status === "needs-consent");

  d.log(`toolchain install started (licences ${opts.acceptLicences === true ? "consented" : "NOT consented"})`);
  persist(true);

  const step = async (id: StepId, body: (r: AndroidEnvReport) => Promise<void>) => {
    if (stopped()) return;
    const r = d.probe(); // re-probe: whatever is found now is skipped
    if (!needs(r)[id]) { push(id, "skipped", "already there"); return; }
    try { await body(r); } catch (e) {
      const msg = String((e as Error).message || e);
      push(id, "failed", msg.slice(0, 300));
    }
  };

  await step("jdk", async () => {
    if (d.hasBrew()) {
      const code = await d.run("brew", ["install", JDK_FORMULA], { onLine: onLine("jdk") });
      if (code !== 0) throw new Error(`brew install ${JDK_FORMULA} exited ${code}`);
      push("jdk", "done", `installed ${JDK_FORMULA} with brew`);
      return;
    }
    // The asset listing, not the redirecting binary URL: it names the tarball AND its SHA-256.
    const pkg = adoptiumPackage(await d.fetchJson(adoptiumAssetsUrl(d.platform, d.arch)));
    const dir = d.privateTmp();
    let code: number;
    try {
      const tgz = join(dir, "jdk21.tar.gz");
      d.log(`[jdk] downloading ${pkg.link}`);
      await d.fetchToFile(pkg.link, tgz);
      await verify(d, tgz, pkg.checksum, "jdk");
      d.mkdir(d.jdkDir);
      code = await d.run("tar", ["-xzf", tgz, "-C", d.jdkDir], { onLine: onLine("jdk") });
    } finally { d.rm(dir); }
    if (code !== 0) throw new Error(`tar exited ${code}`);
    push("jdk", "done", `unpacked the Adoptium JDK into ${d.jdkDir}`);
  });

  await step("cmdline-tools", async (r) => {
    const root = sdkRootFor(d, r);
    try { d.mkdir(root); } catch (e) {
      if (EACCES.test(String((e as Error).message || e))) {
        // Never sudo: hand the command to the person and stop.
        push("cmdline-tools", "needs-you", `${root} cannot be created by this user`,
          `sudo mkdir -p ${root} && sudo chown "$USER" ${root}`);
        return;
      }
      throw e;
    }
    const stage = join(root, ".cmdline-extract");
    const pin = cmdlineToolsZip(d.platform, d.arch);
    const dir = d.privateTmp();
    let code: number;
    try {
      const zip = join(dir, "cmdline-tools.zip");
      d.log(`[cmdline-tools] downloading ${pin.url}`);
      await d.fetchToFile(pin.url, zip);
      await verify(d, zip, pin.sha256, "cmdline-tools");
      d.rm(stage);
      d.mkdir(stage);
      code = await unzipTo(d, zip, stage, onLine("cmdline-tools"));
    } finally { d.rm(dir); }
    if (code !== 0) { d.rm(stage); throw new Error(`unzip exited ${code}`); }
    // sdkmanager insists on `cmdline-tools/<version>/bin`; `latest` is the conventional name.
    d.mkdir(join(root, "cmdline-tools"));
    d.rm(join(root, "cmdline-tools", "latest"));
    d.rename(join(stage, "cmdline-tools"), join(root, "cmdline-tools", "latest"));
    d.rm(stage);
    push("cmdline-tools", "done", `command-line tools in ${root}/cmdline-tools/latest`);
  });

  // The licence is accepted only by the package install that needs it: `sdkmanager <pkgs>` asks
  // for exactly the licences of those packages, where `--licenses` would take every licence the
  // SDK lists (previews, add-ons) under a consent screen that linked one.
  let licencesDeferred = false;
  await step("licences", async (r) => {
    if (opts.acceptLicences !== true) {
      push("licences", "needs-consent", `the Android SDK licences are not accepted; accept them (${TOOLCHAIN_LICENCE_URL}) and run again`);
      return;
    }
    if (wantedPackages(r).length === 0) {
      const root = sdkRootFor(d, r);
      push("licences", "needs-you",
        "every SDK package is here but its licence was never accepted; read it and accept it yourself (this desktop accepts a licence only while installing a package that needs it)",
        `${sdkmanagerPath(root)} --sdk_root=${root} --licenses`);
      return;
    }
    licencesDeferred = true;
  });

  await step("sdk-packages", async () => {
    const r = d.probe();
    const root = sdkRootFor(d, r);
    const pkgs = wantedPackages(r);
    const asked: string[] = [];
    const line = onLine("sdk-packages");
    const code = await d.run(sdkmanagerPath(root), [`--sdk_root=${root}`, ...pkgs], {
      env: javaEnv(d, r),
      ...(licencesDeferred ? { input: "y\n".repeat(10) } : {}),
      onLine: (l) => { const m = /^\s*License (\S+?):?\s*$/.exec(l); if (m && !asked.includes(m[1])) asked.push(m[1]); line(l); },
    });
    if (code !== 0) throw new Error(`sdkmanager exited ${code}`);
    push("sdk-packages", "done", `installed ${pkgs.join(", ")}`);
    if (licencesDeferred) {
      push("licences", "done", asked.length
        ? `accepted ${asked.join(", ")}, as consented: the licence${asked.length > 1 ? "s" : ""} ${pkgs.join(", ")} need, and no other`
        : "accepted only what the package install asked for, as consented");
    }
  });

  const report = d.probe();
  const bad = results.find((s) => s.status === "failed" || s.status === "needs-you" || s.status === "needs-consent");
  const ok = !bad && report.missing.length === 0;
  const summary = bad
    ? `Stopped at ${bad.id}: ${bad.note}${bad.command ? `. Run: ${bad.command}` : ""}`
    : ok ? "The Android toolchain is ready." : (report.summary ?? "Something is still missing.");
  d.log(`toolchain install finished: ${summary}`);
  persist(false);
  return { ok, steps: results, report, summary };
}

/** Hash the download; a mismatch deletes it and fails the step. Never unpacks unverified bytes. */
async function verify(d: ToolchainDeps, path: string, want: string, id: StepId): Promise<void> {
  const got = (await d.sha256(path)).toLowerCase();
  if (got !== want.toLowerCase()) {
    d.rm(path);
    throw new Error(`checksum mismatch on the download (sha256 ${got.slice(0, 12)}..., expected ${want.slice(0, 12)}...); deleted it, nothing was unpacked`);
  }
  d.log(`[${id}] sha256 verified (${want.slice(0, 12)}...)`);
}

/** Python's zipfile, keeping each entry's Unix mode — `python3 -m zipfile -e` drops it, and
 *  sdkmanager must stay executable. */
const PY_UNZIP = [
  "import os, sys, zipfile",
  "z = zipfile.ZipFile(sys.argv[1])",
  "for i in z.infolist():",
  "    p = z.extract(i, sys.argv[2])",
  "    m = (i.external_attr >> 16) & 0o777",
  "    if m: os.chmod(p, m)",
].join("\n");

/** `unzip`, else python3 — a fresh Ubuntu has no `unzip`, and a phone cannot `apt install` it. */
async function unzipTo(d: ToolchainDeps, zip: string, dest: string, line: (l: string) => void): Promise<number> {
  try {
    return await d.run("unzip", ["-q", "-o", zip, "-d", dest], { onLine: line });
  } catch (e) {
    if (!/ENOENT/.test(String((e as Error).message || e))) throw e;
    line("no unzip on this desktop; extracting with python3");
    try {
      return await d.run("python3", ["-c", PY_UNZIP, zip, dest], { onLine: line });
    } catch (e2) {
      if (!/ENOENT/.test(String((e2 as Error).message || e2))) throw e2;
      throw new Error("neither unzip nor python3 is installed; install one (sudo apt install unzip) and retry");
    }
  }
}

/** The `.tar.gz` JDK package out of Adoptium's asset listing, with its checksum, or a thrown sentence. */
export function adoptiumPackage(doc: unknown): { link: string; checksum: string; size?: number } {
  const rows = Array.isArray(doc) ? doc : [];
  for (const row of rows) {
    const b = (row as { binary?: { image_type?: string; package?: { link?: unknown; checksum?: unknown; size?: unknown } } })?.binary;
    const pk = b?.package;
    if (b?.image_type !== "jdk" || !pk) continue;
    if (typeof pk.link !== "string" || !pk.link.startsWith("https://") || !/\.tar\.gz$/.test(pk.link)) continue;
    if (typeof pk.checksum !== "string" || !/^[0-9a-f]{64}$/i.test(pk.checksum)) continue;
    return { link: pk.link, checksum: pk.checksum, ...(typeof pk.size === "number" ? { size: pk.size } : {}) };
  }
  throw new Error("Adoptium's listing named no JDK 21 tarball with a SHA-256; nothing was downloaded");
}

function sdkmanagerPath(root: string): string {
  return join(root, "cmdline-tools", "latest", "bin", "sdkmanager");
}

function javaEnv(d: ToolchainDeps, r: AndroidEnvReport): Record<string, string> {
  return r.jdk ? { JAVA_HOME: r.jdk.home, PATH: `${join(r.jdk.home, "bin")}:${d.env.PATH ?? ""}` } : {};
}

/** The last persisted run, or null — what a phone shows after a host restart. */
export function readToolchainState(d: Pick<ToolchainDeps, "readState">): Persisted | null {
  try { return JSON.parse(d.readState() ?? "null") as Persisted | null; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Single flight, for the checklist fix (the install outlives the request that asked for it)

let inFlight: Promise<ToolchainResult> | null = null;

/** Start the install in the background unless one is running; returns whether this call started it. */
export function startToolchainInstall(opts: { acceptLicences?: boolean }, d?: ToolchainDeps): { started: boolean; done: Promise<ToolchainResult> } {
  if (inFlight) return { started: false, done: inFlight };
  // Whatever the run installed, the next probe (the checklist row, the plan) asks the machine again.
  const p = runToolchainInstall(opts, d).finally(() => { inFlight = null; invalidateAndroidProbe(); });
  inFlight = p;
  p.catch(() => undefined);
  return { started: true, done: p };
}

// ---------------------------------------------------------------------------------------------
// The real thing

/**
 * A new 0700 directory under `base` (the per-user data dir), made by `mkdtemp` so its name was
 * never there before, and checked to be a real directory owned by this user — no window for
 * another account to put a file or a symlink where a download is about to be verified and read.
 */
export function privateTmpUnder(base: string): string {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(base, "toolchain-"));
  chmodSync(dir, 0o700);
  const st = lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!st.isDirectory() || (uid !== null && st.uid !== uid)) throw new Error(`refusing the download dir ${dir}: not a directory of this user`);
  return dir;
}

/** Create `dest` for writing, failing if ANYTHING (a file, a symlink) is already there. */
export function exclusiveWriteStream(dest: string): WriteStream {
  return createWriteStream(dest, { flags: "wx", mode: 0o600 });
}

export function realToolchainDeps(): ToolchainDeps {
  const base: AndroidEnvDeps = realDeps();
  const dir = dataDir();
  const statePath = join(dir, "toolchain-install.json");
  const logPath = join(dir, "toolchain-install.log");
  let logStarted = false;
  const run: ToolchainDeps["run"] = (cmd, args, o) => new Promise((resolve, reject) => {
    if (cmd === "sudo" || args[0] === "sudo") { reject(new Error("refusing to run sudo")); return; }
    const p = spawn(cmd, args, { env: { ...process.env, ...o.env }, stdio: [o.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
    let buf = "";
    const feed = (b: Buffer) => {
      buf += b.toString();
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) o.onLine(l);
    };
    p.stdout?.on("data", feed);
    p.stderr?.on("data", feed);
    if (o.input !== undefined) { p.stdin?.on("error", () => undefined); p.stdin?.end(o.input); }
    p.on("error", reject);
    p.on("close", (code) => { if (buf.trim()) o.onLine(buf); resolve(code ?? 1); });
  });
  return {
    env: base.env, home: homedir(), platform: process.platform, arch: process.arch,
    // Fresh before every step: the step before may have installed exactly what is asked about.
    probe: () => { invalidateAndroidProbe(); return probeAndroidEnv(realDeps()); },
    hasBrew: () => ["/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"].some((p) => existsSync(p)),
    fetchToFile: async (url, dest) => {
      if (!url.startsWith("https://")) throw new Error("refusing a non-https download");
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      // `dest` is inside `privateTmp()`; O_EXCL so nothing pre-placed there is ever written through.
      await pipeline(Readable.fromWeb(res.body as never), exclusiveWriteStream(dest));
    },
    fetchJson: async (url) => {
      if (!url.startsWith("https://")) throw new Error("refusing a non-https request");
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`);
      return res.json();
    },
    sha256: (path) => new Promise((resolve, reject) => {
      const h = createHash("sha256");
      createReadStream(path).on("error", reject).on("data", (b) => h.update(b)).on("end", () => resolve(h.digest("hex")));
    }),
    run,
    mkdir: (p) => { mkdirSync(p, { recursive: true }); },
    rm: (p) => { rmSync(p, { recursive: true, force: true }); },
    rename: (a, b) => renameSync(a, b),
    exists: (p) => existsSync(p),
    readState: () => { try { return readFileSync(statePath, "utf8"); } catch { return null; } },
    writeState: (t) => writeTextAtomic(statePath, t),
    log: (line) => {
      try {
        mkdirSync(dir, { recursive: true });
        if (!logStarted) { writeFileSync(logPath, ""); logStarted = true; }
        appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
      } catch { /* a log is a convenience */ }
    },
    now: () => Date.now(),
    privateTmp: () => privateTmpUnder(dir),
    jdkDir: join(configDir(), "jdk"),
  };
}
