/**
 * Write-only secret setter — splice KEY=value into a gitignored dotenv file.
 *
 * ONE-DIRECTIONAL from the app's side: there is no read path here, so a value
 * written cannot be surfaced back to the phone, a transcript, or a plugin's
 * context — it is never logged or returned, callers get only a masked
 * tail for confirmation. NOTE this is not at-rest secrecy: the value is stored
 * as plaintext in a file on the host, so anything running there (including the
 * Claude CLI) can read it. The guarantee is "won't leak through the daemon", not
 * "Claude can never see it".
 *
 * Two scopes:
 *  - host  → a WRITE-ONLY TARGET (see below), a FIXED per-user location that
 *            does NOT move with the root — so secrets don't "vanish" when the
 *            repo-scan dir changes. Override the config dir with the
 *            `CONFIG_DIR` env knob (used by tests).
 *  - repo  → <worktree>/<file> (default .env). A gitignore GATE runs first: it
 *            REFUSES to write into a git-tracked file (that would stage the
 *            secret for commit) and auto-adds the file to .gitignore when it is
 *            neither ignored nor tracked, so a secret can never land in history.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BRAND } from "@waterplane/shared";
import { configDir } from "./branddirs.js";
import { contained } from "./paths.js";
import { expandHome } from "./pathx.js";
import { writeTextAtomic, writeTextAtomicKeepMode } from "./jsonstore.js";

/**
 * Fixed per-user dir for the daemon's own (host-scope) secrets, independent of
 * the root. Precedence: the `CONFIG_DIR` knob (test/override) →
 * `$XDG_CONFIG_HOME/<name>` → `~/.config/<name>` — `branddirs.ts`' `configDir`,
 * which also answers a legacy-named dir the boot move could not rename.
 */
export function hostSecretDir(): string {
  return configDir();
}

/** Absolute path to the host-scope .env file. */
export function hostSecretEnvPath(): string {
  return join(hostSecretDir(), ".env");
}

/**
 * Write-only target: a host-side file the phone may WRITE but never read back.
 *  - mode "dotenv": KEY=value is spliced into the file (the original behaviour).
 *  - mode "json":   the pasted value IS the whole file content; it must parse as
 *                   JSON. No key — the file is a single JSON blob (e.g. a cookie
 *                   jar), not a dotenv.
 * The built-in `env` target is the daemon's own .env; extra targets are declared in a
 * gitignored, host-only config file (see writeTargetsConfigPath) so the list is
 * maintained out-of-tree, never checked in.
 */
export interface WriteTargetDef {
  id: string;
  label: string;
  mode: "dotenv" | "json";
  /** Absolute path on the host. */
  path: string;
  /** Built-in env target also hot-reloads process.env (no restart). */
  hotReload?: boolean;
}

/** Path to the host-only config that declares extra write-only targets. */
export function writeTargetsConfigPath(): string {
  return join(hostSecretDir(), "write-targets.json");
}


// A target id: short slug used by the phone to pick a target.
const TARGET_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * The full list of write-only targets: the built-in `env` dotenv first, then any
 * valid entries from write-targets.json. Malformed/duplicate/invalid entries are
 * skipped (the built-in env id always wins). Never throws.
 */
export function listWriteTargets(): WriteTargetDef[] {
  const out: WriteTargetDef[] = [
    { id: "env", label: `${BRAND.displayName} .env (host)`, mode: "dotenv", path: hostSecretEnvPath(), hotReload: true },
  ];
  const seen = new Set(out.map((t) => t.id));
  const cfg = writeTargetsConfigPath();
  try {
    if (!existsSync(cfg)) return out;
    const parsed = JSON.parse(readFileSync(cfg, "utf8"));
    if (!Array.isArray(parsed)) return out;
    for (const e of parsed) {
      if (!e || typeof e !== "object") continue;
      const id = String(e.id || "").trim();
      const mode = e.mode === "json" ? "json" : e.mode === "dotenv" ? "dotenv" : null;
      const rawPath = String(e.path || "").trim();
      if (!TARGET_ID_RE.test(id) || seen.has(id) || !mode || !rawPath) continue;
      seen.add(id);
      out.push({ id, label: String(e.label || id), mode, path: resolve(expandHome(rawPath)) });
    }
  } catch {
    /* bad config → just the built-in target */
  }
  return out;
}

/** Resolve a target by id (defaults to the built-in `env`). */
function resolveTarget(id?: string): WriteTargetDef | null {
  const targets = listWriteTargets();
  return targets.find((t) => t.id === (id || "env")) ?? null;
}

/** Atomically write `body` to `full` at mode 0600, creating parent dirs. */
function atomicWrite(full: string, body: string): "created" | "replaced" {
  const existed = existsSync(full);
  mkdirSync(resolve(full, ".."), { recursive: true, mode: 0o700 });
  writeTextAtomic(full, body, { mode: 0o600 });
  try {
    chmodSync(full, 0o600);
  } catch {
    /* best effort */
  }
  return existed ? "replaced" : "created";
}

// A dotenv key: starts with a letter/underscore, then word chars. No spaces.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// An env-file name: `.env` or `.env.<suffix>` — keeps the target a dotenv.
const ENVFILE_RE = /^\.env(\.[A-Za-z0-9_.-]+)?$/;
// Template dotenvs (committed on purpose, hold placeholders not secrets) — never warn.
const ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/;

export interface SecretResult {
  ok: boolean;
  key?: string;
  /** Repo- (or state-dir-) relative file written. */
  file?: string;
  action?: "created" | "replaced";
  /** "••••" + last 4 chars, only when long enough to keep 4 hidden. */
  masked?: string;
  gitignored?: boolean;
  addedToGitignore?: boolean;
  error?: string;
}

export interface EnvFileInfo {
  name: string;
  gitignored: boolean;
  tracked: boolean;
  /** Template dotenv (.env.example etc) — committed by design, holds no secret. */
  template: boolean;
}

/** Mask for display: last 4 chars only when ≥8 long, else fully hidden. */
export function maskSecret(v: string): string {
  return v.length >= 8 ? "••••" + v.slice(-4) : "••••";
}

/** Resolve `file` inside `dir`, refusing traversal. Returns abs path or null. */
const inDir = (dir: string, file: string): string | null => contained(dir, file);

/** git check-ignore / ls-files probes (both return false outside a repo). */
function gitChecks(wt: string, relFile: string): { ignored: boolean; tracked: boolean } {
  const run = (args: string[]): boolean => {
    try {
      execFileSync("git", args, { cwd: wt, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  return {
    ignored: run(["check-ignore", "-q", "--", relFile]),
    tracked: run(["ls-files", "--error-unmatch", "--", relFile]),
  };
}

/** Splice KEY=value into `full` (replace any existing KEY= lines, else append). */
function spliceWrite(full: string, key: string, value: string): "created" | "replaced" {
  const raw = existsSync(full) ? readFileSync(full, "utf8") : "";
  const prefix = key + "=";
  const lines = raw.split("\n");
  const kept = lines.filter((l) => !l.startsWith(prefix)).join("\n").replace(/\n+$/, "");
  const body = (kept ? kept + "\n" : "") + prefix + value + "\n";
  return atomicWrite(full, body);
}

export interface SetSecretOpts {
  root: string;
  scope: "host" | "repo";
  /** Worktree path for repo scope; ignored for host scope. */
  worktree?: string;
  file?: string;
  /** Required for dotenv writes; ignored for json-mode host targets. */
  key?: string;
  value: string;
  /** Host scope: which write-only target (defaults to the built-in `env`). */
  targetId?: string;
}

export function setSecret(opts: SetSecretOpts): SecretResult {
  if (!opts.value) return { ok: false, error: "empty value" };

  // ── host scope: a write-only target (dotenv or whole-file json) ─────────
  if (opts.scope === "host") {
    const target = resolveTarget(opts.targetId);
    if (!target) return { ok: false, error: "unknown target" };

    if (target.mode === "json") {
      // The pasted value IS the file — must be valid JSON, no key needed.
      try {
        JSON.parse(opts.value);
      } catch {
        return { ok: false, error: "value must be valid JSON" };
      }
      const action = atomicWrite(target.path, opts.value);
      return { ok: true, file: target.path, action, masked: maskSecret(opts.value), gitignored: true };
    }

    // dotenv mode
    const key = (opts.key || "").trim();
    if (!key || !KEY_RE.test(key)) {
      return { ok: false, error: "invalid key — use A-Z, 0-9, _ and start with a letter or _" };
    }
    if (/[\r\n]/.test(opts.value)) return { ok: false, error: "value must be a single line" };
    mkdirSync(resolve(target.path, ".."), { recursive: true, mode: 0o700 });
    const action = spliceWrite(target.path, key, opts.value);
    // Hot-reload: the daemon reads process.env live (e.g. GEMINI_API_KEY for a plugin).
    if (target.hotReload) process.env[key] = opts.value;
    return { ok: true, key, file: target.path, action, masked: maskSecret(opts.value), gitignored: true };
  }

  // ── repo scope ──────────────────────────────────────────────────────
  const key = (opts.key || "").trim();
  if (!key || !KEY_RE.test(key)) {
    return { ok: false, error: "invalid key — use A-Z, 0-9, _ and start with a letter or _" };
  }
  if (/[\r\n]/.test(opts.value)) return { ok: false, error: "value must be a single line" };
  if (!opts.worktree) return { ok: false, error: "unknown repo" };
  const file = (opts.file || ".env").trim();
  if (file.includes("..") || file.includes("/") || !ENVFILE_RE.test(basename(file))) {
    return { ok: false, error: "target must be a .env file in the repo root" };
  }
  const full = inDir(opts.worktree, file);
  if (!full) return { ok: false, error: "path escapes repo" };

  const { ignored, tracked } = gitChecks(opts.worktree, file);
  if (!ignored && tracked) {
    // Committed file → writing here would stage the secret for commit. Refuse.
    return {
      ok: false,
      error: `${file} is tracked by git — a secret there risks being committed. Untrack it first (git rm --cached ${file}) or choose a gitignored file.`,
    };
  }
  let addedToGitignore = false;
  if (!ignored) {
    // Untracked & unignored → guarantee it can never be committed before writing.
    try {
      const gi = join(opts.worktree, ".gitignore");
      const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
      const has = cur.split("\n").some((l) => l.trim() === file || l.trim() === "/" + file);
      if (!has) {
        writeTextAtomicKeepMode(gi, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + file + "\n");
        addedToGitignore = true;
      }
    } catch {
      return { ok: false, error: "could not update .gitignore to protect the secret — refusing to write" };
    }
  }

  const action = spliceWrite(full, key, opts.value);
  return {
    ok: true,
    key,
    file,
    action,
    masked: maskSecret(opts.value),
    gitignored: ignored || addedToGitignore,
    addedToGitignore,
  };
}

/** List dotenv files in the worktree root (names + git flags only — NO contents). */
export function listEnvFiles(worktree: string): EnvFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(worktree).filter((n) => {
      if (!ENVFILE_RE.test(n)) return false;
      try {
        return statSync(join(worktree, n)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const { ignored, tracked } = gitChecks(worktree, name);
      return { name, gitignored: ignored, tracked, template: ENV_TEMPLATE_RE.test(name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
