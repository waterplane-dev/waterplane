/**
 * Browse the worktree as a TREE, and write one file back.
 *
 * The gallery answers "what did an agent leave me" — a flat, mtime-sorted list
 * of DELIVERABLES, which is why `files.ts` keeps source and config extensions
 * out of discovery (`SERVE_ONLY_EXT`). This module answers the other question:
 * "what is actually in this repo, right now", which is a directory at a time,
 * every extension, dotfiles included.
 *
 * Listing is LAZY — one directory per request, never a recursive walk — so the
 * cost of opening `node_modules` is one `readdir`, not a tree traversal. The
 * one recursive path is the name search (`q`), and it uses `files.ts`'s own
 * SKIP_DIRS: a phone searching for `outbox.ts` does not mean the copy inside
 * `node_modules/.cache`.
 *
 * Writing is the sharp edge. Rules, all enforced here:
 *  - the path is contained in the worktree and is never a dotenv file
 *    (same promise `git.ts` `readTextFile` makes — the secret sheet writes
 *    those and swears they never come back);
 *  - the file must ALREADY EXIST — this is an editor, not a file creator;
 *  - the caller must present `baseSha`, the sha256 of the text it opened, and a
 *    mismatch is refused `stale` with nothing written. An agent editing the
 *    same file between open and save is the NORMAL case here, not the exotic
 *    one, and a last-write-wins editor would silently delete its work;
 *  - a body we could not have shown in full (binary, or past `MAX_EDIT_BYTES`)
 *    has no `sha` in the read response, so the write can't be armed at all.
 *
 * There is deliberately no queued/offline write path: a save composed at 09:00
 * and replayed at 11:00 carries a base the file left behind long ago, and the
 * only honest verdict for it is the `stale` refusal it would get anyway. The
 * client disables saving when the link is down and says why.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { BRAND } from "@waterplane/shared";
import { isSecretFile } from "./git.js";
import { SKIP_DIRS } from "./files.js";
import { contained } from "./paths.js";
import { execFileP as exec } from "./proc.js";

/** `git`, with a body on stdin. `check-ignore` exits 1 for "nothing matched",
 *  which is a normal answer here, so the exit code is ignored and stdout is
 *  the whole result. */
function gitStdin(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((done) => {
    let out = "";
    try {
      const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => { out += d; });
      child.on("error", () => done(""));
      child.on("close", () => done(out));
      child.stdin.on("error", () => { /* closed early — out is what we got */ });
      child.stdin.end(input);
    } catch { done(""); }
  });
}

/** Text past this is shown read-only (and un-editable — see `sha` below). */
export const MAX_EDIT_BYTES = 512 * 1024;
/** Entries returned for one directory. A generated folder can hold thousands. */
const MAX_ENTRIES = 2000;
/** Hits returned by the recursive name search. */
const MAX_HITS = 300;
/** Directories we won't count children of — the count is a `readdir` each. */
const HEAVY = new Set([...SKIP_DIRS, ".cache", "vendor", "Pods"]);

export interface TreeEntry {
  name: string;
  /** Worktree-relative, forward slashes. Same shape the agent references. */
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  /** Directories only: how many entries inside. Omitted for heavy dirs. */
  count?: number;
  /** Git porcelain code (`M`, `??`, `A`…) for this path, or the worst one under
   *  a directory. Absent = clean. */
  status?: string;
  /** Matched by a gitignore rule. Shown dimmed, never hidden — a build output
   *  is exactly the file you want to read from a phone. */
  ignored?: boolean;
  /** Symlink. Followed for stat, but never descended blindly by the search. */
  link?: boolean;
}

export interface TreeListing {
  /** The directory listed, worktree-relative. "" is the worktree root. */
  path: string;
  entries: TreeEntry[];
  /** More than MAX_ENTRIES / MAX_HITS existed. */
  truncated: boolean;
  /** Set on a search response — `entries` are then hits from anywhere. */
  query?: string;
}

/** Resolve a worktree-relative path, refusing anything that escapes. */
export function inTree(wt: string, rel: string): string | null {
  return contained(wt, rel || ".");
}

const relOf = (root: string, full: string) => relative(root, full).split(sep).join("/");

/**
 * Git's opinion of a directory's contents, in one process each.
 *
 * `status` is the whole worktree's porcelain (cheap, and a directory row wants
 * the worst code UNDER it, which needs more than the current level anyway).
 * `ignored` is asked per listing with `check-ignore --stdin`, because the
 * alternative — `status --ignored` — enumerates every file in `node_modules`.
 */
async function gitMarks(wt: string, names: string[]): Promise<{
  status: Map<string, string>;
  ignored: Set<string>;
}> {
  const status = new Map<string, string>();
  const ignored = new Set<string>();
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: wt, maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split("\n")) {
      if (line.length < 4) continue;
      const code = line.slice(0, 2).trim() || "?";
      let p = line.slice(3).trim();
      if (p.includes(" -> ")) p = p.split(" -> ")[1];      // rename: mark the destination
      p = p.replace(/^"|"$/g, "").replace(/\/$/, "");       // quoted paths, untracked dir trailing /
      status.set(p, code);
    }
  } catch { /* not a repo, or git missing — marks are decoration, not function */ }
  if (names.length) {
    const out = await gitStdin(wt, ["check-ignore", "--stdin"], names.join("\n"));
    for (const line of out.split("\n")) if (line.trim()) ignored.add(line.trim());
  }
  return { status, ignored };
}

/**
 * The status code for a row: its own, or the worst one under it for a folder.
 *
 * The ancestor walk is not a nicety. `git status --porcelain` COLLAPSES a
 * wholly-untracked directory to one `?? src/` line, so a brand-new file would
 * come back unmarked while the folder above it says "new" — the confusing half
 * of a fresh repo. Asking git for `--untracked-files=all` instead would fix
 * that by enumerating every file in an un-ignored `node_modules`.
 */
function statusFor(rel: string, dir: boolean, status: Map<string, string>): string | undefined {
  const own = status.get(rel);
  if (own) return own;
  for (let cut = rel.lastIndexOf("/"); cut > 0; cut = rel.lastIndexOf("/", cut - 1)) {
    const anc = status.get(rel.slice(0, cut));
    if (anc === "??") return anc;   // only untracked collapses; a modified dir does not exist
  }
  if (!dir) return undefined;
  const prefix = rel + "/";
  for (const [p, code] of status) if (p.startsWith(prefix)) return code;
  return undefined;
}

/** One directory's entries, dirs first then files, each alphabetical. */
export async function listDir(wt: string, rel: string): Promise<TreeListing | null> {
  const root = resolve(wt);
  const full = inTree(root, rel);
  if (!full || !existsSync(full)) return null;
  let st;
  try { st = statSync(full); } catch { return null; }
  if (!st.isDirectory()) return null;

  let names: string[];
  try { names = readdirSync(full); } catch { return null; }
  const truncated = names.length > MAX_ENTRIES;
  names = names.sort((a, b) => a.localeCompare(b)).slice(0, MAX_ENTRIES);

  const dirRel = relOf(root, full);
  const paths = names.map((n) => (dirRel ? `${dirRel}/${n}` : n));
  const { status, ignored } = await gitMarks(root, paths);

  const entries: TreeEntry[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const p = paths[i];
    const child = join(full, name);
    let cst;
    try { cst = statSync(child); } catch {
      // Broken symlink — still worth showing, since it explains a build failure.
      entries.push({ name, path: p, dir: false, size: 0, mtime: 0, link: true });
      continue;
    }
    const isDir = cst.isDirectory();
    let count: number | undefined;
    if (isDir && !HEAVY.has(name)) {
      try { count = readdirSync(child).length; } catch { /* unreadable — no count */ }
    }
    // `statSync` follows the link (that is what we want for size/mtime), so the
    // link itself has to be asked about separately.
    let link = false;
    try { link = lstatSync(child).isSymbolicLink(); } catch { /* ignore */ }
    const code = statusFor(p, isDir, status);
    entries.push({
      name, path: p, dir: isDir,
      size: isDir ? 0 : cst.size,
      mtime: cst.mtimeMs,
      ...(count != null ? { count } : {}),
      ...(code ? { status: code } : {}),
      ...(ignored.has(p) ? { ignored: true } : {}),
      ...(link ? { link: true } : {}),
    });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: dirRel, entries, truncated };
}

/**
 * Recursive filename search from `rel` down. Case-insensitive substring against
 * the path, so `web/api` finds `packages/web/src/api.ts`. SKIP_DIRS are not
 * walked: the answer nobody wants is fifty copies inside `node_modules`.
 */
export async function searchTree(wt: string, rel: string, query: string): Promise<TreeListing | null> {
  const root = resolve(wt);
  const start = inTree(root, rel);
  if (!start || !existsSync(start)) return null;
  const q = query.trim().toLowerCase();
  if (!q) return { path: relOf(root, start), entries: [], truncated: false, query };

  const hits: TreeEntry[] = [];
  let truncated = false;
  const stack = [start];
  while (stack.length && !truncated) {
    const dir = stack.pop()!;
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const child = join(dir, name);
      let cst;
      try { cst = statSync(child); } catch { continue; }
      const p = relOf(root, child);
      if (cst.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(child);
        continue;
      }
      if (!p.toLowerCase().includes(q)) continue;
      hits.push({ name, path: p, dir: false, size: cst.size, mtime: cst.mtimeMs });
      if (hits.length > MAX_HITS) { truncated = true; break; }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  const { status } = await gitMarks(root, []);
  for (const h of hits) { const c = status.get(h.path); if (c) h.status = c; }
  return { path: relOf(root, start), entries: hits.slice(0, MAX_HITS), truncated, query };
}

export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
  /** Absent when the file is binary. */
  body?: string;
  /**
   * sha256 of the bytes on disk — the base a save must present. Deliberately
   * ABSENT whenever `body` is not the whole file (binary, or truncated), which
   * is what makes an un-showable file un-savable: the write route refuses
   * without it, so a truncated buffer can never be written back over the rest.
   */
  sha?: string;
  binary?: boolean;
  truncated?: boolean;
  /** Convenience for the client — `sha != null && !binary && !truncated`. */
  editable: boolean;
}

export const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

/** Read a file for viewing/editing. `null` = missing, escaped, or a dotenv. */
export function readTreeFile(wt: string, rel: string): TreeFile | null {
  const root = resolve(wt);
  const full = inTree(root, rel);
  if (!full || isSecretFile(rel)) return null;
  let st;
  try { st = statSync(full); } catch { return null; }
  if (!st.isFile()) return null;
  const path = relOf(root, full);
  let buf: Buffer;
  try { buf = readFileSync(full); } catch { return null; }
  if (buf.subarray(0, 8192).includes(0)) {
    return { path, size: st.size, mtime: st.mtimeMs, binary: true, editable: false };
  }
  if (buf.length > MAX_EDIT_BYTES) {
    return {
      path, size: st.size, mtime: st.mtimeMs, truncated: true, editable: false,
      body: buf.subarray(0, MAX_EDIT_BYTES).toString("utf8"),
    };
  }
  return { path, size: st.size, mtime: st.mtimeMs, body: buf.toString("utf8"), sha: sha256(buf), editable: true };
}

export type WriteResult =
  | { ok: true; sha: string; mtime: number; size: number }
  | { ok: false; error: string; code: "stale" | "missing" | "refused" | "toobig" | "failed"; sha?: string };

/**
 * Write a file back, only over the exact bytes the caller last read.
 *
 * tmp+rename in the SAME directory (atomic on the filesystem, same convention
 * as every other persisted file here), with the original mode carried over —
 * a rename installs the tmp file's inode, so an executable script silently
 * loses its +x otherwise.
 */
export function writeTreeFile(wt: string, rel: string, body: string, baseSha: string): WriteResult {
  const root = resolve(wt);
  const full = inTree(root, rel);
  if (!full) return { ok: false, error: "path escapes the worktree", code: "refused" };
  if (isSecretFile(rel)) return { ok: false, error: "this app never writes .env files — see the secrets sheet", code: "refused" };
  if (!baseSha) return { ok: false, error: "no base revision — reopen the file and try again", code: "refused" };
  if (Buffer.byteLength(body, "utf8") > MAX_EDIT_BYTES) return { ok: false, error: "too large to save from here", code: "toobig" };

  let st;
  try { st = statSync(full); } catch { return { ok: false, error: "file no longer exists", code: "missing" }; }
  if (!st.isFile()) return { ok: false, error: "not a file", code: "refused" };

  let current: Buffer;
  try { current = readFileSync(full); } catch { return { ok: false, error: "could not read the file", code: "failed" }; }
  const now = sha256(current);
  if (now !== baseSha) {
    return { ok: false, error: "changed on disk since you opened it", code: "stale", sha: now };
  }

  const tmp = join(dirname(full), `.${BRAND.slug}-write-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, body, "utf8");
    try { chmodSync(tmp, st.mode & 0o7777); } catch { /* best effort — mode is not correctness */ }
    renameSync(tmp, full);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: String((err as Error)?.message || err), code: "failed" };
  }
  const after = statSync(full);
  return { ok: true, sha: sha256(Buffer.from(body, "utf8")), mtime: after.mtimeMs, size: after.size };
}
