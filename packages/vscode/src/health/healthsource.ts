/**
 * Which series a folder's Health tab reads: the extension's own (global storage, written by its
 * `update`) or the one the waterplane desktop host keeps in the folder (`<folder>/.waterplane/
 * repohealth.jsonl`, plus `repohealth.<slugFor(scope)>.jsonl` per scope listed in
 * `repohealth-scopes.json`). The folder's files are READ, never written: only `status` and `plot`
 * ever see them (`healthstate.ts` shim, `READ_FROM`), `update` and `mendTail` stay on our own file.
 *
 * The rule: when both exist, the one whose last row is the newer commit wins (`ts`); a tie or a
 * last row that cannot be read goes to the folder's, which the host keeps fresh. A scope has no
 * series of our own, so it is only ever read from the folder.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
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
const TAIL_CAP = 4 * 1024 * 1024;

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

/** `ts` (unix seconds) of the file's last whole row, or null. Reads the tail only. */
export function lastRowTs(file: string): number | null {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    let want = 64 * 1024;
    for (;;) {
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      // The first segment may be cut by the window; trust it only when the window is the whole file.
      const usable = len === size ? lines : lines.slice(1);
      const last = usable.map((l) => l.trim()).filter(Boolean).pop();
      if (last !== undefined) {
        try {
          const ts = (JSON.parse(last) as { ts?: unknown }).ts;
          return typeof ts === "number" && Number.isFinite(ts) ? ts : null;
        } catch { return null; }
      }
      if (len === size || want >= TAIL_CAP) return null;
      want *= 4;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Where a read of `folder` (and `scope`) comes from. `ownFile` is our global-storage series for the
 * folder. A scope the folder has no series for falls back to the whole repo.
 */
export function chooseSource(folder: string, ownFile: string, scope: string | null): HealthSource {
  if (scope) {
    const dir = repoSeriesDir(folder, scope);
    if (dir) return { kind: "repo", file: join(dir, seriesName(scope)), dir, scope };
  }
  const dir = repoSeriesDir(folder);
  if (dir) {
    const file = join(dir, seriesName(null));
    if (nonEmpty(ownFile)) {
      const theirs = lastRowTs(file), mine = lastRowTs(ownFile);
      if (theirs !== null && mine !== null && mine > theirs) return { kind: "own", file: ownFile, dir: null, scope: null };
    }
    return { kind: "repo", file, dir, scope: null };
  }
  return { kind: "own", file: ownFile, dir: null, scope: null };
}
