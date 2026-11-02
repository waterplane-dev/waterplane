/**
 * Which series a folder's Health tab reads: the extension's own (global storage, written by its
 * `update`) or the one the waterplane desktop host keeps in the folder (`<folder>/.waterplane/
 * repohealth.jsonl`, plus `repohealth.<slugFor(scope)>.jsonl` per scope listed in
 * `repohealth-scopes.json`). The folder's files are READ, never written: only `status` and `plot`
 * ever see them (`healthstate.ts` shim, `READ_FROM`), `update` and `mendTail` stay on our own file.
 *
 * The rule is ONE source, never a merge: when the folder has a series of its own, that file is the
 * one shown, always — it is the file the phone reads, so the two can never show different numbers.
 * The extension's own copy is used only for a folder the desktop app has never measured, and an
 * update is never run beside the folder's series (`healthrun.ts`). A scope has no series of our
 * own, so it is only ever read from the folder.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { STATE_DIRS } from "../shims/healthstate.js";
// @ts-expect-error -- plain JS with no declarations; esbuild bundles it (as healthworker.ts does the engine).
import { normalizeScope, slugFor } from "../../../../tools/repohealth/scope.mjs";

export type HealthSourceKind = "repo" | "own";
export interface HealthSource {
  kind: HealthSourceKind;
  /** The file the engine reads. */
  file: string;
  /** The folder's state dir the engine reads from (kind "repo"); null for our own. */
  dir: string | null;
  /** The scope read (repo only); null = the whole repo. */
  scope: string | null;
}

const MAX_SCOPES = 8;

const nonEmpty = (f: string): boolean => {
  try { return statSync(f).size > 0; } catch { return false; }
};

/** `repohealth.jsonl`, or the scope's `repohealth.<slug>.jsonl`. */
export const seriesName = (scope: string | null): string => (scope ? `repohealth.${slugFor(scope) as string}.jsonl` : "repohealth.jsonl");

/** The folder's state dir holding a non-empty series for `scope` (current name first, then legacy ones), or null. */
export function repoSeriesDir(folder: string, scope: string | null = null): string | null {
  const name = seriesName(scope);
  for (const d of STATE_DIRS) {
    const dir = join(folder, d);
    if (nonEmpty(join(dir, name))) return dir;
  }
  return null;
}

/** The scopes the host measures for this folder that have a series to read. Absent or garbage = none. */
export function readScopes(folder: string): string[] {
  for (const d of STATE_DIRS) {
    const f = join(folder, d, "repohealth-scopes.json");
    if (!existsSync(f)) continue;
    let list: unknown;
    try {
      const raw: unknown = JSON.parse(readFileSync(f, "utf8"));
      list = Array.isArray(raw) ? raw : (raw as { scopes?: unknown } | null)?.scopes;
    } catch { return []; }
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const v of list) {
      if (typeof v !== "string") continue;
      let s: string;
      try { s = normalizeScope(v) as string; } catch { continue; }
      if (!s || s.startsWith("/") || s.split("/").some((p) => p === "" || p === "." || p === "..")) continue;
      if (!out.includes(s) && repoSeriesDir(folder, s)) out.push(s);
      if (out.length >= MAX_SCOPES) break;
    }
    return out;
  }
  return [];
}

/**
 * Where a read of `folder` (and `scope`) comes from. `ownFile` is our global-storage series for the
 * folder, read only when the folder holds no series of its own. A scope the folder has no series
 * for falls back to the whole repo.
 */
export function chooseSource(folder: string, ownFile: string, scope: string | null): HealthSource {
  if (scope) {
    const dir = repoSeriesDir(folder, scope);
    if (dir) return { kind: "repo", file: join(dir, seriesName(scope)), dir, scope };
  }
  const dir = repoSeriesDir(folder);
  if (dir) return { kind: "repo", file: join(dir, seriesName(null)), dir, scope: null };
  return { kind: "own", file: ownFile, dir: null, scope: null };
}

/**
 * The root of the git work tree holding `start` (a file or a directory): the nearest ancestor with a
 * `.git` entry — a directory, or the file a linked worktree or submodule has. Null when there is
 * none up to the filesystem root. A filesystem walk, not `git rev-parse`: the extension itself
 * starts no process.
 */
export function gitRootOf(start: string): string | null {
  let dir = resolve(start);
  try { if (!statSync(dir).isDirectory()) dir = dirname(dir); } catch { dir = dirname(dir); }
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
