/**
 * Building `wp-desktop` and keeping it (helper/PROTOCOL.md, "Build and placement").
 *
 * The binary lives at `<state dir>/bin/wp-desktop`, a stable path, because TCC lists a bare binary
 * by its path and judges it by its code signature. An ad-hoc signature IS the cdhash, so every
 * rebuild makes macOS forget the Screen Recording and Accessibility grants: rebuild only when
 * `build.sh --hash` differs from the `.srchash` the last build left beside the binary, and say so
 * — in the log and in the setup row — whenever a rebuild replaced a binary that had existed.
 *
 * Nothing builds at import or at activate. The first `ensure()` (a probe or an open) builds; one
 * build at a time, every caller awaits the same one. A failed build is not retried for a minute,
 * so a phone asking every few seconds cannot keep a compiler busy.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "@waterplane/shared";
import { HELPER, NO_SOURCE, NO_TOOLCHAIN, NO_TOOLCHAIN_WIN, type DesktopOs } from "./knobs.mjs";

export type HelperKind = "unknown" | "missing" | "stale" | "current" | "building" | "failed" | "no-toolchain" | "no-source" | "prebuilt";

export interface HelperState {
  kind: HelperKind;
  path: string;
  /** The source's hash now, when known. */
  hash?: string;
  /** When a rebuild replaced an existing binary in this process (its grants are gone). */
  rebuiltAt?: number;
  /** The sentence for `failed` / `no-toolchain` / `no-source`. */
  reason?: string;
}

export type HelperReady = { ok: true; path: string } | { ok: false; reason: string; building?: boolean };

export interface RunResult { code: number | null; stdout: string; stderr: string; error?: string }
export type Runner = (file: string, args: string[], timeoutMs: number, env?: Record<string, string>) => Promise<RunResult>;

/**
 * What build.sh cannot import, so it is handed it: the code-signing identifier (macOS keys the
 * Screen Recording / Accessibility grant on it, so it must be the same on every build) and the name
 * System Settings shows. Both derive from the brand table: the app id's reverse-DNS prefix plus the
 * helper's own name. Part of the source hash, for `--hash` and for a build alike.
 */
export function helperIdentity(): Record<string, string> {
  return {
    WP_DESKTOP_ID: `${BRAND.appId.replace(/\.[^.]+$/, "")}.wp-desktop`,
    WP_DESKTOP_NAME: `${BRAND.displayName} desktop helper`,
  };
}

export const runFile: Runner = (file, args, timeoutMs, env) => new Promise((resolve) => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
    const code = !e ? 0 : typeof e.code === "number" ? e.code : null;
    resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), ...(e && code === null ? { error: e.message } : {}) });
  });
});

const HASH_TTL_MS = 10_000;
const RETRY_AFTER_MS = 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;

export interface HelperBinOpts {
  stateDir: string;
  /** `packages/extensions/desktop/helper`, or null when this install has none. */
  sourceDir: string | null;
  /** A binary to run as it is (`WATERPLANE_DESKTOP_HELPER`); nothing is built then. */
  prebuilt?: string | null;
  log(msg: string): void;
  /** Which helper: the Swift one (default) or the Windows one (`helper-win/`, `wp-desktop.exe`). */
  os?: DesktopOs;
  run?: Runner;
  now?(): number;
}

export class HelperBin {
  readonly path: string;
  private st: HelperState;
  private hashAt = 0;
  private building: Promise<HelperReady> | null = null;
  private failedAt = 0;
  private readonly run: Runner;
  private readonly now: () => number;

  /** Windows keys no grant on the binary, so a rebuild there forgets nothing. */
  private readonly grants: boolean;
  private readonly noToolchain: string;

  constructor(private readonly o: HelperBinOpts) {
    const os = o.os ?? "mac";
    this.grants = os === "mac";
    this.noToolchain = os === "windows" ? NO_TOOLCHAIN_WIN : NO_TOOLCHAIN;
    this.path = o.prebuilt || join(o.stateDir, "bin", HELPER[os].bin);
    this.run = o.run ?? runFile;
    this.now = o.now ?? Date.now;
    this.st = { kind: o.prebuilt ? "prebuilt" : o.sourceDir ? "unknown" : "no-source", path: this.path, ...(o.sourceDir || o.prebuilt ? {} : { reason: NO_SOURCE }) };
  }

  /** What is known right now, without running anything. */
  state(): HelperState { return { ...this.st }; }

  /** Compare the source's hash with the installed binary's. Runs `build.sh --hash`; builds nothing. */
  async check(): Promise<HelperState> {
    if (this.o.prebuilt || !this.o.sourceDir || this.building) return this.state();
    if (this.st.kind === "failed" || this.st.kind === "no-toolchain") {
      if (this.now() - this.failedAt < RETRY_AFTER_MS) return this.state();
    }
    if (this.st.hash && this.now() - this.hashAt < HASH_TTL_MS && (this.st.kind === "current" || this.st.kind === "stale" || this.st.kind === "missing")) return this.state();
    const r = await this.run("/bin/bash", [join(this.o.sourceDir, "build.sh"), "--hash"], 15_000, helperIdentity());
    const hash = r.code === 0 ? r.stdout.trim() : "";
    if (!hash) {
      this.fail("failed", `wp-desktop's source hash could not be read: ${lastLine(r.stderr) || r.error || `exit ${r.code}`}`);
      return this.state();
    }
    this.hashAt = this.now();
    const built = readText(this.path + ".srchash");
    const kind: HelperKind = !existsSync(this.path) ? "missing" : built === hash ? "current" : "stale";
    this.st = { kind, path: this.path, hash, ...(this.st.rebuiltAt ? { rebuiltAt: this.st.rebuiltAt } : {}) };
    return this.state();
  }

  /** A runnable binary: the current one, else a build (awaited by every caller). */
  async ensure(): Promise<HelperReady> {
    if (this.o.prebuilt) {
      try { accessSync(this.o.prebuilt, constants.X_OK); return { ok: true, path: this.path }; }
      catch { return { ok: false, reason: `The desktop helper ${this.o.prebuilt} (${BRAND.envPrefix}DESKTOP_HELPER) is not an executable file.` }; }
    }
    if (this.building) return this.building;
    const st = await this.check();
    if (st.kind === "current") return { ok: true, path: this.path };
    if (st.kind === "no-source" || st.kind === "no-toolchain" || st.kind === "failed") return { ok: false, reason: st.reason ?? this.noToolchain };
    if (this.building) return this.building; // another caller started it while we hashed
    return this.build();
  }

  /** Build now (first build or a changed source). One at a time. */
  build(): Promise<HelperReady> {
    if (this.building) return this.building;
    if (!this.o.sourceDir) return Promise.resolve({ ok: false, reason: NO_SOURCE });
    const replacing = existsSync(this.path);
    this.o.log(replacing
      ? this.grants ? "rebuilding wp-desktop: its source changed. macOS ties Screen Recording and Accessibility to the exact binary, so both must be granted again afterwards" : "rebuilding wp-desktop: its source changed"
      : `building wp-desktop into ${this.path} (about a minute)`);
    const prev = this.st;
    this.st = { kind: "building", path: this.path, ...(prev.hash ? { hash: prev.hash } : {}), ...(prev.rebuiltAt ? { rebuiltAt: prev.rebuiltAt } : {}) };
    const t0 = this.now();
    this.building = this.run("/bin/bash", [join(this.o.sourceDir, "build.sh"), this.path], BUILD_TIMEOUT_MS, helperIdentity()).then((r): HelperReady => {
      if (r.code === 3) { this.fail("no-toolchain", this.noToolchain); return { ok: false, reason: this.noToolchain }; }
      if (r.code !== 0 || !existsSync(this.path)) {
        const why = `Building wp-desktop failed: ${lastLine(r.stderr) || r.error || `exit ${r.code}`}`;
        this.fail("failed", why);
        return { ok: false, reason: why };
      }
      const hash = readText(this.path + ".srchash") || prev.hash;
      this.hashAt = this.now();
      const lostGrants = replacing && this.grants;
      this.st = { kind: "current", path: this.path, ...(hash ? { hash } : {}), ...(lostGrants ? { rebuiltAt: this.now() } : prev.rebuiltAt ? { rebuiltAt: prev.rebuiltAt } : {}) };
      this.o.log(`built wp-desktop ${hash ?? ""} in ${((this.now() - t0) / 1000).toFixed(1)} s${lostGrants ? "; grant Screen Recording and Accessibility to it again" : ""}`);
      return { ok: true, path: this.path };
    }).finally(() => { this.building = null; });
    return this.building;
  }

  get isBuilding(): boolean { return this.building !== null; }

  private fail(kind: "failed" | "no-toolchain", reason: string): void {
    this.failedAt = this.now();
    this.st = { kind, path: this.path, reason, ...(this.st.hash ? { hash: this.st.hash } : {}) };
    this.o.log(reason);
  }
}

function readText(p: string): string | undefined {
  try { return readFileSync(p, "utf8").trim() || undefined; } catch { return undefined; }
}

function lastLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").slice(0, 300);
}
