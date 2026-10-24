/**
 * The files a launch's plan asks the HOST to write before the spawn (`LaunchPlan.files`),
 * and the `session:` names its `env` may point at them by.
 *
 * Why the host writes them and the plugin does not: a CLI that takes its instructions from a
 * DIRECTORY (Copilot 1.0.91 reads `<dir>/AGENTS.md` off `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`,
 * measured 2026-10-21) needs a file that exists for exactly one session, and the only safe
 * place for that is one the host owns and sweeps: `<state dir>/launch/<hostSessionId>/`. Never
 * the repo (a stray `AGENTS.md` there is a change somebody commits) and never `~/.<cli>`
 * (another program's config, which this app must not edit). An absolute path is accepted only
 * inside the plugin's own `dataDir`, realpath-contained, no symlink on the way.
 *
 * Everything is checked BEFORE anything is written, so a refused plan writes nothing and the
 * create is refused in the sentence (`durableOp` remembers it).
 */
import { mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { hostStateDir } from "./branddirs.js";
import { writeTextAtomic } from "./jsonstore.js";
import type { BackendDescriptor, LaunchFile, LaunchPlan } from "./backends/types.js";

/** `session:<name>` — a path inside this session's own launch dir. */
export const SESSION_PREFIX = "session:";
/** A plan names a handful of files, not a tree. */
export const LAUNCH_FILES_MAX = 16;
/** One file's text; the repo-facing instructions are ~10 KB. */
export const LAUNCH_FILE_MAX_BYTES = 1024 * 1024;
/** A launch dir outlives its session this long before the boot sweep takes it (as `history/`). */
export const LAUNCH_DIR_MAX_AGE_MS = 7 * 24 * 3600_000;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** What an environment variable's NAME may be — a plan's `env` key, a `dropEnv` name (`sessions/tmux.ts`). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `<state dir>/launch` — every session's launch dir lives under it. */
export function launchRoot(root: string): string {
  return join(hostStateDir(root), "launch");
}

/** `<state dir>/launch/<hostSessionId>` — null for an id that is not a plain id. */
export function launchDir(root: string, hostSessionId: string): string | null {
  return ID_RE.test(hostSessionId) ? join(launchRoot(root), hostSessionId) : null;
}

/** A relative name under the launch dir, or null when it would leave it (`..`, absolute, empty). */
function sessionRel(name: string): string | null {
  if (!name || name.includes("\0") || isAbsolute(name) || name.includes("\\")) return null;
  const n = normalize(name);
  if (n === "." || n.startsWith("..") || n.split(sep).includes("..")) return null;
  return n;
}

/** Is `p` inside `dir` (both already resolved)? */
const inside = (dir: string, p: string): boolean => {
  const r = relative(dir, p);
  return !!r && !r.startsWith("..") && !isAbsolute(r);
};

/** The deepest existing ancestor of `p`, realpath-resolved, with the rest re-appended. */
function realish(p: string): string {
  let cur = p; const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { /* not there yet */ }
    const up = dirname(cur);
    if (up === cur) return p;
    rest.push(cur.slice(up.length).replace(/^[/\\]+/, ""));
    cur = up;
  }
}

/**
 * Where each file of a plan goes, or the sentence refusing the WHOLE plan. Pure but for
 * realpath lookups; writes nothing.
 */
export function resolveLaunchFiles(
  files: readonly LaunchFile[] | undefined,
  where: { launchDir: string | null; dataDir?: string; who: string },
): { ok: true; writes: { abs: string; content: string; mode: number }[] } | { ok: false; reason: string } {
  const list = files ?? [];
  if (!list.length) return { ok: true, writes: [] };
  if (!Array.isArray(list)) return { ok: false, reason: `${where.who} answered its launch files as something other than a list` };
  if (list.length > LAUNCH_FILES_MAX) return { ok: false, reason: `${where.who} asked for ${list.length} launch files; at most ${LAUNCH_FILES_MAX} are written` };
  const writes: { abs: string; content: string; mode: number }[] = [];
  const dataReal = where.dataDir ? realish(where.dataDir) : null;
  for (const f of list) {
    const path = f && typeof f.path === "string" ? f.path : "";
    if (!f || typeof f.content !== "string") return { ok: false, reason: `${where.who}'s launch file ${JSON.stringify(path)} has no text` };
    if (Buffer.byteLength(f.content) > LAUNCH_FILE_MAX_BYTES) return { ok: false, reason: `${where.who}'s launch file ${JSON.stringify(path)} is over ${LAUNCH_FILE_MAX_BYTES} bytes` };
    const mode = typeof f.mode === "number" && Number.isInteger(f.mode) ? f.mode & 0o700 : 0o600;
    let abs: string | null = null;
    if (path.startsWith(SESSION_PREFIX)) {
      const rel = sessionRel(path.slice(SESSION_PREFIX.length));
      if (!rel) return { ok: false, reason: `${where.who}'s launch file ${JSON.stringify(path)} leaves its session's launch dir` };
      if (!where.launchDir) return { ok: false, reason: "this launch has no session dir to write its files into" };
      abs = join(where.launchDir, rel);
    } else if (isAbsolute(path) && dataReal && inside(dataReal, realish(path))) {
      abs = realish(path);
    }
    if (!abs) {
      return { ok: false, reason: `${where.who}'s launch file ${JSON.stringify(path)} is refused: a launch writes only "session:<name>" (this session's own launch dir) or inside the plugin's data dir — never the repo, never the CLI's own config` };
    }
    writes.push({ abs, content: f.content, mode: mode || 0o600 });
  }
  return { ok: true, writes };
}

/** Write what `resolveLaunchFiles` accepted (`writeTextAtomic`: tmp + rename, mode before bytes —
 *  a rename replaces a planted symlink rather than following it). THROWS on a failed write. */
export function writeLaunchFiles(writes: readonly { abs: string; content: string; mode: number }[], launchDirPath: string | null): void {
  if (launchDirPath && writes.some((w) => inside(launchDirPath, w.abs))) mkdirSync(launchDirPath, { recursive: true, mode: 0o700 });
  for (const w of writes) {
    mkdirSync(dirname(w.abs), { recursive: true, mode: 0o700 });
    writeTextAtomic(w.abs, w.content, { mode: w.mode });
  }
}

/**
 * The plan's `env` with every `session:<name>` item (comma-separated) replaced by its absolute
 * path in the launch dir. An item that would leave the dir THROWS the sentence — the plan is
 * refused, never half-resolved.
 */
export function resolveSessionEnv(env: Readonly<Record<string, string>> | undefined, dir: string | null, who: string): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    // The pane gets `/usr/bin/env K=V …` (`sessions/tmux.ts`): no shell, so a value is safe byte
    // for byte, but a key such as `-u` or `` would be read as an option to env. Refused whole.
    if (!ENV_NAME_RE.test(k)) throw new Error(`${who}'s launch variable ${JSON.stringify(k)} is not a variable name (letters, digits and _, not starting with a digit), so the launch was refused`);
    if (!v.includes(SESSION_PREFIX)) { out[k] = v; continue; }
    out[k] = v.split(",").map((item) => {
      if (!item.startsWith(SESSION_PREFIX)) return item;
      const rel = sessionRel(item.slice(SESSION_PREFIX.length));
      if (!rel || !dir) throw new Error(`${who}'s launch variable ${k} names ${JSON.stringify(item)}, which is not inside its session's launch dir`);
      return join(dir, rel);
    }).join(",");
  }
  return out;
}

/**
 * Delete the launch dirs of sessions that no longer exist, older than `maxAgeMs` — the same rule
 * `sweepSessionStores` holds for `history/` and `summaries/`: a null `alive` (unanswerable this
 * boot) deletes nothing.
 */
export function sweepLaunchDirs(root: string, alive: ReadonlySet<string> | null, now = Date.now(), maxAgeMs = LAUNCH_DIR_MAX_AGE_MS): { deleted: number; kept: number; skipped: boolean } {
  if (!alive) return { deleted: 0, kept: 0, skipped: true };
  const base = launchRoot(root);
  let names: string[];
  try { names = readdirSync(base); } catch { return { deleted: 0, kept: 0, skipped: false }; }
  let deleted = 0, kept = 0;
  for (const name of names) {
    if (!ID_RE.test(name) || alive.has(name)) { kept++; continue; }
    const p = join(base, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isDirectory() || now - st.mtimeMs <= maxAgeMs) { kept++; continue; }
    try { rmSync(p, { recursive: true, force: true }); deleted++; } catch { kept++; }
  }
  return { deleted, kept, skipped: false };
}

/**
 * The plan as the spawn takes it: its files WRITTEN (all checked first — a refused plan writes
 * nothing and THROWS its sentence) and its `env`'s `session:` items resolved. Synchronous, so a
 * core backend's create still spawns before its first `await`. Order (risk §6.2): prepare →
 * files → spawn → persist → register; this is the second step.
 */
export function finishLaunch(backend: Pick<BackendDescriptor, "label" | "dataDir">, plan: LaunchPlan, root: string, hostSessionId: string): LaunchPlan {
  const dir = launchDir(root, hostSessionId);
  const who = backend.label;
  const files = resolveLaunchFiles(plan.files, { launchDir: dir, dataDir: backend.dataDir, who });
  if (!files.ok) throw new Error(files.reason);
  const env = resolveSessionEnv(plan.env, dir, who);
  writeLaunchFiles(files.writes, dir);
  // A plugin's `api.sessionFiles(id)` answers this dir only once it exists: made before the spawn
  // for every plugin backend (the one kind with a `dataDir`), never for a core one with no files.
  if (dir && backend.dataDir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { ...plan, ...(env ? { env } : {}) };
}
