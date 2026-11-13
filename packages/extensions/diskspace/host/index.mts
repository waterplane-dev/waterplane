/**
 * The disk-space extension's host half: the methods the phone's sheet calls (`shared/wire.mts`) over
 * the engine (`engine.mts`). Contributed through the same `HostPluginApi` an external plugin gets.
 *
 * Spends nothing: `du`, `find`, `git check-ignore` and `ollama list|rm`, each by `execFile`/`spawn`
 * with no shell and a time bound. Nothing runs until the phone asks — no poller.
 */
import { access, readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { handleAll, makeEnvReader, type HostPluginApi } from "@waterplane/shared";
import { LARGE_LIMIT_S, PUSH_CHANGED, type DiskMethods } from "../shared/wire.mjs";
import type { DiskProfile } from "../shared/wire.mjs";
import type { Roots } from "./candidates.mjs";
import { createEngine, type Engine } from "./engine.mjs";
import { run } from "./run.mjs";

export { createEngine } from "./engine.mjs";
export type { Roots } from "./candidates.mjs";

const { env } = makeEnvReader(process.env, (text) => console.warn(text));

const OLLAMA_PLACES = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama", "/usr/bin/ollama"];

async function findOllama(): Promise<string | null> {
  for (const p of OLLAMA_PLACES) { try { await access(p); return p; } catch { /* next */ } }
  return null;
}

/**
 * Which desktop this is, decided once: a Mac, plain Linux, or Linux inside Windows' WSL — the same
 * test the host's own WSL checks use (`WSL_DISTRO_NAME`/`WSL_INTEROP`, else "microsoft" in the
 * kernel release). Any other platform is read as plain Linux.
 */
export async function detectProfile(platform: NodeJS.Platform = process.platform, e: NodeJS.ProcessEnv = process.env): Promise<DiskProfile> {
  if (platform === "darwin") return "mac";
  if (e.WSL_DISTRO_NAME || e.WSL_INTEROP) return "wsl";
  try { if (/microsoft/i.test(await readFile("/proc/sys/kernel/osrelease", "utf8"))) return "wsl"; } catch { /* not WSL */ }
  return "linux";
}

/** `cmd.exe /c echo %USERPROFILE%`'s answer, if it is one (an unset variable echoes itself). */
export function parseUserProfile(out: string): string | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
  return /^[A-Za-z]:\\[^%\r\n]*$/.test(line) ? line : null;
}

let winHomeCache: Promise<{ winHome: string | null; why?: string }> | null = null;

/** wsl: the Windows user folder as a /mnt path, asked of Windows once (time-bounded) and cached. */
export function resolveWinHome(): Promise<{ winHome: string | null; why?: string }> {
  winHomeCache ??= (async () => {
    // cwd on the Windows drive: cmd.exe started from a Linux folder prints a UNC warning first.
    let cwd: string | undefined = "/mnt/c";
    try { await access(cwd); } catch { cwd = undefined; }
    const echo = await run("cmd.exe", ["/c", "echo", "%USERPROFILE%"], { timeoutMs: 10_000, cwd });
    const win = echo.code === 0 ? parseUserProfile(echo.stdout) : null;
    if (!win) return { winHome: null, why: echo.timedOut ? "cmd.exe did not answer within 10 s" : echo.code !== 0 ? `cmd.exe could not run (${echo.error ?? `exit ${echo.code}`}) — is WSL interop switched off?` : "cmd.exe gave no %USERPROFILE%" };
    const u = await run("wslpath", ["-u", win], { timeoutMs: 5_000 });
    const path = u.code === 0 ? u.stdout.trim() : "";
    if (!path.startsWith("/")) return { winHome: null, why: `wslpath could not translate ${win}` };
    try { if (!(await stat(path)).isDirectory()) throw new Error("not a folder"); } catch { return { winHome: null, why: `${path} is not reachable from WSL` }; }
    return { winHome: path };
  })();
  return winHomeCache;
}

/** This desktop's roots. `WATERPLANE_ROOT` as the daemon reads it, else ~/dev. */
export async function defaultRoots(): Promise<Roots> {
  const home = homedir();
  const profile = await detectProfile();
  const wsl = profile === "wsl" ? await resolveWinHome() : null;
  return {
    profile,
    winHome: wsl?.winHome ?? null,
    wslDistro: profile === "wsl" ? (process.env.WSL_DISTRO_NAME || null) : null,
    profileNote: wsl && !wsl.winHome ? `Only the Linux side of WSL is listed: the Windows home folder could not be found (${wsl.why}).` : null,
    psBin: profile === "wsl" ? "powershell.exe" : null,
    // One call sizes every Windows-side folder of a scan phase; what it has not reached by then is "size unknown".
    psTimeoutMs: 180_000,
    home,
    root: (env("ROOT") || "").trim() || join(home, "dev"),
    // Claude Code keeps session scratch folders under /tmp/claude-<uid> (on a Mac /tmp is /private/tmp).
    tmpRoot: profile === "mac" ? `/private/tmp/claude-${userInfo().uid}` : `/tmp/claude-${userInfo().uid}`,
    androidSdk: (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "").trim() || (profile === "mac" ? join(home, "Library", "Android", "sdk") : join(home, "Android", "Sdk")),
    duBin: "/usr/bin/du",
    gitBin: "git",
    findBin: "/usr/bin/find",
    ollamaBin: await findOllama(),
    duTimeoutMs: 120_000,
    concurrency: 4,
    walkDepth: 8,
    walkBudget: 60_000,
    tmpMinAgeMs: 24 * 3600_000,
    winTempMinAgeMs: 7 * 24 * 3600_000,
    largeLimitMs: LARGE_LIMIT_S * 1000,
    largeMinSize: "+500M",
    now: () => Date.now(),
  };
}

/** Wire an engine to `api`'s methods and push. Exported so the tests drive the real handlers. */
export function serve(api: Pick<HostPluginApi, "handle" | "push">, engine: Engine): () => void {
  return handleAll<DiskMethods>(api, {
    state: () => engine.state(),
    scan: () => engine.scan(),
    scanLarge: () => engine.scanLarge(),
    scanCode: () => engine.scanCode(),
    remove: (a) => engine.remove((a as { id?: unknown } | null)?.id as string),
    cleanTemp: () => engine.cleanTemp(),
  });
}

let off: (() => void) | null = null;

export async function activate(api: HostPluginApi): Promise<void> {
  const roots = await defaultRoots();
  const engine = createEngine(roots, () => { api.push(PUSH_CHANGED, { at: Date.now() }); });
  off = serve(api, engine);
}

export function deactivate(): void {
  off?.();
  off = null;
}
