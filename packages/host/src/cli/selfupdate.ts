/**
 * `<slug> update` — replace this install with a newer release, by explicit
 * command only. Nothing here runs on its own: no timer, no boot hook, no
 * "update on restart". The doctor row only SAYS a release is available.
 *
 * Only a tarball install updates itself, because only there do we own the
 * layout (docs/notes/distribution.md, "Self-update"):
 *
 *   <data>/versions/<v>/          one extracted release per version
 *   <data>/current -> versions/<v>
 *   <data>/runtime/node-v<n>-<os>-<arch>/, <data>/runtime/current -> that
 *
 * An npm global install is told the `npm i -g` line, a checkout `git pull` and
 * `npm run restart`; anything else is "don't know", never a guess.
 *
 * Trust: `release.json` and the tarball's `.sha256` are each checked against the
 * publisher's Ed25519 signature (`<file>.sig`, `releasesig.ts`) BEFORE their
 * content is read — release.json decides which version to fetch, the .sha256
 * which bytes to accept. A missing or wrong signature refuses the update and
 * installs nothing. `<PREFIX>INSECURE_SKIP_SIG=1` skips that, loudly — the same
 * escape hatch, with the same meaning, as the installer's.
 *
 * Exit codes: 0 done / already current · 1 failed or refused · 2 usage ·
 * 3 this install does not update itself · 10 `--check` found a newer release.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync,
  renameSync, rmSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, envName } from "@waterplane/shared";
import { env, STATE_DIR } from "../env.js";
import { identity } from "./index.js";
import { sigPolicy, sigRefusal, type SigPolicy } from "./releasesig.js";
import { plistEnv, unitEnv } from "./service.js";
import { readSnapshot, restoreState, snapshotState } from "./statesnap.js";

// ── pure parts (pinned by packages/host/test/selfupdate.test.mjs) ──────────

export type InstallMode =
  | { kind: "tarball"; dataDir: string; version: string; root: string }
  | { kind: "npm"; root: string }
  | { kind: "checkout"; root: string }
  | { kind: "unknown"; root: string };

/**
 * What kind of install `file` (this module's REAL path, `…/packages/host/dist/cli/<f>.js`)
 * belongs to. `exists` is asked about marker files so the rule is testable without a disk:
 * a tarball root carries `release.json` and sits at `<data>/versions/<v>/`; an npm global
 * root is `…/node_modules/<slug>/`; a checkout root has `.git` (a dir, or a worktree's file).
 */
export function detectMode(file: string, exists: (p: string) => boolean, slug: string = BRAND.slug): InstallMode {
  const root = resolve(dirname(file), "../../../..");
  const parts = root.split(sep);
  const n = parts.length;
  if (n >= 3 && parts[n - 2] === "versions" && parts[n - 1] && !parts[n - 1]!.startsWith(".") && exists(join(root, "release.json"))) {
    return { kind: "tarball", dataDir: parts.slice(0, n - 2).join(sep) || sep, version: parts[n - 1]!, root };
  }
  if (n >= 2 && parts[n - 2] === "node_modules" && parts[n - 1] === slug) return { kind: "npm", root };
  if (exists(join(root, ".git"))) return { kind: "checkout", root };
  return { kind: "unknown", root };
}

interface Semver { core: [number, number, number]; pre: string[] }
function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence: -1 / 0 / 1, or null when either side is not a version (never a guess). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  // A pre-release sorts BELOW its release; then identifier by identifier.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** `sha256sum` / SHASUMS256.txt text → file name → lowercase hex. `*name` (binary mode) accepted. */
export function parseShaLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}

/** nodejs.org's name for a build: `node-v24.21.0-darwin-arm64`, or null where there is none for us. */
export function nodeDistName(version: string, platform: string, arch: string): string | null {
  const v = version.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) return null;
  const os = platform === "darwin" || platform === "linux" ? platform : null;
  const a = arch === "x64" || arch === "arm64" ? arch : arch === "arm" && platform === "linux" ? "armv7l" : null;
  return os && a ? `node-v${v}-${os}-${a}` : null;
}

/** `node-v24.21.0-linux-x64` → `24.21.0`. */
export function nodeVersionOfDir(name: string): string | null {
  return /^node-v(\d+\.\d+\.\d+)-/.exec(name)?.[1] ?? null;
}

/**
 * Which installed versions to delete: keep `current` always, then the newest by
 * semver until `keep` are kept. Names that are not versions (temp dirs) are never
 * returned — they are not ours to judge here.
 */
export function selectPrune(installed: string[], current: string | null, keep = 2): string[] {
  const versions = installed.filter((v) => parseSemver(v));
  const sorted = [...versions].sort((a, b) => -(compareVersions(a, b) ?? 0));
  const kept = new Set<string>();
  if (current && versions.includes(current)) kept.add(current);
  for (const v of sorted) { if (kept.size >= keep) break; kept.add(v); }
  return sorted.filter((v) => !kept.has(v));
}

/** The version `--rollback` goes to: the newest installed one below `current`. */
export function rollbackTarget(installed: string[], current: string): string | null {
  const lower = installed.filter((v) => compareVersions(v, current) === -1).sort((a, b) => -(compareVersions(a, b) ?? 0));
  return lower[0] ?? null;
}

// ── sources ────────────────────────────────────────────────────────────────

export const DEFAULT_RELEASE_URL = `https://github.com/${BRAND.githubOrg}/${BRAND.slug}/releases/latest/download/`;

export interface ReleaseInfo { name: string; version: string; commit?: string; node?: string; protocolVersion?: number }

/** `--from` beats the env knob beats the GitHub default. A local dir or `file:` URL is read from disk. */
export function releaseSource(from: string | null): string {
  return from || env("RELEASE_URL") || DEFAULT_RELEASE_URL;
}

async function fetchBytes(base: string, name: string, timeoutMs: number): Promise<Buffer> {
  if (/^https?:\/\//.test(base)) {
    const url = new URL(name, base.endsWith("/") ? base : `${base}/`);
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!res.ok) throw new Error(`${url.href}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const dir = base.startsWith("file:") ? fileURLToPath(base) : base;
  return readFileSync(join(dir, name));
}

/** A download whose publisher signature is missing or wrong — a refusal, not a network hiccup. */
export class SignatureRefused extends Error {}

/** The signature policy this process runs under: `<PREFIX>INSECURE_SKIP_SIG=1` skips, else the embedded key. */
export const currentSigPolicy = (): SigPolicy => sigPolicy(env("INSECURE_SKIP_SIG"));

/** The loud line said once per run when the publisher check is off. Never silent. */
export const SKIP_SIG_WARNING =
  `WARNING: ${envName("INSECURE_SKIP_SIG")}=1 — NOT checking who published this release. Only do this for a release you built yourself.`;

/**
 * `name`'s bytes from `base`, returned only once `<name>.sig` verifies under
 * `policy` — so nothing reads a release file before its publisher is checked.
 * Throws SignatureRefused when the .sig is missing or wrong.
 */
export async function fetchSigned(base: string, name: string, timeoutMs: number, policy: SigPolicy): Promise<Buffer> {
  if (policy.kind === "skip") return fetchBytes(base, name, timeoutMs);
  const [bytes, sig] = await Promise.all([
    fetchBytes(base, name, timeoutMs),
    fetchBytes(base, `${name}.sig`, Math.min(timeoutMs, 30_000)).then((b) => b.toString("utf8"), () => null),
  ]);
  const why = sigRefusal(name, bytes, sig, policy.key);
  if (why) throw new SignatureRefused(why);
  return bytes;
}

/**
 * The newest release's `release.json`, its signature verified before it is
 * parsed. Throws on network/parse failure, SignatureRefused on a bad signature.
 */
export async function latestRelease(source: string, timeoutMs = 10_000, policy: SigPolicy = currentSigPolicy()): Promise<ReleaseInfo> {
  const raw = JSON.parse((await fetchSigned(source, "release.json", timeoutMs, policy)).toString("utf8")) as Record<string, unknown>;
  if (typeof raw.version !== "string" || !parseSemver(raw.version)) throw new Error("release.json carries no version");
  return {
    name: typeof raw.name === "string" ? raw.name : BRAND.slug,
    version: raw.version,
    commit: typeof raw.commit === "string" ? raw.commit : undefined,
    node: typeof raw.node === "string" ? raw.node.replace(/^v/, "") : undefined,
    protocolVersion: typeof raw.protocolVersion === "number" ? raw.protocolVersion : undefined,
  };
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

// ── the install on disk ────────────────────────────────────────────────────

/** This module's install mode, off its real path. */
export function currentMode(): InstallMode {
  let file = fileURLToPath(import.meta.url);
  try { file = realpathSync(file); } catch { /* keep as given */ }
  return detectMode(file, existsSync);
}

const linkTarget = (link: string): string | null => {
  try { const t = readlinkSync(link); return isAbsolute(t) ? t : resolve(dirname(link), t); } catch { return null; }
};

/** Replace (or create) `link` → `target` atomically: a temp symlink renamed over it. */
function swapLink(link: string, target: string): void {
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

function installedVersions(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, "versions"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && parseSemver(d.name))
      .map((d) => d.name);
  } catch { return []; }
}

/** Which version `<data>/current` points at (may differ from the running one mid-update). */
function currentVersion(dataDir: string): string | null {
  const t = linkTarget(join(dataDir, "current"));
  return t ? t.split(sep).pop() ?? null : null;
}

/** The version of the Node the wrapper runs (`runtime/current/bin/node`), or null. */
function runtimeVersion(dataDir: string): string | null {
  const bin = join(dataDir, "runtime", "current", "bin", "node");
  if (!existsSync(bin)) return null;
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^v/, "") || null;
  } catch { return null; }
}

/** One update at a time per install: `versions/.update.lock` holding a pid. */
function takeLock(dataDir: string): (() => void) | string {
  const lock = join(dataDir, "versions", ".update.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return `could not take ${lock}: ${String(e)}`;
      const pid = Number(readFileSync(lock, "utf8").trim());
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch { alive = false; } }
      if (alive) return `another update is running (pid ${pid}).`;
      rmSync(lock, { force: true });
    }
  }
  return `could not take ${lock}.`;
}

/** Extract a `.tar.gz` holding ONE top dir into `parent/<final>`, atomically. */
function extractInto(tarball: Buffer, parent: string, final: string, label: string): void {
  const tmp = join(parent, `.tmp-${label}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const file = join(tmp, "download.tar.gz");
    writeFileSync(file, tarball);
    execFileSync("tar", ["-xzf", file, "-C", tmp], { stdio: ["ignore", "ignore", "pipe"] });
    rmSync(file);
    const tops = readdirSync(tmp);
    if (tops.length !== 1) throw new Error(`expected one top directory in the ${label} archive, found ${tops.length}`);
    renameSync(join(tmp, tops[0]!), join(parent, final));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Download + verify + install this os/arch's Node `version` under `runtime/`. Returns its dir name. */
async function installNode(dataDir: string, version: string): Promise<string> {
  const name = nodeDistName(version, process.platform, process.arch);
  if (!name) throw new Error(`no Node ${version} build is published for ${process.platform}-${process.arch}`);
  const runtime = join(dataDir, "runtime");
  mkdirSync(runtime, { recursive: true });
  if (existsSync(join(runtime, name, "bin", "node"))) return name;
  const base = `https://nodejs.org/dist/v${version}/`;
  console.log(`  downloading Node ${version} (${name})…`);
  const sums = parseShaLines((await fetchBytes(base, "SHASUMS256.txt", 30_000)).toString("utf8"));
  const want = sums.get(`${name}.tar.gz`);
  if (!want) throw new Error(`SHASUMS256.txt lists no ${name}.tar.gz`);
  const tar = await fetchBytes(base, `${name}.tar.gz`, 10 * 60_000);
  const got = sha256(tar);
  if (got !== want) throw new Error(`Node archive checksum mismatch (expected ${want}, got ${got}) — refusing`);
  extractInto(tar, runtime, name, "node");
  return name;
}

/** Prune runtimes no kept version asks for, never the one `runtime/current` points at. */
function pruneRuntimes(dataDir: string): void {
  const runtime = join(dataDir, "runtime");
  const live = linkTarget(join(runtime, "current"))?.split(sep).pop();
  const wanted = new Set<string>();
  for (const v of installedVersions(dataDir)) {
    const n = readRelease(join(dataDir, "versions", v))?.node;
    if (n) wanted.add(n);
  }
  let names: string[] = [];
  try { names = readdirSync(runtime); } catch { return; }
  for (const d of names) {
    const nv = nodeVersionOfDir(d);
    if (!nv || d === live || wanted.has(nv)) continue;
    rmSync(join(runtime, d), { recursive: true, force: true });
    console.log(`  removed runtime ${d}`);
  }
}

function readRelease(root: string): ReleaseInfo | null {
  try {
    const r = JSON.parse(readFileSync(join(root, "release.json"), "utf8")) as Record<string, unknown>;
    return typeof r.version === "string"
      ? { name: String(r.name ?? ""), version: r.version, node: typeof r.node === "string" ? r.node.replace(/^v/, "") : undefined }
      : null;
  } catch { return null; }
}

// ── the service ────────────────────────────────────────────────────────────

/**
 * The service definition that runs THIS install, if one is registered. A
 * definition is ours only when its text names this data dir, or names a
 * wrapper that does — a launchd job left by a dev checkout under the same
 * label must never be restarted by a tarball update (and a test install in a
 * temp dir never touches the real one).
 */
interface Service { file: string; restart: [string, string[]]; stop: [string, string[]]; start: [string, string[]]; env: Record<string, string> }
function serviceFor(dataDir: string): Service | null {
  const home = homedir();
  const wrapper = join(home, ".local", "bin", BRAND.slug);
  const names = (text: string): boolean => {
    if (text.includes(dataDir)) return true;
    if (!text.includes(wrapper)) return false;
    try { return readFileSync(wrapper, "utf8").includes(dataDir); } catch { return false; }
  };
  let file: string, restart: [string, string[]], stop: [string, string[]], start: [string, string[]];
  if (process.platform === "darwin") {
    file = join(home, "Library", "LaunchAgents", `${BRAND.launchdLabel}.plist`);
    const uid = process.getuid?.() ?? 0;
    restart = ["launchctl", ["kickstart", "-k", `gui/${uid}/${BRAND.launchdLabel}`]];
    // `bootout` rather than a kill: KeepAlive would start a killed job again at once.
    stop = ["launchctl", ["bootout", `gui/${uid}/${BRAND.launchdLabel}`]];
    start = ["launchctl", ["bootstrap", `gui/${uid}`, file]];
  } else if (process.platform === "linux") {
    file = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", `${BRAND.slug}.service`);
    restart = ["systemctl", ["--user", "restart", BRAND.slug]];
    stop = ["systemctl", ["--user", "stop", BRAND.slug]];
    start = ["systemctl", ["--user", "start", BRAND.slug]];
  } else return null;
  try {
    const text = readFileSync(file, "utf8");
    if (!names(text)) return null;
    return { file, restart, stop, start, env: process.platform === "darwin" ? plistEnv(text) : unitEnv(text) };
  } catch { return null; }
}

/** The state dir the host of this install runs with: the service's own
 *  `STATE_DIR` when a service runs it (the service env is what the daemon sees),
 *  else what this process resolves (`env.ts`). */
function stateDirFor(dataDir: string): string {
  return serviceFor(dataDir)?.env[envName("STATE_DIR")] || STATE_DIR;
}

/** Where the snapshot taken when LEAVING `version` lives. */
const snapDirFor = (dataDir: string, version: string): string => join(dataDir, "state-snapshots", version);

const cmdline = (c: [string, string[]]): string => `${c[0]} ${c[1].join(" ")}`;

function restartOrSay(dataDir: string, noRestart: boolean): number {
  const svc = serviceFor(dataDir);
  if (!svc) {
    console.log(`No service runs this install — restart the host yourself (\`${BRAND.slug} start\`, or \`${BRAND.slug} service install\`).`);
    return 0;
  }
  if (noRestart) {
    console.log(`Not restarting (--no-restart). Restart with: ${svc.restart[0]} ${svc.restart[1].join(" ")}`);
    return 0;
  }
  try {
    execFileSync(svc.restart[0], svc.restart[1], { stdio: "inherit", timeout: 60_000 });
    console.log(`Restarted the service (${svc.restart[0]} ${svc.restart[1].join(" ")}).`);
    return 0;
  } catch (e) {
    console.error(`The new version is in place, but the restart failed: ${String((e as Error).message ?? e)}\nRun: ${svc.restart[0]} ${svc.restart[1].join(" ")}`);
    return 1;
  }
}

// ── commands ───────────────────────────────────────────────────────────────

function notSelfUpdating(mode: InstallMode): number {
  switch (mode.kind) {
    case "npm":
      console.log(`This is an npm global install. Update it with:\n  npm i -g ${BRAND.slug}@latest\nthen restart the host.`);
      break;
    case "checkout":
      console.log(`This is a source checkout (${mode.root}). Update it with:\n  git pull\n  npm run restart`);
      break;
    default:
      console.log(`Cannot tell how this copy was installed (${mode.root}): not under <data>/versions/<v>/, not an npm global, not a git checkout. Not updating.`);
  }
  return 3;
}

/** Say why release.json could not be used: a refused signature is named as one, never as "could not read". */
function sayLatestFailed(source: string, e: unknown, current: string): void {
  const msg = String((e as Error)?.message ?? e);
  if (e instanceof SignatureRefused) console.error(`release.json from ${source}: ${msg}. Nothing was installed; ${current} is untouched.`);
  else console.error(`Could not read the latest release from ${source}: ${msg}`);
}

async function check(mode: InstallMode, source: string, policy: SigPolicy): Promise<number> {
  const current = mode.kind === "tarball" ? mode.version : identity().version;
  let latest: ReleaseInfo;
  try { latest = await latestRelease(source, 10_000, policy); } catch (e) {
    sayLatestFailed(source, e, current);
    return 1;
  }
  const cmp = compareVersions(current, latest.version);
  if (cmp === null) { console.log(`${current} → ${latest.version} (cannot compare these versions)`); return 1; }
  if (cmp >= 0) { console.log(`${current} is current (latest ${latest.version}).`); return 0; }
  console.log(`${current} → ${latest.version} available.`);
  if (mode.kind === "tarball") console.log(`Run \`${BRAND.slug} update\` to install it.`);
  else notSelfUpdating(mode);
  return 10;
}

async function update(mode: Extract<InstallMode, { kind: "tarball" }>, source: string, noRestart: boolean, policy: SigPolicy): Promise<number> {
  const { dataDir } = mode;
  const versionsDir = join(dataDir, "versions");
  const current = currentVersion(dataDir) ?? mode.version;
  let latest: ReleaseInfo;
  try { latest = await latestRelease(source, 10_000, policy); } catch (e) {
    sayLatestFailed(source, e, current);
    return 1;
  }
  const cmp = compareVersions(current, latest.version);
  if (cmp === null) { console.error(`Cannot compare ${current} with ${latest.version}; not updating.`); return 1; }
  if (cmp >= 0) { console.log(`${current} is current (latest ${latest.version}). Nothing to do.`); return 0; }
  console.log(`Updating ${current} → ${latest.version}`);

  const release = takeLock(dataDir);
  if (typeof release === "string") { console.error(release); return 1; }
  try {
    const target = join(versionsDir, latest.version);
    if (existsSync(target) && readRelease(target)?.version === latest.version) {
      console.log(`  ${latest.version} is already unpacked (kept from an earlier update) — reusing it.`);
    } else {
      rmSync(target, { recursive: true, force: true });
      const file = `${BRAND.slug}-${latest.version}.tar.gz`;
      console.log(`  downloading ${file}…`);
      let tar: Buffer, shaText: Buffer;
      try {
        [tar, shaText] = await Promise.all([
          fetchBytes(source, file, 10 * 60_000),
          fetchSigned(source, `${file}.sha256`, 30_000, policy),
        ]);
      } catch (e) {
        if (!(e instanceof SignatureRefused)) throw e;
        console.error(`${String(e.message)}. Nothing was installed; ${current} is untouched.`);
        return 1;
      }
      if (policy.kind === "verify") console.log(`  verified the publisher's signature on ${file}.sha256`);
      const want = parseShaLines(shaText.toString("utf8")).get(file);
      if (!want) { console.error(`${file}.sha256 names no checksum for ${file} — refusing.`); return 1; }
      const got = sha256(tar);
      if (got !== want) { console.error(`Checksum mismatch for ${file} (expected ${want}, got ${got}) — refusing; nothing changed.`); return 1; }
      console.log("  checksum ok");
      extractInto(tar, versionsDir, latest.version, latest.version);
      const unpacked = readRelease(target);
      if (unpacked?.version !== latest.version || !existsSync(join(target, "bin", `${BRAND.slug}.mjs`))) {
        rmSync(target, { recursive: true, force: true });
        console.error(`The archive does not hold release ${latest.version} — refusing; nothing changed.`);
        return 1;
      }
    }

    // The runtime the wrapper uses must be the one this release was built for.
    const wantNode = readRelease(target)?.node ?? latest.node;
    const haveNode = runtimeVersion(dataDir);
    if (wantNode && wantNode !== haveNode) {
      try {
        const dir = await installNode(dataDir, wantNode);
        swapLink(join(dataDir, "runtime", "current"), dir);
        console.log(`  runtime → Node ${wantNode}${haveNode ? ` (was ${haveNode})` : ""}`);
      } catch (e) {
        console.error(`Could not install Node ${wantNode}: ${String((e as Error).message ?? e)} — not switching versions.`);
        return 1;
      }
    }

    // The state as `current` left it, BEFORE the swap — the newer host may
    // convert its stores on first boot, and a rollback puts these back
    // (`statesnap.ts`). No snapshot, no switch.
    const stateDir = stateDirFor(dataDir);
    try {
      const snap = snapshotState(stateDir, snapDirFor(dataDir, current), { from: current, to: latest.version });
      console.log(`  state snapshot: ${snap.files.length} store${snap.files.length === 1 ? "" : "s"} from ${stateDir} kept for a rollback`);
    } catch (e) {
      console.error(`Could not snapshot the host's state (${stateDir}): ${String((e as Error).message ?? e)} — not switching versions; ${current} is untouched.`);
      return 1;
    }

    swapLink(join(dataDir, "current"), join("versions", latest.version));
    console.log(`  current → ${latest.version} (previous ${current} kept; \`${BRAND.slug} update --rollback\` goes back, with its state)`);
    for (const v of selectPrune(installedVersions(dataDir), latest.version)) {
      rmSync(join(versionsDir, v), { recursive: true, force: true });
      rmSync(snapDirFor(dataDir, v), { recursive: true, force: true });
      console.log(`  removed ${v}`);
    }
    pruneRuntimes(dataDir);
  } finally {
    release();
  }
  return restartOrSay(dataDir, noRestart);
}

function rollback(mode: Extract<InstallMode, { kind: "tarball" }>, noRestart: boolean): number {
  const { dataDir } = mode;
  const current = currentVersion(dataDir) ?? mode.version;
  const to = rollbackTarget(installedVersions(dataDir), current);
  if (!to) { console.error(`No version older than ${current} is installed — nothing to roll back to.`); return 1; }
  const release = takeLock(dataDir);
  if (typeof release === "string") { console.error(release); return 1; }
  try {
    const wantNode = readRelease(join(dataDir, "versions", to))?.node;
    const name = wantNode ? nodeDistName(wantNode, process.platform, process.arch) : null;
    if (wantNode && wantNode !== runtimeVersion(dataDir)) {
      if (name && existsSync(join(dataDir, "runtime", name, "bin", "node"))) {
        swapLink(join(dataDir, "runtime", "current"), name);
        console.log(`  runtime → Node ${wantNode}`);
      } else {
        console.log(`  ${to} was built for Node ${wantNode}, which is not installed here; keeping the current runtime.`);
      }
    }
    const snapDir = snapDirFor(dataDir, to);
    const snap = readSnapshot(snapDir);
    const svc = serviceFor(dataDir);
    if (!snap) {
      swapLink(join(dataDir, "current"), join("versions", to));
      console.log(`Rolled back ${current} → ${to}. No state snapshot was taken when ${to} was left; the state is used as it is.`);
    } else if (!svc || noRestart) {
      // A running host flushes its stores on exit, over any restore made now —
      // so without a service to stop, the restore is the person's step.
      swapLink(join(dataDir, "current"), join("versions", to));
      console.log(`Rolled back ${current} → ${to}. Its state from before the update is NOT restored yet: ` +
        `stop the host, then run \`${BRAND.slug} update --restore-state\`.`);
    } else {
      try { execFileSync(svc.stop[0], svc.stop[1], { stdio: "inherit", timeout: 60_000 }); } catch (e) {
        swapLink(join(dataDir, "current"), join("versions", to));
        console.error(`Rolled back ${current} → ${to}, but could not stop the service (${String((e as Error).message ?? e)}), so its state was NOT restored. ` +
          `Stop it, run \`${BRAND.slug} update --restore-state\`, then start it.`);
        return restartOrSay(dataDir, noRestart);
      }
      swapLink(join(dataDir, "current"), join("versions", to));
      sayRestore(stateDirFor(dataDir), snapDir, to);
      try {
        execFileSync(svc.start[0], svc.start[1], { stdio: "inherit", timeout: 60_000 });
        console.log(`Rolled back ${current} → ${to} and started the service (${cmdline(svc.start)}).`);
        return 0;
      } catch (e) {
        console.error(`Rolled back ${current} → ${to}, but the service did not start: ${String((e as Error).message ?? e)}\nRun: ${cmdline(svc.start)}`);
        return 1;
      }
    }
  } finally {
    release();
  }
  return restartOrSay(dataDir, noRestart);
}

/** Restore `snapDir` into `stateDir` and say what happened. Never throws. */
function sayRestore(stateDir: string, snapDir: string, version: string): boolean {
  try {
    const r = restoreState(stateDir, snapDir);
    console.log(`  restored ${r.restored.length} store${r.restored.length === 1 ? "" : "s"} from before the update to ${stateDir}` +
      (r.keptIn ? `; the newer state is kept in ${r.keptIn}` : ""));
    return true;
  } catch (e) {
    console.error(`  could not restore ${version}'s state from ${snapDir}: ${String((e as Error).message ?? e)}. The state is used as it is.`);
    return false;
  }
}

/** `--restore-state`: put back the snapshot taken when the version `current` points at was left. The host must be stopped. */
function restoreCurrent(mode: Extract<InstallMode, { kind: "tarball" }>): number {
  const { dataDir } = mode;
  const version = currentVersion(dataDir) ?? mode.version;
  const snapDir = snapDirFor(dataDir, version);
  if (!readSnapshot(snapDir)) { console.error(`No state snapshot for ${version} (${snapDir}) — nothing to restore.`); return 1; }
  const release = takeLock(dataDir);
  if (typeof release === "string") { console.error(release); return 1; }
  try {
    return sayRestore(stateDirFor(dataDir), snapDir, version) ? 0 : 1;
  } finally {
    release();
  }
}

const USAGE = `usage: ${BRAND.slug} update [--check | --rollback | --restore-state] [--from <dir-or-url>] [--no-restart]

  (no flag)     download, verify (checksum + publisher signature) and switch to the latest release
  --check       print current → latest; exit 0 when current, 10 when an update is available
  --rollback    switch back to the previous installed version, and the state it had before the update
  --restore-state
                with the host stopped, put back the state snapshot of the version now current
  --from        read the release from this directory or URL (default ${envName("RELEASE_URL")}, else GitHub)
  --no-restart  switch versions but leave the running service alone
`;

export async function run(args: string[]): Promise<number> {
  let from: string | null = null, wantCheck = false, wantRollback = false, wantRestore = false, noRestart = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--check") wantCheck = true;
    else if (a === "--rollback") wantRollback = true;
    else if (a === "--restore-state") wantRestore = true;
    else if (a === "--no-restart") noRestart = true;
    else if (a === "--from" && args[i + 1]) from = args[++i]!;
    else if (a.startsWith("--from=")) from = a.slice("--from=".length);
    else if (a === "--help" || a === "-h") { console.log(USAGE); return 0; }
    else { console.error(`${BRAND.slug} update: unknown argument "${a}"\n\n${USAGE}`); return 2; }
  }
  if (Number(wantCheck) + Number(wantRollback) + Number(wantRestore) > 1) { console.error(USAGE); return 2; }
  if (from && !/^(https?|file):/.test(from)) from = resolve(from);
  const source = releaseSource(from);
  const mode = currentMode();
  const needsRelease = wantCheck || (mode.kind === "tarball" && !wantRollback && !wantRestore);
  let policy: SigPolicy;
  try { policy = currentSigPolicy(); } catch (e) {
    console.error(`The embedded release key is unreadable (${String((e as Error).message ?? e)}) — refusing; nothing changed.`);
    return 1;
  }
  if (needsRelease && policy.kind === "skip") console.error(SKIP_SIG_WARNING);
  if (wantCheck) return check(mode, source, policy);
  if (mode.kind !== "tarball") return notSelfUpdating(mode);
  if (wantRestore) return restoreCurrent(mode);
  return wantRollback ? rollback(mode, noRestart) : update(mode, source, noRestart, policy);
}
