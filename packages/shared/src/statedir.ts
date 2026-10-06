/**
 * Where the host keeps its own global state, and which code root it scans —
 * the PRECEDENCE only, pure, so the daemon (`host/branddirs.ts`), the service
 * installer (`host/cli/service.ts`, which imports nothing from the host) and the
 * doctor cannot word it three different ways.
 *
 *   state: `<PREFIX>STATE_DIR` → `$XDG_STATE_HOME/<name>` → `<home>/.local/state/<name>`
 *   root:  `<PREFIX>ROOT` → `<home>/dev`
 *
 * Blank is unset. A relative value is returned as written: making it absolute
 * needs a cwd, which is the caller's (`path.resolve`). No node imports — this
 * package also ships in the phone bundle.
 */
import { BRAND } from "./brand.js";
import { resolveEnv } from "./envresolve.js";

export type StateDirSource = "env" | "xdg" | "default";

const stripSlash = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

/** The code root when nothing names one: `<home>/dev`. The ONE spelling of that default. */
export function defaultRootOf(home: string): string {
  return `${stripSlash(home)}/dev`;
}

export function rootPick(e: Record<string, string | undefined>, home: string): { root: string; defaulted: boolean } {
  const v = (resolveEnv(e, "ROOT").value ?? "").trim();
  return v ? { root: v, defaulted: false } : { root: defaultRootOf(home), defaulted: true };
}

export function stateDirPick(e: Record<string, string | undefined>, home: string): { dir: string; source: StateDirSource } {
  const o = (resolveEnv(e, "STATE_DIR").value ?? "").trim();
  if (o) return { dir: o, source: "env" };
  const xdg = (e.XDG_STATE_HOME ?? "").trim();
  if (xdg) return { dir: `${stripSlash(xdg)}/${BRAND.configDirName}`, source: "xdg" };
  return { dir: `${stripSlash(home)}/.local/state/${BRAND.configDirName}`, source: "default" };
}
