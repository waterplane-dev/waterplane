/**
 * Where the file browser was last, per repo, so opening Files lands there
 * instead of at the root. A host key: repo ids are that desktop's. A folder
 * deleted since is not checked here — the sheet says it could not read it, and
 * the crumbs are the way out.
 */
import { LS, lsJson, lsSetJson } from "./storage.ts";

export type FilesDirs = Record<string, string>;

export function dirFor(dirs: FilesDirs, repoId: string): string {
  const d = dirs[repoId];
  return typeof d === "string" ? d : "";
}

/** The root is the default, so it is the absence of an entry. */
export function withDir(dirs: FilesDirs, repoId: string, dir: string): FilesDirs {
  const { [repoId]: _old, ...rest } = dirs;
  return dir ? { ...rest, [repoId]: dir } : rest;
}

export const readFilesDir = (repoId: string): string => dirFor(lsJson<FilesDirs>(LS.filesDir, {}), repoId);

export function writeFilesDir(repoId: string, dir: string): void {
  const dirs = lsJson<FilesDirs>(LS.filesDir, {});
  if (dirFor(dirs, repoId) !== dir) lsSetJson(LS.filesDir, withDir(dirs, repoId, dir));
}
