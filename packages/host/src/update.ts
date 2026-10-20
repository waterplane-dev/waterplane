/**
 * Tracks whether the `claude` binary has a newer release available, and applies
 * it on demand — **whatever installed it**.
 *
 * ## Why the install route is read, never configured
 *
 * This module used to be Homebrew-only: it asked `brew outdated --cask` and its
 * one button ran `brew upgrade --cask`. That is correct on exactly one kind of
 * desktop, and it fails in the most confusing way possible on the others — the
 * CLI's own nag stays on screen while the button reports success, because the
 * package manager being asked does not own the binary on the PATH.
 *
 * So `route` is READ off the resolved binary (`routeFromPath`), on every poll:
 *   - `brew`   — resolves inside a Homebrew `Caskroom`
 *   - `npm`    — resolves inside `node_modules/@anthropic-ai/claude-code`
 *   - `native` — the standalone installer's `~/.local/…` / `~/.claude/local/…`
 *   - `unknown` — anything else, and the button REFUSES in a sentence rather
 *     than running a manager's upgrade against a binary it does not manage.
 *
 * A route swap (uninstall the cask, `npm i -g …`) therefore needs no setting
 * changed and no restart: the next poll resolves the new path and the button
 * relabels itself.
 *
 * ## Two independent signals feed `available`
 *
 *   1. The route's own index — `brew outdated --cask claude-code`, or
 *      `npm view @anthropic-ai/claude-code version` compared against what is
 *      installed. Authoritative when the index is current. The native installer
 *      has no index of its own; it asks npm too (same releases, at the dist-tag
 *      of claude's `autoUpdatesChannel`), and only when npm is there to ask.
 *   2. The CLI's own "Update available! Run: …" banner, scraped from PTY output
 *      (`noteBanner`). The CLI checks npm. On a Homebrew desktop that fires the
 *      moment npm is ahead **while the cask still lags** (measured: cask at
 *      2.1.273 against npm 2.1.281), so the in-app button appears in lockstep
 *      with the on-screen nag even though brew has nothing to offer.
 *
 * `available = indexOutdated || bannerActive`. The banner self-clears once the
 * installed version changes (upgraded by ANY route), and — on the npm and
 * native routes only — once the installed version equals what the registry offers, because
 * there the index and the CLI's own reference are the same registry. On the
 * brew route they are not, which is exactly the lag above, so a cask that says
 * "current" may never silence an npm-sourced nag.
 *
 * ## Applying
 *
 * `applyPlan` is the one place a route becomes commands. When an upgrade runs
 * clean but the version does not move, we say WHY in that route's terms rather
 * than reporting a hollow success — on brew, that the cask lags npm and what to
 * do about it. Live PTY sessions keep their already-loaded binary (the kernel
 * holds the inode); only newly-spawned sessions pick up the new version, so
 * upgrading — and even swapping routes — is safe while sessions are running.
 */
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstallRoute, UpdateInfo } from "@waterplane/shared";
import { cmpCliVersion, envName } from "@waterplane/shared";
import { claudeBackend } from "./backends/index.js";
import { claudeConfigDir } from "./claudeconfig.js";

const CASK = "claude-code";
const PKG = "@anthropic-ai/claude-code";
const POLL_MS = 60 * 60 * 1000;
/** How often the binary on disk is stat'ed for a change. A stat is free; what
 *  it catches is the CLI updating ITSELF (its own auto-updater), which the
 *  hourly poll would report up to an hour late — and every live session's
 *  "restart onto the new version" offer hangs off `current`. */
const BIN_WATCH_MS = 60 * 1000;
const BREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ENV_HINTS: "1" };

/**
 * Matches the CLI's update nag in stripped PTY output, anchored on the
 * actionable "Run: brew upgrade / npm i -g" tail so ordinary prose containing
 * the words "update available" doesn't false-positive. Captures an optional
 * version if the banner ever carries one.
 */
const BANNER_RE = /update available!?[^\n]*?run:\s*(?:brew upgrade|npm i(?:nstall)? -g)[^\n]*?(?:claude-code|@anthropic-ai\/claude-code)(?:[^\n]*?v?(\d+\.\d+\.\d+))?/i;

/** Detect the CLI's "Update available!" banner. Pass ANSI-stripped text. */
export function detectUpdateBanner(text: string): { available: boolean; latest?: string } {
  const m = BANNER_RE.exec(text);
  if (!m) return { available: false };
  return { available: true, latest: m[1] || undefined };
}

/**
 * Which package manager owns the binary at this REALPATH-resolved path.
 *
 * Pure, and deliberately path-shaped rather than "ask each manager whether it
 * has claude-code": both can answer yes at once (a leftover cask beside an npm
 * global), and only one of them is on the PATH the host actually spawns.
 */
export function routeFromPath(p: string | undefined): InstallRoute {
  if (!p) return "unknown";
  if (p.includes("/Caskroom/")) return "brew";
  if (p.includes("/node_modules/@anthropic-ai/claude-code")) return "npm";
  if (/\/\.claude\/local\//.test(p) || /\/\.local\/(bin|share)\//.test(p)) return "native";
  return "unknown";
}

/** `a` vs `b` as dotted numbers — the one comparison lives in shared, beside
 *  the per-session restart rule that must agree with it. */
export const cmpVersion = cmpCliVersion;

/**
 * The npm dist-tag a native install follows: claude's own `autoUpdatesChannel`
 * setting ("latest" by default, or "stable"). Both are npm dist-tags, and asking
 * `latest` for a stable-channel install would show an update `claude update`
 * never takes — a nag nothing can clear. An unreadable or unknown value is "latest".
 */
export function nativeChannel(settingsJson: string | undefined): "latest" | "stable" {
  try {
    return JSON.parse(settingsJson ?? "{}")?.autoUpdatesChannel === "stable" ? "stable" : "latest";
  } catch {
    return "latest";
  }
}

export interface ApplyStep { cmd: string; args: string[]; env?: Record<string, string> }
export interface ApplyPlan { label: string; steps: ApplyStep[] }

/**
 * The upgrade this route would run. `label` is what the phone prints on the
 * button, so the UI never re-derives which manager owns the binary — kept to
 * a button's worth of words, because the exact command line is echoed into the
 * log above it (`==> npm install -g …`) the moment it runs.
 *
 * `unknown` returns null: no command is better than someone else's command.
 */
export function applyPlan(route: InstallRoute, bin: string): ApplyPlan | null {
  switch (route) {
    case "brew":
      return {
        label: "brew upgrade",
        // `brew update` first so the local cask index reflects upstream — without
        // it, `brew upgrade` no-ops when our cached version is stale even though
        // a newer release exists.
        steps: [
          { cmd: "brew", args: ["update"] },
          { cmd: "brew", args: ["upgrade", "--cask", CASK], env: BREW_ENV },
        ],
      };
    case "npm":
      return {
        label: "npm update",
        steps: [{ cmd: "npm", args: ["install", "-g", `${PKG}@latest`] }],
      };
    case "native":
      return { label: "claude update", steps: [{ cmd: bin, args: ["update"] }] };
    default:
      return null;
  }
}

export class UpdateChecker {
  private info: UpdateInfo = { available: false, running: false };
  private timer: NodeJS.Timeout | null = null;
  /** While a CLI banner is live, re-read the installed version on a short cadence
   *  so the button disappears promptly after an upgrade (by ANY route), instead
   *  of waiting for the hourly poll. */
  private reconcileTimer: NodeJS.Timeout | null = null;
  private applying = false;
  /** True when the route's own index reports the install is behind. */
  private indexOutdated = false;
  /** Set when the CLI banner is seen; cleared once the install version moves. */
  private banner: { latest?: string; atVersion?: string } | null = null;
  private route: InstallRoute = "unknown";
  private binTimer: NodeJS.Timeout | null = null;
  /** mtime+inode of `info.binPath` when last looked at; a change re-reads the version. */
  private binKey: string | null = null;

  constructor(private onChange: (info: UpdateInfo) => void) {}

  get(): UpdateInfo { return this.info; }

  start(): void {
    if (this.timer) return;
    // Refresh the local cask index first: `brew outdated` compares against the
    // cached formula, which lags upstream until `brew update` runs. Background-
    // only, so the hourly `brew update` cost is invisible.
    void this.check(true);
    this.timer = setInterval(() => void this.check(true), POLL_MS);
    this.binTimer = setInterval(() => this.watchBinary(), BIN_WATCH_MS);
  }

  /**
   * Re-read the installed version when the binary on disk changes. npm and the
   * native installer replace the file (new inode, new mtime) at the same
   * realpath; a route swap moves the realpath, which `check` re-resolves.
   */
  private watchBinary(): void {
    const p = this.info.binPath;
    if (!p || this.applying) return;
    let key: string;
    try { const st = statSync(p); key = `${st.ino}:${st.mtimeMs}`; } catch { key = "gone"; }
    const prev = this.binKey;
    this.binKey = key;
    if (prev != null && prev !== key) void this.check(false);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.binTimer) clearInterval(this.binTimer);
    this.binTimer = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /**
   * Record the CLI's on-screen update nag (scraped from a session's PTY output).
   * Surfaces the button immediately even when the route's index still lags the
   * registry the CLI checks.
   */
  noteBanner(latest?: string): void {
    const cur = this.info.current;
    // Ignore a banner that names a version we already run (stale scrollback).
    if (latest && cur && latest === cur) return;
    const prev = this.banner;
    if (prev && prev.latest === latest && prev.atVersion === cur) return; // unchanged
    this.banner = { latest, atVersion: cur };
    this.recompute();
    this.armReconcile();
    // Verify against the live binary right away, in case the user already
    // upgraded (the nag lingers in scrollback long after it's resolved).
    void this.reconcileBanner();
  }

  /** Poll the installed version while a banner is live, so it clears promptly. */
  private armReconcile(): void {
    if (this.reconcileTimer || !this.banner) return;
    this.reconcileTimer = setInterval(() => void this.reconcileBanner(), 20_000);
  }

  private async reconcileBanner(): Promise<void> {
    if (!this.banner) {
      if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
      return;
    }
    const cur = await this.installedVersion();
    if (!cur) return;
    this.info = { ...this.info, current: cur };
    if (this.banner.atVersion == null) this.banner.atVersion = cur;
    // Upgraded (version moved) OR confirmed at the version the nag wanted → resolved.
    else if (cur !== this.banner.atVersion || (this.banner.latest && cur === this.banner.latest)) {
      this.clearBanner();
    }
    this.recompute();
  }

  private clearBanner(): void {
    this.banner = null;
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
  }

  /**
   * Resolve the binary the host actually spawns, and read the install route off
   * it. `which` for a bare name, the path itself when one was configured, then
   * realpath — the route lives at the far end of the symlink, never at the near
   * end (`/opt/homebrew/bin/claude` is the SAME path under both brew and npm).
   */
  private async detectRoute(): Promise<void> {
    const bin = claudeBackend.bin();
    let resolved: string | undefined;
    try {
      const out = await run("/usr/bin/which", [bin], {});
      resolved = (out.stdout || "").trim().split("\n")[0] || undefined;
    } catch { /* fall through */ }
    if (!resolved && bin.includes("/")) resolved = bin;
    let real = resolved;
    if (resolved) { try { real = realpathSync(resolved); } catch { /* keep the unresolved path */ } }
    this.route = routeFromPath(real);
    this.info = { ...this.info, route: this.route, binPath: real, applyLabel: applyPlan(this.route, bin)?.label };
  }

  async check(refresh = false): Promise<void> {
    try {
      await this.detectRoute();
      const installed = await this.installedVersion();
      let latest: string | undefined;
      if (this.route === "brew") {
        if (refresh) await run("brew", ["update"], {}).catch(() => undefined);
        const out = await run("brew", ["outdated", "--cask", CASK, "--greedy", "--json=v2"], BREW_ENV);
        let cask: any = null;
        try {
          const data = JSON.parse(out.stdout || "{}");
          cask = (data.casks || []).find((c: any) => c.name === CASK);
        } catch { /* brew sometimes prints text before JSON — fall through */ }
        this.indexOutdated = !!cask;
        latest = cask?.current_version;
        if (!installed && cask?.installed_versions?.[0]) {
          this.info = { ...this.info, current: cask.installed_versions[0] };
        }
      } else if (this.route === "npm") {
        // The registry the CLI's own nag checks, asked directly — no local index
        // to go stale, so there is nothing to refresh first.
        const out = await run("npm", ["view", PKG, "version"], {});
        latest = /(\d+\.\d+\.\d+)/.exec(out.stdout || "")?.[1];
        this.indexOutdated = cmpVersion(latest, installed) > 0;
      } else if (this.route === "native") {
        // The native installer ships the same releases the npm registry lists, so
        // the registry is this route's index too — when this machine has npm to ask
        // it. Without npm (or offline) it degrades to the CLI's banner alone: absent,
        // never an error, because npm was never this route's to need.
        let settings: string | undefined;
        try { settings = readFileSync(join(claudeConfigDir(), "settings.json"), "utf8"); } catch { /* no settings: default channel */ }
        const out = await run("npm", ["view", `${PKG}@${nativeChannel(settings)}`, "version"], {}).catch(() => undefined);
        latest = /(\d+\.\d+\.\d+)/.exec(out?.stdout || "")?.[1];
        this.indexOutdated = cmpVersion(latest, installed) > 0;
      } else {
        // No index we may ask on this route's behalf. The CLI's own banner is
        // the only signal, and absent it we say nothing rather than guess.
        this.indexOutdated = false;
      }
      this.info = {
        ...this.info,
        current: installed ?? this.info.current,
        latest: latest ?? this.banner?.latest ?? this.info.latest,
        lastChecked: Date.now(),
        lastError: undefined,
      };
      if (this.banner) {
        // The banner self-clears once the install version has moved past where it
        // was when we first saw the nag (upgraded by any route: brew, npm, native).
        if (this.banner.atVersion == null) this.banner.atVersion = this.info.current;
        else if (this.info.current && this.info.current !== this.banner.atVersion) this.clearBanner();
        // On npm (and native, which reads npm), the index and the CLI's own reference are the SAME registry, so
        // "installed === latest" really does resolve the nag. On brew they are two
        // different indexes — that gap IS the lag — so a current cask may never
        // silence an npm-sourced banner.
        else if ((this.route === "npm" || this.route === "native") && latest && this.info.current === latest) this.clearBanner();
      }
      this.recompute();
    } catch (err) {
      this.info = { ...this.info, lastChecked: Date.now(), lastError: String(err) };
      this.onChange(this.info);
    }
  }

  /** Fold the index + banner signals into `info.available` and broadcast. */
  private recompute(): void {
    this.info = {
      ...this.info,
      available: this.indexOutdated || !!this.banner,
      source: this.indexOutdated ? (this.route === "brew" ? "brew" : "npm") : this.banner ? "cli" : undefined,
    };
    this.onChange(this.info);
  }

  async apply(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    const log: string[] = [];
    const MAX_LINES = 200;
    let buf = "";
    const pushChunk = (s: string) => {
      buf += s;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || "";
      for (const ln of parts) {
        log.push(ln);
        if (log.length > MAX_LINES) log.shift();
      }
      this.info = { ...this.info, log: [...log] };
      this.onChange(this.info);
    };
    try {
      await this.detectRoute();
      const plan = applyPlan(this.route, claudeBackend.bin());
      if (!plan) {
        // Nothing here owns the binary. Say where it is and stop — running some
        // other manager's upgrade would report ITS complaint as the CLI's.
        const where = this.info.binPath ? ` (${this.info.binPath})` : "";
        this.info = {
          ...this.info,
          running: false,
          lastResult: {
            ok: false,
            at: Date.now(),
            message: `can't tell what installed this claude${where} — upgrade it the way you installed it, or set ${envName("CLAUDE_BIN")} to one this desktop manages`,
          },
        };
        this.onChange(this.info);
        return;
      }
      const before = await this.installedVersion();
      this.info = { ...this.info, running: true, lastError: undefined, lastResult: undefined, log: [] };
      this.onChange(this.info);
      let last = { code: 0, stdout: "", stderr: "" };
      for (const step of plan.steps) {
        pushChunk(`==> ${step.cmd} ${step.args.join(" ")}\n`);
        last = await runStream(step.cmd, step.args, step.env ?? {}, pushChunk);
        if (last.code !== 0) break;
      }
      if (buf) { log.push(buf); buf = ""; }
      const after = await this.installedVersion();
      const ranOk = last.code === 0;
      const changed = !!after && after !== before;
      const tail = (s: string) => s.split("\n").slice(-8).join("\n").trim();
      let ok: boolean;
      let message: string;
      if (changed) {
        ok = true;
        message = `updated to ${after}`;
      } else if (ranOk && this.banner && this.route === "brew") {
        // Upgrade succeeded but nothing moved: the cask is behind the npm release
        // the CLI is nagging about. Say so instead of a hollow "success".
        ok = false;
        message = `Homebrew cask still at ${before ?? "current"}${this.banner.latest ? ` (CLI wants ${this.banner.latest})` : ""} — it lags npm. Try again later, or switch this desktop to npm: \`brew uninstall --cask ${CASK} && npm i -g ${PKG}\`.`;
      } else if (ranOk && this.banner) {
        ok = false;
        message = `${plan.label} ran clean but ${before ?? "the version"} did not move${this.banner.latest ? ` (the CLI wants ${this.banner.latest})` : ""}.`;
      } else if (ranOk) {
        ok = true;
        message = tail(last.stdout || `already up to date (${after ?? before ?? "unknown"})`);
      } else {
        ok = false;
        message = tail(last.stderr || last.stdout || `${plan.label} failed`);
      }
      this.info = { ...this.info, running: false, log, lastResult: { ok, message, at: Date.now() } };
      this.onChange(this.info);
      await this.check();
    } catch (err) {
      this.info = {
        ...this.info,
        running: false,
        log,
        lastResult: { ok: false, message: String(err), at: Date.now() },
      };
      this.onChange(this.info);
    } finally {
      this.applying = false;
    }
  }

  /**
   * The version actually running — `claude --version`. Authoritative regardless
   * of install route (brew cask, npm global, native installer), so the banner
   * clears after an upgrade even when one manager's listing is blind to it.
   * Falls back to the brew cask version only when the binary can't be queried
   * at all, which is the one case where a stale number beats no number.
   */
  private async installedVersion(): Promise<string | undefined> {
    const bin = claudeBackend.bin();
    try {
      const out = await run(bin, ["--version"], {});
      const m = /(\d+\.\d+\.\d+)/.exec(out.stdout || "");
      if (m) return m[1];
    } catch { /* fall through to brew */ }
    try {
      const out = await run("brew", ["list", "--cask", "--versions", CASK], BREW_ENV);
      const parts = (out.stdout || "").trim().split(/\s+/).slice(1);
      return parts.length ? parts[parts.length - 1] : undefined;
    } catch { return undefined; }
  }
}

function run(cmd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...extraEnv } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function runStream(cmd: string, args: string[], extraEnv: Record<string, string>, onChunk: (s: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...extraEnv } });
    let stdout = "", stderr = "";
    const handle = (b: Buffer, sink: "out" | "err") => {
      const s = b.toString("utf8");
      if (sink === "out") stdout += s; else stderr += s;
      onChunk(s);
    };
    child.stdout.on("data", (b: Buffer) => handle(b, "out"));
    child.stderr.on("data", (b: Buffer) => handle(b, "err"));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}
