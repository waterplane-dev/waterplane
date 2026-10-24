/**
 * Where the `claude` binary is — found, so the person does not have to.
 *
 * A first install had Claude Code installed but not on PATH (the native
 * installer drops it in `~/.local/bin`, which a fresh shell may not list), and a
 * launchd/systemd service starts with a minimal PATH on top of that. The host
 * said "make sure it's on PATH" — a chore it can do itself. Order: the knob
 * (`WATERPLANE_CLAUDE_BIN`), then `claude` on PATH, then the usual install
 * locations, then plain `claude` (unchanged behaviour) with what was tried.
 *
 * Pure: every fact is injected (`exists`, `onPath`, `readdir`), so tests never
 * touch the real filesystem. Synchronous checks only — no child process.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import path from "node:path";
import { isWsl } from "./doctorwsl.js";

export type ClaudeBinSource = "env" | "path" | "found";

export interface ClaudeBinResult {
  bin: string;
  source: ClaudeBinSource;
  /** Every location checked, in order (empty when the knob or PATH decided). */
  tried: string[];
  /** Under WSL, nothing on the Linux side, but Claude is installed on Windows: that path. Never used as `bin`. */
  windowsSide?: string;
  /** Nothing resolved: no knob, not on PATH, no candidate exists. `bin` is then the bare `claude` fallback, which will not spawn. */
  missing?: true;
}

export interface ClaudeBinFacts {
  /** The `WATERPLANE_CLAUDE_BIN` knob. */
  knob?: string;
  /** Process env (`npm_config_prefix`, `APPDATA`, `USERPROFILE`). */
  env?: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  exists: (p: string) => boolean;
  /** Is this command name resolvable through PATH. */
  onPath: (name: string) => boolean;
  /** Directory entries, [] when unreadable. */
  readdir?: (p: string) => string[];
  wsl?: boolean;
}

const verDesc = (a: string, b: string): number => {
  const n = (s: string): number[] => s.replace(/^v/, "").split(".").map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

export function findClaudeBin(f: ClaudeBinFacts): ClaudeBinResult {
  if (f.knob) return { bin: f.knob, source: "env", tried: [] };
  if (f.onPath("claude")) return { bin: "claude", source: "path", tried: [] };
  const win = f.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const env = f.env ?? {};
  const ls = f.readdir ?? (() => []);

  const cands: string[] = [];
  if (win) {
    if (env.APPDATA) cands.push(p.join(env.APPDATA, "npm", "claude.cmd"));
    cands.push(p.join(env.USERPROFILE || f.home, ".local", "bin", "claude.exe"));
  } else {
    cands.push(p.join(f.home, ".local", "bin", "claude"), p.join(f.home, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude", "/usr/local/bin/claude", p.join(f.home, ".npm-global", "bin", "claude"));
    if (env.npm_config_prefix) cands.push(p.join(env.npm_config_prefix, "bin", "claude"));
    cands.push(p.join(f.home, ".volta", "bin", "claude"), p.join(f.home, ".bun", "bin", "claude"));
    const nvm = p.join(f.home, ".nvm", "versions", "node");
    for (const v of [...ls(nvm)].sort(verDesc)) cands.push(p.join(nvm, v, "bin", "claude"));
    const fnm = p.join(f.home, ".local", "share", "fnm", "node-versions");
    for (const v of [...ls(fnm)].sort(verDesc)) cands.push(p.join(fnm, v, "installation", "bin", "claude"));
  }
  const tried: string[] = [];
  for (const c of cands) {
    tried.push(c);
    if (f.exists(c)) return { bin: c, source: "found", tried };
  }
  const out: ClaudeBinResult = { bin: "claude", source: "path", tried, missing: true };
  if (f.wsl && !win) {
    for (const u of ls("/mnt/c/Users")) {
      for (const rel of ["AppData/Roaming/npm/claude.cmd", ".local/bin/claude.exe"]) {
        const w = `/mnt/c/Users/${u}/${rel}`;
        if (f.exists(w)) { out.windowsSide = w; return out; }
      }
    }
  }
  return out;
}

/** `/home/me/x` → `~/x`. */
export const tilde = (s: string, home: string): string =>
  home && (s === home || s.startsWith(home + "/") || s.startsWith(home + "\\")) ? "~" + s.slice(home.length) : s;

/** The real machine's PATH, scanned synchronously. */
export function pathHas(name: string, platform: NodeJS.Platform): boolean {
  const win = platform === "win32";
  const dirs = (process.env.PATH ?? "").split(win ? ";" : ":").filter(Boolean);
  const names = win ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  return dirs.some((d) => names.some((n) => existsSync(path.join(d, n))));
}

const safeLs = (p: string): string[] => { try { return readdirSync(p); } catch { return []; } };
const safeRead = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

let cached: ClaudeBinResult | null = null;

/** Resolved once per process from the real machine (the knob is read live by `claudeBin()`, not here). */
export function claudeBinResolution(): ClaudeBinResult {
  // A miss is never cached: installing claude and retrying must work without a host restart. Nor is
  // a hit trusted blindly: a package-manager upgrade unlinks the command for minutes, so the cached
  // answer is re-checked (one stat or PATH scan) and re-resolved when it has gone.
  if (cached && !cached.missing && (cached.bin.includes("/") ? existsSync(cached.bin) : pathHas(cached.bin, process.platform))) return cached;
  cached = findClaudeBin({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    exists: existsSync,
    onPath: (n) => pathHas(n, process.platform),
    readdir: safeLs,
    wsl: process.platform === "linux" && isWsl(safeRead("/proc/version"), release()),
  });
  return cached;
}
