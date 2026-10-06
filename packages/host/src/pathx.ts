/**
 * Path helpers shared across the host: `~` expansion and the PATH scan.
 * Not `paths.ts` — that is the containment guard and stays small and separate.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Expand a leading `~` or `~/` to the user's home dir; anything else is returned as is. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** An executable regular file. */
export function isExecutable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
}

/** The first executable `name` on `path`, then in `extra` dirs, or null. A file scan — no process is spawned. */
export function onPath(name: string, path = process.env.PATH ?? "", extra: string[] = []): string | null {
  for (const d of [...path.split(delimiter).filter(Boolean), ...extra]) {
    const p = join(d, name);
    if (isExecutable(p)) return p;
  }
  return null;
}
