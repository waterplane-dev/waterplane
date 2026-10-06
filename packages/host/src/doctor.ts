/**
 * Preflight checks — the "why isn't this working" answer, in one place.
 *
 * Nearly every first-run failure here is silent: `claude` isn't logged in so
 * sessions spawn a PTY that immediately dies; there's no Tailscale IP so the
 * host binds loopback and the phone can never reach it; the page is served over
 * plain HTTP so Web Push and the clipboard quietly no-op. None of those surface
 * as an error — you just get an app that half works. So we check them up front
 * and say, in one line each, what is wrong and what to type to fix it.
 *
 * Runs on boot (warnings only, never fatal — a degraded host is still useful)
 * and standalone via `npm run doctor`.
 */
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tailscaleBin, serveHttpsUrl, lanIps } from "./net.js";
import { probeCaptureBackends } from "./capture.js";
import { dictateStatusLive } from "./dictate.js";
import { builtinDoctorChecks } from "./plugins/builtin.js";
import { ptyMax, ptyOpen } from "./ptycap.js";
import { lanIdentityPresent } from "./lanid.js";
import { env } from "./env.js";
import { logTag, BRAND, envName, claudeNewerThanTested, claudeConfigDirFromEnv, NODE_MIN, nodeMeetsMin } from "@waterplane/shared";
import { homedir, release } from "node:os";
import { wslChecks } from "./doctorwsl.js";
import { probeAndroidEnv, type AndroidEnvReport } from "./androidenv.js";
import { compareVersions, currentMode, currentSigPolicy, latestRelease, releaseSource, SignatureRefused } from "./cli/selfupdate.js";
import { hostStateDir, resolveStateDir, stateDirReport } from "./branddirs.js";
import { installedServiceEnv } from "./cli/service.js";
import { onPath, tmuxChecks, tmuxInstallCommand } from "./tmuxreq.js";
import { overlaysCheck } from "./themeoverlay.js";
import { execFileP } from "./proc.js";


export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  /** Short stable name, e.g. `claude-login`. */
  id: string;
  status: CheckStatus;
  /** One line: what we found. */
  detail: string;
  /** One line: what to do about it. Omitted when `ok`. */
  fix?: string;
}

export interface DoctorInput {
  root: string;
  /** True when nobody named the root and the `~/dev` default was assumed (`env.ts`' `ROOT_DEFAULTED`). */
  rootDefaulted?: boolean;
  port: number;
  claudeBin: string;
  /**
   * The backend ids this host's recent sessions ran on — handed to every in-repo
   * extension's `doctor()` (`plugins/builtin.ts`), which checks a second backend
   * only where it is wanted.
   *
   * Deliberately not "always check the second backend". Most people here drive
   * `claude` and nothing else, and a report that tells them a binary they have
   * never asked for is missing is a line that says "something is wrong" about
   * nothing — on the one report in this app whose value rests entirely on every
   * line of it being actionable.
   */
  usedBackends?: readonly string[];
  tailscaleIp: string | null;
  tailscaleDns: string | null;
  allowPublic: boolean;
}

/** Run `cmd args…` with a short leash; never throws. */
async function run(cmd: string, args: string[], timeout = 8000): Promise<{ out: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout, encoding: "utf8" });
    return { out: `${stdout}${stderr}`.trim(), ok: true };
  } catch (err: any) {
    return { out: String(err?.stdout ?? "" ) + String(err?.stderr ?? err?.message ?? err), ok: false };
  }
}

async function which(bin: string): Promise<string | null> {
  // An absolute/relative path (WATERPLANE_CLAUDE_BIN often is one) isn't on PATH.
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  const { out, ok } = await run("/bin/sh", ["-c", `command -v ${JSON.stringify(bin)}`]);
  return ok && out ? out.split("\n")[0].trim() : null;
}

function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

async function checkNode(): Promise<Check> {
  if (nodeMeetsMin(process.versions.node)) return { id: "node", status: "ok", detail: `node ${process.versions.node}` };
  return {
    id: "node",
    status: "fail",
    detail: `node ${process.versions.node} is too old (needs ${NODE_MIN} or newer)`,
    fix: `Install Node ${NODE_MIN} or newer — the host reads \`import.meta.dirname\` and uses modern ESM.`,
  };
}

async function checkPty(): Promise<Check> {
  // node-pty is a native module: if its build or the exec-bit patch (build:shared)
  // failed, importing it throws and NOTHING that spawns a session can work.
  try {
    const pty = await import("node-pty");
    if (typeof pty.spawn !== "function") throw new Error("no spawn export");
    return { id: "node-pty", status: "ok", detail: "node-pty loaded" };
  } catch (err) {
    return {
      id: "node-pty",
      status: "fail",
      detail: `node-pty failed to load: ${String(err)}`,
      fix: ptyFix(currentMode().kind),
    };
  }
}

type ModeKind = ReturnType<typeof currentMode>["kind"];

/**
 * How to get node-pty back, for THIS kind of install: the checkout's npm
 * commands mean nothing to a release install (no `scripts/`, no workspace).
 * A release tarball ships node-pty's prebuilds, so it is re-run the installer.
 */
export function ptyFix(kind: ModeKind): string {
  if (kind === "tarball") {
    return `Reinstall the program: re-run the installer (it replaces the release, node-pty's prebuilt binaries included, and keeps your settings), then \`${BRAND.slug} doctor\`.`;
  }
  if (kind === "npm") {
    return `Reinstall it: \`npm install -g ${BRAND.slug}\` (rebuilds node-pty; needs Xcode CLT on macOS, build-essential + python3 on Linux).`;
  }
  return "Reinstall it: `npm rebuild --ignore-scripts=false node-pty && node scripts/fix-node-pty.mjs` (needs Xcode CLT on macOS, build-essential + python3 on Linux).";
}

/** The command that prints the full report, for THIS kind of install. */
export function doctorCommand(kind: ModeKind): string {
  return kind === "tarball" || kind === "npm" ? `${BRAND.slug} doctor` : "npm run doctor";
}

async function checkPtyCapacity(): Promise<Check> {
  // The kernel caps concurrent pseudo-terminals system-wide, and past the cap
  // EVERY session and EVERY build fails with node-pty's `posix_spawnp failed`
  // and nothing else. Measured here: the table sat at 511/511 with 287 of them
  // held by an orphaned scratch script, and six unrelated-looking symptoms on
  // the phone had that one cause. Preflight is where that gets seen early.
  const max = ptyMax();
  const open = ptyOpen();
  if (max === null || open === null) {
    return { id: "pty-capacity", status: "ok", detail: "pty capacity not readable on this platform" };
  }
  const free = max - open;
  const detail = `${open} of ${max} pseudo-terminals in use (${free} free)`;
  const fix = "Close sessions you are done with, or find the holder: "
    + "`lsof /dev/ptmx | awk 'NR>1{print $1, $2}' | sort | uniq -c | sort -rn`.";
  if (free <= 0) return { id: "pty-capacity", status: "fail", detail: `${detail} — no session or build can start`, fix };
  if (free < 32) return { id: "pty-capacity", status: "warn", detail, fix };
  return { id: "pty-capacity", status: "ok", detail };
}

/** How to sign in, said once for the doctor, the onboarding plan and a peer's row. */
export const CLAUDE_SIGN_IN_FIX =
  "Sign in from the phone: open any session on this desktop, tap its sign-in button, sign in in the browser, then tap paste code. (Or run `claude` once in a terminal here.) Sessions stop at the sign-in screen until then.";

/** `claude auth status` output → signed in, signed out, or unreadable (null — never a guess). */
export function classifyClaudeAuth(out: string): "in" | "out" | null {
  const text = out.toLowerCase();
  if (/loggedin["\s:]*false|not logged in|logged out|please run.*login/.test(text)) return "out";
  if (/loggedin["\s:]*true|logged in|authenticated/.test(text)) return "in";
  return null;
}

let authCache: { bin: string; at: number; state: "in" | "out" | null } | null = null;
let authInflight: Promise<"in" | "out" | null> | null = null;

/**
 * Is claude signed in on this desktop, for a request path (the onboarding plan, a peer's hello).
 * Cached — each read spawns `claude`: a yes for 5 minutes, a no or an unreadable answer for 15 s,
 * so signing in shows up on the next look. Never throws; a failure is null.
 */
export async function claudeSignInState(bin: string, now = Date.now()): Promise<"in" | "out" | null> {
  if (authCache && authCache.bin === bin && now - authCache.at < (authCache.state === "in" ? 300_000 : 15_000)) return authCache.state;
  authInflight ??= (async () => {
    try {
      const resolved = await which(bin);
      const state = resolved ? classifyClaudeAuth((await run(resolved, ["auth", "status"], 15000)).out) : null;
      authCache = { bin, at: Date.now(), state };
      return state;
    } catch { return null; } finally { authInflight = null; }
  })();
  return authInflight;
}

async function checkClaude(bin: string): Promise<Check[]> {
  const resolved = await which(bin);
  if (!resolved) {
    return [{
      id: "claude-binary",
      status: "fail",
      detail: `\`${bin}\` not found — ${BRAND.name} currently drives Claude Code primarily (other CLIs come as plugins)`,
      fix: `Install Claude Code (https://docs.anthropic.com/en/docs/claude-code) and make sure it's on PATH, or point ${envName("CLAUDE_BIN")} at the binary.`,
    }];
  }
  const out: Check[] = [];
  const ver = await run(resolved, ["--version"]);
  out.push({
    id: "claude-binary",
    status: "ok",
    detail: `${resolved}${ver.ok && ver.out ? ` (${ver.out.split("\n")[0]})` : ""}`,
  });
  // Newer than the build the heuristics were checked against: a warning with the
  // remedy already in the product (clihealth), never a refusal. Absent when the
  // version could not be read.
  const newer = ver.ok ? claudeNewerThanTested(ver.out.split("\n")[0]) : null;
  if (newer) out.push({ id: "claude-version", status: "warn", detail: newer });

  // Sessions spawn fine when logged out — they just die on the login screen,
  // which looks like "the app is broken" from the phone.
  const auth = await run(resolved, ["auth", "status"], 15000);
  const state = classifyClaudeAuth(auth.out);
  if (state === "in") {
    out.push({ id: "claude-login", status: "ok", detail: "claude is signed in" });
  } else if (state === "out") {
    out.push({
      id: "claude-login",
      status: "fail",
      detail: "claude is not signed in",
      fix: CLAUDE_SIGN_IN_FIX,
    });
  } else {
    out.push({
      id: "claude-login",
      status: "warn",
      detail: "couldn't read `claude auth status` (CLI output may have changed)",
      fix: "Check from the phone: open a session on this desktop; if it shows a sign-in screen, use its sign-in button.",
    });
  }
  return out;
}

/**
 * Which capture backends this desktop can drive — informational, always `ok`.
 *
 * NEVER `warn` and never `fail`, and that is the whole design of this line. A
 * capture backend nobody has configured a target for is not a problem: no
 * Playwright on a machine that drives a watch simulator is the correct state,
 * and a report whose value rests on every line being actionable must not spend
 * one saying "something is missing" about something nobody asked for. The
 * refusal that DOES matter is the one at run time, in words naming the fix,
 * where a person has just tapped a target that cannot run
 * (`probeCaptureBackends` answers that sentence too).
 *
 * Host-scoped on purpose: no repo dir is passed, so `web` reports on the host's
 * own `node_modules`. Per-REPO availability is `capture.list`'s answer, because
 * Playwright lives in the target repo.
 */
async function checkCapture(): Promise<Check> {
  // The kill switch answers for all four at once, and it gets its own sentence:
  // four rows of "not set up here" about backends that are installed and simply
  // switched off would be four wrong answers rather than one right one.
  if (env("CAPTURE") === "0") {
    return { id: "capture", status: "ok", detail: `switched off on this host (${envName("CAPTURE")}=0) — no capture target can run` };
  }
  const info = await probeCaptureBackends();
  return {
    id: "capture",
    status: "ok",
    // An available backend says HOW (which Playwright, which device); an absent
    // one says only that it is absent, because its full reason is a sentence
    // aimed at somebody who just tapped a target, and it is printed there.
    detail: info.map((b) => `${b.id}: ${b.available ? (b.reason ?? "ok") : "not set up here"}`).join(" · "),
  };
}

/**
 * Whether dictation has an engine on this desktop — informational, never a
 * failure.
 *
 * `checkCapture`'s posture, for the same reason: a desktop with no whisper
 * model is not broken, it simply has no local transcriber, and the phone falls
 * back to the browser's own recogniser (or draws no microphone at all) with no
 * intervention. The line exists because the ABSENCE is invisible otherwise —
 * the button quietly stays on the worse engine and nothing anywhere says why.
 */
export async function checkDictate(): Promise<Check> {
  // The live status, as the phone's GET sees it: a running whisperd is a
  // transcriber even on a desktop with no whisper-cli model.
  const s = await dictateStatusLive();
  return s.available
    ? { id: "dictate", status: "ok", detail: `${s.engine} · ${s.model}` }
    : {
        id: "dictate",
        status: "ok",
        detail: `${s.reason} — the phone falls back to the browser's own recogniser.`,
        fix: `${process.platform === "darwin" ? "brew install whisper-cpp" : "install whisper.cpp (whisper-cli on PATH)"}, then put a model in ~/.local/share/${BRAND.configDirName}/models `
          + "(ggml-large-v3-turbo.bin is ~30x realtime on Apple silicon).",
      };
}

async function checkCurl(): Promise<Check> {
  // Turn boundaries come from claude hooks, which curl their payload back to us.
  // Without curl the host silently falls back to guessing from PTY silence.
  const c = await which("curl");
  return c
    ? { id: "curl", status: "ok", detail: "curl present (hook turn-boundaries exact)" }
    : {
        id: "curl",
        status: "warn",
        detail: "curl not found",
        fix: "Install curl for exact turn detection. Without it the host guesses turn ends from output silence, which can fire early.",
      };
}

/** tmux is required (`tmuxreq.ts`): present, recent enough, and a UTF-8 locale for its panes. */
async function checkTmux(): Promise<Check[]> {
  const path = onPath("tmux");
  const v = path ? await run(path, ["-V"], 4000) : null;
  return tmuxChecks({
    knob: env("TMUX"), platform: process.platform, path,
    versionOut: v?.ok ? v.out : null,
    installCmd: tmuxInstallCommand(process.platform, (b) => onPath(b) !== null),
    env: process.env,
  });
}

async function checkGit(): Promise<Check> {
  const g = await which("git");
  return g
    ? { id: "git", status: "ok", detail: "git present" }
    : { id: "git", status: "fail", detail: "git not found", fix: "Install git — repo discovery, worktrees and the diff view all shell out to it." };
}

/**
 * The code root. When nobody named it and the `~/dev` default is not there, the
 * phone would show an EMPTY repo list with no reason — so that case says it was
 * a guess, and how to name the real one.
 */
export function checkRoot(root: string, defaulted = false): Check {
  if (!existsSync(root)) {
    return defaulted
      ? {
        id: "root",
        status: "fail",
        detail: `no code folder named — ${envName("ROOT")} is unset and the default ${root} does not exist, so the phone would list no repos`,
        fix: `Name the folder holding your repos: \`${BRAND.slug} service install --force --env ${envName("ROOT")}=/path/to/code\` ` +
          `(or export ${envName("ROOT")} in the shell that starts the host) — it is read from the environment, not from a .env file.`,
      }
      : {
        id: "root",
        status: "fail",
        detail: `${envName("ROOT")} ${root} does not exist`,
        fix: `Create it, or point ${envName("ROOT")} at the directory holding the repos you want to drive.`,
      };
  }
  return {
    id: "root",
    status: "ok",
    detail: `scanning ${root} — everything under here is reachable from the phone`,
  };
}

/**
 * Where the daemon's own state lives (acks, sessions, settings, keys, ledgers),
 * which is no longer inside the code root. `ok` names the dir and why that one;
 * `warn` when an old `<root>/<state dir>` still holds state — either the move
 * has not run yet (this is `--doctor`, which only looks) or it was refused
 * because both held state.
 */
export function checkState(root: string): Check {
  const r = stateDirReport(root);
  const why = r.source === "env" ? `${envName("STATE_DIR")}` : r.source === "xdg" ? "$XDG_STATE_HOME" : "the default";
  if (r.old && r.live === r.old) {
    return {
      id: "state", status: "warn",
      detail: `state is still in ${r.old}, inside the code folder; it belongs in ${r.dir} (${why})`,
      fix: `Start the host — its next boot moves it there and leaves a symlink behind. If a running host already tried, its log says why it could not.`,
    };
  }
  if (r.old) {
    return {
      id: "state", status: "warn",
      detail: `state is in ${r.live} (${why}), but ${r.old} still holds entries that were ALSO in it — left there untouched and unused (the boot log named them)`,
      fix: `Compare each with its namesake in ${r.live}, keep the one you want there, then rename or delete ${r.old}.`,
    };
  }
  return { id: "state", status: "ok", detail: `host state in ${r.live} (${why})` };
}

/**
 * The installed service starts the host with ITS environment, not this
 * shell's. When that environment resolves the state dir somewhere else, the
 * service and a `doctor` (or `npm start`) from here are two hosts with two
 * memories — the ack ledger included. null when no service is installed or
 * both agree.
 */
export function checkServiceState(
  svc: { file: string; env: Record<string, string> } | null = installedServiceEnv(),
  e: NodeJS.ProcessEnv = process.env,
): Check | null {
  if (!svc) return null;
  const mine = resolveStateDir(e).dir;
  const theirs = resolveStateDir(svc.env, svc.env.HOME || homedir()).dir;
  if (mine === theirs) return null;
  return {
    id: "state-service", status: "warn",
    detail: `the installed service (${svc.file}) keeps host state in ${theirs}, but this shell resolves ${mine}`,
    fix: `Re-install the service from the shell whose settings you want (\`${BRAND.slug} service install --force\` bakes the state dir in), ` +
      `or set ${envName("STATE_DIR")}=${theirs} here.`,
  };
}

/**
 * The same question for the claude CLI's own config dir: a service whose
 * environment resolves `CLAUDE_CONFIG_DIR` differently from this shell reads
 * another sign-in than the `claude` you run here, and every session it opens
 * lands on the sign-in screen. null when no service is installed or both agree.
 */
export function checkServiceClaudeDir(
  svc: { file: string; env: Record<string, string> } | null = installedServiceEnv(),
  e: NodeJS.ProcessEnv = process.env,
): Check | null {
  if (!svc) return null;
  const mine = resolve(claudeConfigDirFromEnv(e, homedir()));
  const theirs = resolve(claudeConfigDirFromEnv(svc.env, svc.env.HOME || homedir()));
  if (mine === theirs) return null;
  return {
    id: "claude-service", status: "warn",
    detail: `the installed service (${svc.file}) runs claude with its config in ${theirs}, but this shell's claude uses ${mine}`,
    fix: `Re-install the service from the shell whose claude sign-in you want (\`${BRAND.slug} service install --force\` bakes CLAUDE_CONFIG_DIR in), ` +
      (svc.env.CLAUDE_CONFIG_DIR ? `or set CLAUDE_CONFIG_DIR=${theirs} here.` : `or unset CLAUDE_CONFIG_DIR here.`),
  };
}

/** Both service-vs-shell comparisons over ONE read of the installed service. */
function serviceChecks(): Check[] {
  const svc = installedServiceEnv();
  return [checkServiceState(svc), checkServiceClaudeDir(svc)].filter((c): c is Check => c !== null);
}

function checkReachability(i: DoctorInput): Check {
  if (i.tailscaleIp) {
    return { id: "reachable", status: "ok", detail: `phone reaches this at http://${i.tailscaleIp}:${i.port}` };
  }
  if (i.allowPublic) {
    return {
      id: "reachable",
      status: "warn",
      detail: `no Tailscale IP; bound to the LAN via ${envName("ALLOW_PUBLIC")}=1`,
      fix: "Set a LAN password in Settings → LAN access. Until you do, LAN devices are refused.",
    };
  }
  return {
    id: "reachable",
    status: "warn",
    detail: "no Tailscale IP — binding loopback only, so your phone cannot reach this host",
    fix: "Install Tailscale and sign in on both this machine and the phone (same tailnet). Everything else works; only remote access is missing.",
  };
}

/**
 * `lan`: is the same-Wi-Fi route ready? Quiet (null) when no LAN interface is
 * bound — most hosts never opt in, and a line about a route nobody asked for is
 * noise. Bound without a password is a WARN: deny-until-set means every LAN
 * device is refused, which is safe but is not "LAN access". The identity file is
 * created the first time a trusted phone asks for it, so its absence is said,
 * not failed.
 */
export function checkLan(i: Pick<DoctorInput, "root" | "port" | "allowPublic">, ips: string[] = lanIps()): Check | null {
  if (!i.allowPublic || !ips.length) return null;
  const at = `http://${ips[0]}:${i.port}`;
  const password = existsSync(join(hostStateDir(i.root), "auth.json"));
  if (!password) {
    return {
      id: "lan",
      status: "warn",
      detail: `LAN bound at ${at} (${envName("ALLOW_PUBLIC")}=1) but no password is set — every LAN device is refused`,
      fix: "Set a LAN password in Settings → LAN access from this machine or over Tailscale.",
    };
  }
  const identity = lanIdentityPresent(i.root);
  return {
    id: "lan",
    status: "ok",
    detail: `LAN ready at ${at} (password set, ${identity ? "identity present" : "identity created on the first trusted phone's request"})`,
  };
}

/** How close to expiry is worth a line. A node key is good for 180 days by
 *  default, so two weeks is plenty of notice and rare enough not to be noise. */
const KEY_WARN_DAYS = 14;

/**
 * The Tailscale node key expires — and when it does, nothing here says so.
 *
 * This is the quietest way to lose the whole app. Keys are good for 180 days by
 * default; when one lapses the machine simply drops off the tailnet, so from
 * the phone it is indistinguishable from the host being asleep, the daemon
 * being dead or the wifi being bad. Every other symptom this report covers
 * announces itself somewhere. This one announces itself six months after the
 * decision that caused it, on the day you are not at the desk.
 *
 * Deliberately `warn`, never `fail`: an expiring key breaks nothing today, and
 * the host is perfectly useful from the machine it runs on.
 *
 * `null` — the row is absent, not green — whenever the answer cannot be had:
 * no tailnet in play (`checkReachability` already says that, and saying it
 * twice makes one fact look like two), no CLI, an unparsable status. An absent
 * reading is never a verdict.
 *
 * It can only speak for THIS machine. The phone's key expires on its own clock
 * and is invisible from here, which is why the fix names both.
 */
async function checkTailscaleKey(i: DoctorInput): Promise<Check | null> {
  if (!i.tailscaleIp && !i.tailscaleDns) return null;
  const bin = await tailscaleBin();
  if (!bin) return null;
  const { out, ok } = await run(bin, ["status", "--json"]);
  if (!ok) return null;
  let self: any;
  try {
    self = JSON.parse(out)?.Self;
  } catch {
    return null;
  }
  if (!self) return null;

  const admin = "https://login.tailscale.com/admin/machines";
  const disable =
    `Turn expiry off for this machine AND the phone in the admin console (${admin} → ⋯ → Disable key expiry)` +
    ", or re-authenticate here with `tailscale up --force-reauth`.";

  if (self.Expired === true) {
    return {
      id: "tailscale-key",
      status: "warn",
      detail: "this machine's Tailscale node key has EXPIRED — it is off the tailnet until it is re-authenticated",
      fix: disable,
    };
  }

  const expiry = typeof self.KeyExpiry === "string" ? Date.parse(self.KeyExpiry) : NaN;
  // Expiry disabled shows up as an absent field or the zero time, depending on
  // the version. Both mean the same thing and neither is a date.
  if (!Number.isFinite(expiry) || expiry < Date.parse("2000-01-01T00:00:00Z")) {
    return { id: "tailscale-key", status: "ok", detail: "this machine's Tailscale node key does not expire" };
  }
  const days = Math.floor((expiry - Date.now()) / 86_400_000);
  const when = new Date(expiry).toISOString().slice(0, 10);
  if (days <= KEY_WARN_DAYS) {
    return {
      id: "tailscale-key",
      status: "warn",
      detail:
        days <= 0
          ? `this machine's Tailscale node key expires today (${when}) — after that the phone cannot reach this host at all`
          : `this machine's Tailscale node key expires in ${days} day${days === 1 ? "" : "s"} (${when}) — after that the phone cannot reach this host at all`,
      fix: disable,
    };
  }
  return {
    id: "tailscale-key",
    status: "ok",
    detail: `this machine's Tailscale node key is good until ${when} (${days} days)`,
  };
}

async function checkSecureContext(i: DoctorInput): Promise<Check> {
  // Web Push, service workers, install-to-homescreen and navigator.clipboard all
  // require https or localhost. Over plain http://100.x they no-op with no error.
  // Don't nag someone who already fronted us with TLS: ask tailscale whether it
  // is proxying to our port before claiming the phone is on plain HTTP.
  const bin = await tailscaleBin();
  if (bin) {
    const front = await serveHttpsUrl(i.port);
    if (front) {
      return {
        id: "secure-context",
        status: "ok",
        detail: `tailscale serve is fronting port ${i.port} with HTTPS — use ${front}`,
      };
    }
  }
  if (i.tailscaleDns) {
    return {
      id: "secure-context",
      status: "warn",
      detail: "not a secure context (plain HTTP over Tailscale) — Web Push, the install prompt and clipboard no-op on the phone, and the app is lost on any navigation while the tunnel is down",
      fix: `Run: \`tailscale serve --bg --https=443 http://127.0.0.1:${i.port}\` (pick another --https port if 443 already serves something else — check \`tailscale serve status\`), then browse that https name on the phone. Needs MagicDNS + HTTPS certificates enabled in the tailnet admin console.`,
    };
  }
  return {
    id: "secure-context",
    status: "warn",
    detail: "not a secure context (plain HTTP) — Web Push, the install prompt and clipboard no-op on the phone",
    fix: `Enable MagicDNS + HTTPS certificates in the tailnet admin console, then run: \`tailscale serve --bg --https=443 http://127.0.0.1:${i.port}\`.`,
  };
}

/** Our own host answering on the port — right after `service install` that is the normal case. */
async function ourHostOn(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && typeof (await r.json()) === "object";
  } catch { return false; }
}

async function checkPort(port: number): Promise<Check> {
  if (await portFree(port)) return { id: "port", status: "ok", detail: `port ${port} is free` };
  // Not a conflict when it is this host: the installer runs doctor just after starting the service.
  if (await ourHostOn(port)) return { id: "port", status: "ok", detail: `the ${BRAND.displayName} host is running on port ${port}` };
  return {
        id: "port",
        status: "warn",
        detail: `port ${port} is already in use`,
        fix: `Something else is listening there — stop it, or set ${envName("PORT")} to a free port.`,
      };
}

/** WSL facts off the real machine; `wslChecks` (doctorwsl.ts) is the pure half. */
async function checkWsl(i: DoctorInput): Promise<Check[]> {
  if (process.platform !== "linux") return [];
  const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
  return wslChecks({
    procVersion: read("/proc/version"),
    release: release(),
    pid1Comm: read("/proc/1/comm"),
    tailscaleIp: i.tailscaleIp,
    root: i.root,
    claudePath: await which(i.claudeBin),
  });
}

/**
 * `self-update`: is a newer release published? Tarball installs only (the
 * others update through npm or git, and `update --check` says how). ONE
 * request with a short timeout; a network failure is an `ok` row saying it
 * could not check, never a warning. It only SAYS: nothing here downloads or
 * applies anything.
 */
async function checkSelfUpdate(): Promise<Check | null> {
  const mode = currentMode();
  if (mode.kind !== "tarball") return null;
  try {
    // release.json is believed only once its publisher signature checks out (`update` does the same).
    const policy = currentSigPolicy();
    const unchecked = policy.kind === "skip" ? ` (publisher signature NOT checked: ${envName("INSECURE_SKIP_SIG")}=1)` : "";
    const latest = await latestRelease(releaseSource(null), 4000, policy);
    const cmp = compareVersions(mode.version, latest.version);
    if (cmp === -1) {
      return { id: "self-update", status: "warn", detail: `${latest.version} available (running ${mode.version})${unchecked}`, fix: `run \`${BRAND.slug} update\`` };
    }
    return { id: "self-update", status: "ok", detail: (cmp === null ? `running ${mode.version}; the latest release says ${latest.version}` : `${mode.version} is the latest release`) + unchecked };
  } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 160);
    if (e instanceof SignatureRefused) {
      return { id: "self-update", status: "warn", detail: `running ${mode.version}; the published release.json failed its signature check (${why})`, fix: `\`${BRAND.slug} update\` will refuse it too; nothing needs doing here unless you expected a release` };
    }
    return { id: "self-update", status: "ok", detail: `running ${mode.version}; could not check for a newer release (${why})` };
  }
}

/**
 * The Android toolchain, as three lines: `java`, `android-sdk`, `sdk-licences`. READ-ONLY (`androidenv.ts`).
 *
 * Most desktops here build no Android app, so an absent JDK or SDK is `ok` with a sentence saying
 * what it is for — a warn on every machine would be a line that says "something is wrong" about
 * nothing. The one real `warn`: an SDK that IS there with its licences unaccepted, which is exactly
 * the state in which a build fails at 3 a.m. with a message about a licence. Installing what is
 * missing is the first-app journey's toolchain step, never this report's.
 */
export function androidChecks(r: AndroidEnvReport = probeAndroidEnv()): Check[] {
  const only = "only needed to build Android apps";
  const java: Check = r.jdk
    ? { id: "java", status: "ok", detail: `JDK${r.jdk.major ? ` ${r.jdk.major}` : ""} at ${r.jdk.home} (${r.jdk.source})` }
    : { id: "java", status: "ok", detail: r.jdkTooOld
        ? `JDK ${r.jdkTooOld.major} at ${r.jdkTooOld.home} is too old for current Android builds (17+); ${only}`
        : `no JDK found; ${only}` };
  const sdk: Check = r.sdk
    ? { id: "android-sdk", status: "ok", detail: `${r.sdk.root} (${r.sdk.source}): ${r.sdk.platforms.length} platform${r.sdk.platforms.length === 1 ? "" : "s"}, ${r.sdk.buildTools.length} build-tools` }
    : { id: "android-sdk", status: "ok", detail: `no Android SDK found; ${only}` };
  const lic: Check = !r.sdk
    ? { id: "sdk-licences", status: "ok", detail: "no Android SDK, so nothing to accept" }
    : r.sdk.licensesAccepted
      ? { id: "sdk-licences", status: "ok", detail: "SDK licences accepted" }
      : { id: "sdk-licences", status: "warn", detail: `the SDK at ${r.sdk.root} has licences nobody accepted`,
          fix: "accept them yourself with `sdkmanager --licenses`, or in Android Studio's SDK Manager" };
  return [java, sdk, lic];
}

/**
 * Run every check. `skipPort` when called from a host that already bound it.
 *
 * `skipCapture` is the boot path's, and it is there for the same shape of
 * reason: the capture probe shells out to four binaries — `adb devices` among
 * them, which STARTS the adb daemon — and the line it produces is always `ok`,
 * so `printBootSummary` (which prints only what is wrong) would throw it away.
 * Spawning an adb server on every `npm run restart` to compute a sentence
 * nobody reads is not a preflight. Asked for by name (`npm run doctor`), it
 * runs and prints.
 *
 * `skipNetwork` is the boot path's too: the self-update row is a request to the
 * release host, and a restart is not a reason to phone home. Asked for by name
 * (`<slug> doctor`), it runs.
 */
export async function runChecks(i: DoctorInput, skipPort = false, skipCapture = false, skipNetwork = false): Promise<Check[]> {
  const [node, ptyc, ptycap, claude, builtins, curl, git, tmux, capture, dictate, tskey, secure, port, wsl, selfUpdate] = await Promise.all([
    checkNode(),
    checkPty(),
    checkPtyCapacity(),
    checkClaude(i.claudeBin),
    builtinDoctorChecks(i.usedBackends ?? []),
    checkCurl(),
    checkGit(),
    checkTmux(),
    skipCapture ? Promise.resolve(null) : checkCapture(),
    checkDictate(),
    checkTailscaleKey(i),
    checkSecureContext(i),
    skipPort ? Promise.resolve(null) : checkPort(i.port),
    checkWsl(i),
    skipNetwork ? Promise.resolve(null) : checkSelfUpdate(),
  ]);
  return [
    node,
    ptyc,
    ptycap,
    ...claude,
    ...builtins,
    git,
    ...tmux,
    curl,
    ...(capture ? [capture] : []),
    dictate,
    checkRoot(i.root, i.rootDefaulted),
    checkState(i.root),
    overlaysCheck(),
    ...serviceChecks(),
    checkReachability(i),
    ...[checkLan(i)].filter((c): c is Check => c !== null),
    ...(tskey ? [tskey] : []),
    secure,
    ...(port ? [port] : []),
    ...wsl,
    ...androidChecks(),
    ...(selfUpdate ? [selfUpdate] : []),
  ];
}

const MARK: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/** Print the full report (the `npm run doctor` view). */
export function printReport(checks: Check[]): void {
  console.log(`\n${BRAND.name} doctor\n`);
  for (const c of checks) {
    console.log(`  [${MARK[c.status]}] ${c.id.padEnd(15)} ${c.detail}`);
    if (c.fix) console.log(`         ${" ".repeat(15)} → ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(
    `\n  ${checks.length - fails - warns} ok, ${warns} warning${warns === 1 ? "" : "s"}, ${fails} failure${fails === 1 ? "" : "s"}.` +
    (fails ? " Fix the failures above before expecting sessions to work.\n" : "\n"),
  );
}

/**
 * Boot-time version: quiet when healthy, one line per problem otherwise. The
 * host keeps running either way — a missing Tailscale IP or no push is a
 * degraded host, not a broken one.
 */
export function printBootSummary(checks: Check[], kind: ModeKind = currentMode().kind): void {
  const bad = checks.filter((c) => c.status !== "ok");
  if (!bad.length) {
    console.log(`${logTag} preflight: all checks passed.`);
    return;
  }
  for (const c of bad) {
    console.warn(`${logTag} ${c.status === "fail" ? "PROBLEM" : "note"}: ${c.detail}${c.fix ? ` → ${c.fix}` : ""}`);
  }
  console.warn(`${logTag} run \`${doctorCommand(kind)}\` for the full preflight report.`);
}
