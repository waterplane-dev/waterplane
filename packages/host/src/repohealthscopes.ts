/**
 * Which subtrees of a repo get their own readings — the user's list, per repo.
 *
 * ── Why this is stored and not derived ──────────────────────────────────────
 *
 * The engine can measure any directory (`--scope=`), and the groups it derives
 * are a fine list of CANDIDATES — but measuring all of them is not free: every
 * scope is its own backfill over the commits that touched it, and a monorepo
 * with eighteen apps would turn one refresh into eighteen. Which parts are
 * worth their own series is a judgement about what somebody is working on, and
 * this repo's rule is that nothing applies itself: the tool offers what it
 * found, a person picks, and the picks are what get measured.
 *
 * ── Why it lives in the repo's own state dir ─────────────────────────────────
 *
 * Beside the series files it selects. A scope list keyed by repo id in one
 * central file outlives the repo it describes — rename the directory, or drop
 * it from the fleet, and the entry stays behind pointing at nothing. Here it
 * goes with the repo, and the two facts about a repo's readings (which
 * subtrees, and the rows for each) sit in one directory.
 *
 * It is NOT in the tree that gets committed: the state dir is this tool's own
 * scratch directory, like the series it holds.
 *
 * ── What a scope is allowed to be ───────────────────────────────────────────
 *
 * A repo-relative directory path, checked here the way `paths.ts` checks every
 * other path this daemon takes from a client: no absolute path, no `..`, no
 * leading slash. The engine normalises again on its own side — two checks, not
 * one, because this file writes what the daemon will later hand to a spawn.
 */
import { writeJsonAtomic } from "./jsonstore.js";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoStateDir } from "./branddirs.js";

/** The most scopes one repo may carry. A cap, not a policy: every scope is a
 *  backfill and a refresh runs them in series, so a list nobody meant to type
 *  must not become a run nobody meant to start. */
export const MAX_SCOPES = 8;

const fileFor = (wt: string): string => join(repoStateDir(wt), "repohealth-scopes.json");

/**
 * A scope as this daemon will store and spawn it, or null when it is not one.
 *
 * Containment is asserted against the worktree itself rather than by string
 * rules alone: the resolved path must still be inside `wt` and must be a
 * directory that exists. A scope naming a file, or a symlink out of the tree,
 * is not a subtree of this repo however it is spelled.
 */
export function cleanScope(wt: string, raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!s || s.startsWith("/")) return null;
  if (s.split("/").some((p) => p === "" || p === "." || p === "..")) return null;
  const abs = resolve(wt, s);
  const root = resolve(wt);
  if (abs === root || !abs.startsWith(`${root}/`)) return null;
  try {
    if (!statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return s;
}

/** The scopes configured for a worktree, in the order they were stored, with
 *  anything that is no longer a directory dropped — a scope whose folder was
 *  renamed is not a reading, and its stale series file says so on its own. */
export function readScopes(wt: string): string[] {
  try {
    const path = fileFor(wt);
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { scopes?: unknown })?.scopes;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const v of list) {
      const s = cleanScope(wt, v);
      if (s && !out.includes(s)) out.push(s);
      if (out.length >= MAX_SCOPES) break;
    }
    return out;
  } catch {
    // Unreadable or corrupt is the same as none: a repo whose scope list cannot
    // be parsed still has a repo-wide series, and taking the sheet down over it
    // would hide the readings that do exist.
    return [];
  }
}

/**
 * Replace the list. Returns what was actually stored, which is what the client
 * must render — a scope it asked for and this dropped is a row it would
 * otherwise keep drawing.
 */
export function writeScopes(wt: string, scopes: readonly unknown[]): string[] {
  const clean: string[] = [];
  for (const v of scopes) {
    const s = cleanScope(wt, v);
    if (s && !clean.includes(s)) clean.push(s);
    if (clean.length >= MAX_SCOPES) break;
  }
  try {
    const path = fileFor(wt);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, { scopes: clean }, { space: 2, newline: true });
  } catch {
    // The list is a convenience; a disk that will not take it is not a reason
    // to fail the request. The caller still gets what would have been stored.
  }
  return clean;
}
