/**
 * The probe's leak check: a tool input that reaches outside the scratch worktree (the person's
 * memory excepted — that is the setup working) or names the answer key makes the whole result
 * void. Pure; paths are POSIX-normalised here so it runs on the phone too.
 */
import { PROBE_POOL_PATH } from "./pool.js";

/** `a/b/../c` → `a/c`; keeps a leading `/`. */
export function normalizePosix(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!abs) out.push(".."); continue; }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

const inside = (p: string, dir: string): boolean => {
  // normalizePosix never leaves a trailing slash (it joins non-empty segments).
  const d = normalizePosix(dir);
  return p === d || p.startsWith(`${d}/`);
};

/** The input fields that name a place on disk, across the read-only tools. */
const PATH_FIELDS = ["path", "file_path", "notebook_path", "dir", "directory", "cwd"];

export interface LeakScope {
  /** The scratch worktree (every spelling of it: as made and its realpath). */
  readonly worktrees: readonly string[];
  /** Directories outside it that are part of the setup (the person's memory). */
  readonly allowed: readonly string[];
  /** The home directory, for a `~/` path. */
  readonly home?: string;
}

/**
 * Why this tool input leaks, or null. Relative paths resolve against the worktree. A Glob or Grep
 * `pattern` is checked only when it is itself an absolute path or climbs out with `..`.
 */
export function probeLeakOf(tool: { name: string; input: unknown }, scope: LeakScope): string | null {
  const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {};
  const text = JSON.stringify(input) ?? "";
  if (text.includes(PROBE_POOL_PATH) || /probe\.json/i.test(text)) return `${tool.name} named the answer key (${PROBE_POOL_PATH})`;
  const base = scope.worktrees[0] ?? "/";
  const check = (raw: string, field: string): string | null => {
    let p = raw.trim();
    if (!p) return null;
    if (p.startsWith("~/") && scope.home) p = `${scope.home}/${p.slice(2)}`;
    const abs = normalizePosix(p.startsWith("/") ? p : `${base}/${p}`);
    if (scope.worktrees.some((w) => inside(abs, w))) return null;
    if (scope.allowed.some((d) => inside(abs, d))) return null;
    return `${tool.name} ${field} reached outside the worktree: ${raw.slice(0, 160)}`;
  };
  for (const f of PATH_FIELDS) {
    const v = input[f];
    if (typeof v === "string") { const l = check(v, f); if (l) return l; }
  }
  // Glob's pattern is a path; Grep's is a regex ("/api/hook" is a search, not a place).
  const pat = input.pattern;
  if (tool.name === "Glob" && typeof pat === "string" && (pat.startsWith("/") || pat.startsWith("~/") || pat.split("/").includes(".."))) {
    // Only the literal head, up to the first wildcard segment, is a place.
    const segs = pat.split("/");
    const cut = segs.findIndex((s) => /[*?[{]/.test(s));
    const head = (cut < 0 ? segs : segs.slice(0, cut)).join("/");
    const l = check(head || "/", "pattern");
    if (l) return l;
  }
  return null;
}
