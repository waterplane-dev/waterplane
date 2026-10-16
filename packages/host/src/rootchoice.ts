/**
 * The code root a person chose themselves — in the phone's one-time "which folder holds your
 * repos?" dialog, or later in Settings — kept in `<config dir>/root.json`.
 *
 *  - **Precedence: the knob, then this file, then the automatic pick.** `WATERPLANE_ROOT` in
 *    the environment (shell, service `--env`, Docker) always wins: whoever set it there meant it,
 *    and the dialog never appears for a named root. The file only replaces the GUESS.
 *  - **In the per-user config dir, not the state dir and not a `.env`.** It is read at boot,
 *    before any `.env` loads and before the legacy `<ROOT>/.waterplane` state move — both of
 *    which need the root first. `configDir()` depends on nothing but the environment, so
 *    reading it here is not circular. And NOT a key in the host `.env` that `POST /api/secret`
 *    writes: that route has no tier gate, and the root decides what the phone can reach.
 *  - **Read once at boot.** `ROOT` is a module-level constant handed to ~30 constructors, so a
 *    change takes a restart. Under launchd/systemd the route exits and the supervisor brings the
 *    host back with the new root; started by hand, the person is told to restart it.
 *  - **Only the trusted path writes it** (`AuthManager.canManage`: loopback + Tailscale, never
 *    LAN) — the same rule as the LAN password.
 *
 * Imported by `env.ts` before anything else runs, so this module stays env-free: node, `branddirs`
 * and `jsonstore` only. Counting repos (which reads knobs) is the route's job.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BRAND, LEGACY } from "@waterplane/shared";
import { CODE_FOLDERS, configDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

export const ROOT_CHOICE_FILE = "root.json";

/** `<config dir>/root.json`. */
export function rootChoicePath(): string {
  return join(configDir(), ROOT_CHOICE_FILE);
}

/** The stored root, or undefined when there is none (absent, corrupt, or not absolute). Never throws. */
export function readChosenRoot(path: string = rootChoicePath()): string | undefined {
  const doc = readJsonGuarded<{ root?: unknown }>(path, {}, (v) => !!v && typeof v === "object" && !Array.isArray(v));
  const r = typeof doc.root === "string" ? doc.root.trim() : "";
  return r && isAbsolute(r) ? r : undefined;
}

export function writeChosenRoot(root: string, path: string = rootChoicePath()): void {
  writeJsonAtomic(path, { root, chosenAt: new Date().toISOString() });
}

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * A typed folder, made absolute (`~` and `~/x` expand to the home) and checked: a directory that
 * exists, and not the top of a disk. The error is a sentence the phone shows as is.
 */
export function cleanRootInput(input: unknown, home: string = homedir()): { ok: true; root: string } | { ok: false; error: string } {
  let p = typeof input === "string" ? input.trim() : "";
  if (!p) return { ok: false, error: "Type the folder that holds your repos." };
  if (p === "~") p = home;
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = join(home, p.slice(2));
  if (!isAbsolute(p)) return { ok: false, error: `Use a full path, e.g. ${join(home, "dev")}.` };
  p = resolve(p);
  if (dirname(p) === p) return { ok: false, error: "Not the whole disk — pick the folder your repos are in." };
  if (!isDir(p)) return { ok: false, error: `${p} is not a folder on this desktop.` };
  return { ok: true, root: p };
}

/** The usual code folders that exist under the home — what the dialog offers before anyone types. */
export function rootCandidates(home: string = homedir(), platform: NodeJS.Platform = process.platform): string[] {
  // Same macOS exception as `pickCodeRoot`: touching ~/Documents raises a privacy prompt.
  const rels = platform === "darwin" ? CODE_FOLDERS.filter((r) => !r.startsWith("Documents/")) : CODE_FOLDERS;
  return rels.map((r) => resolve(home, r)).filter(isDir);
}

/**
 * Which supervisor brings this process back after a clean exit, or null when nothing will.
 * Asked narrowly on purpose — a false yes means the host exits and stays down:
 * launchd names the job in `XPC_SERVICE_NAME`; a systemd unit's cgroup ends in the unit name.
 * (`INVOCATION_ID` alone is not enough: a shell in a terminal that runs as a user service has it.)
 */
export function hostSupervisor(e: NodeJS.ProcessEnv = process.env, readCgroup: () => string = defaultCgroup): "launchd" | "systemd" | null {
  const labels = [BRAND.launchdLabel, ...LEGACY.map((l) => l.launchdLabel)];
  if (e.XPC_SERVICE_NAME && labels.includes(e.XPC_SERVICE_NAME)) return "launchd";
  const units = [BRAND.slug, ...LEGACY.map((l) => l.slug)].map((s) => `/${s}.service`);
  const cg = readCgroup();
  if (cg && cg.split("\n").some((line) => units.some((u) => line.trimEnd().endsWith(u)))) return "systemd";
  return null;
}

function defaultCgroup(): string {
  if (process.platform !== "linux") return "";
  try { return readFileSync("/proc/self/cgroup", "utf8"); } catch { return ""; }
}
