/**
 * `api.sessionFiles` — the directory the host wrote a session's launch `files` into
 * (`<state dir>/launch/<hostSessionId>/`, backend v2 WP3), but only for a session THIS plugin's
 * backend spawned, and only if it exists. Anything else is null: a plugin never learns another
 * backend's directory, and an id with a separator never reaches the filesystem.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FilesSessions {
  get(id: string): { backend?: string } | null | undefined;
}

export function sessionFilesDir(sessions: FilesSessions, stateDir: string, backends: ReadonlySet<string>, hostSessionId: string): string | null {
  if (typeof hostSessionId !== "string" || !/^[A-Za-z0-9._-]+$/.test(hostSessionId) || hostSessionId.includes("..")) return null;
  const s = sessions.get(hostSessionId);
  const b = s?.backend;
  if (!s || !b || !backends.has(b)) return null;
  const dir = join(stateDir, "launch", hostSessionId);
  try { return existsSync(dir) && statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}
