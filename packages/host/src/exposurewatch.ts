/**
 * **The exposure watch's target list, from the phone** — `<state dir>/exposure/targets.json`,
 * the file the daily runner (`tools/exposure*`) reads to know which repos to watch.
 *
 * This module is the opt-in's two halves and nothing else: `exposureWatchProbe` (is this
 * worktree already an entry, by REALPATH of its dir) and `addExposureTarget` (append one entry).
 *
 *  - **It writes exactly one file**, `targets.json` in the exposure dir (`exposureDir()`, the same
 *    dir the readers use). No path from a client is read: the dir is the worktree the route
 *    already contained.
 *  - **Every other entry and every unknown field is kept untouched** (`play`, `args` belong to
 *    other writers); the file is re-read right before the write and written atomically.
 *    A file that does not parse is never overwritten.
 *  - **Honest about the runner**: no `targets.json` and no `.jsonl` in the dir means no daily runner
 *    has ever run here; the offer stays, and says so.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { exposureDir } from "./exposure.js";
import { readJsonGuardedDetail, writeJsonAtomic } from "./jsonstore.js";

const FILE = "targets.json";
const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

interface TargetsDoc { version: number; targets: Array<Record<string, unknown>>; [k: string]: unknown }

const targetsPath = () => join(exposureDir(), FILE);

/** Read the file as-is: `null` = present but not usable (never overwrite it). */
function readDoc(): TargetsDoc | null {
  const p = targetsPath();
  if (!existsSync(p)) return { version: 1, targets: [] };
  const r = readJsonGuardedDetail<unknown>(p, null, (v) => !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as TargetsDoc).targets));
  const v = r.value as TargetsDoc | null;
  return v && Array.isArray(v.targets) ? v : null;
}

/** The `Owner/repo` of a github.com `origin` (ssh or https), else undefined. */
export function ghOfRemote(url: string): string | undefined {
  const m = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

function originOf(wt: string): string | undefined {
  try {
    const u = execFileSync("git", ["remote", "get-url", "origin"], { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    return ghOfRemote(u);
  } catch { return undefined; }
}

/** A unique `[a-z0-9._-]` name from the dir's basename. */
export function targetName(dir: string, taken: Set<string>): string {
  const base = basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "") || "repo";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

export type ExposureWatchProbe = { state: "on" | "off" | "unknown"; detail: string };

export function exposureWatchProbe(wt: string): ExposureWatchProbe {
  const doc = readDoc();
  if (!doc) return { state: "unknown", detail: `${FILE} exists but could not be read, so it is left alone.` };
  const me = real(wt);
  const hit = doc.targets.find((t) => typeof t?.dir === "string" && real(t.dir) === me);
  if (hit) return { state: "on", detail: `${FILE} lists this repo${typeof hit.name === "string" ? ` as ${hit.name}` : ""}.` };
  let runner = existsSync(targetsPath());
  if (!runner) {
    try { runner = readdirSync(exposureDir()).some((n) => n.endsWith(".jsonl")); } catch { /* no dir yet */ }
  }
  return runner
    ? { state: "off", detail: `${FILE} does not list this repo.` }
    : { state: "off", detail: "No daily exposure runner on this desktop yet — the entry is kept and used once one runs." };
}

export function addExposureTarget(wt: string): { added: boolean; note: string } {
  const dir = real(wt);
  const doc = readDoc();
  if (!doc) return { added: false, note: `${FILE} could not be read — left as it is` };
  if (doc.targets.some((t) => typeof t?.dir === "string" && real(t.dir) === dir)) {
    return { added: false, note: "this repo is already in the exposure watch — left as it is" };
  }
  const name = targetName(dir, new Set(doc.targets.map((t) => String(t?.name))));
  const gh = originOf(dir);
  const entry: Record<string, unknown> = { name, dir, ...(gh ? { gh } : {}), addedAt: new Date().toISOString(), addedBy: "phone" };
  // Re-read right before the write: another writer may have appended meanwhile.
  const fresh = readDoc();
  if (!fresh) return { added: false, note: `${FILE} could not be read — left as it is` };
  if (fresh.targets.some((t) => typeof t?.dir === "string" && real(t.dir) === dir)) {
    return { added: false, note: "this repo is already in the exposure watch — left as it is" };
  }
  const taken = new Set(fresh.targets.map((t) => String(t?.name)));
  if (taken.has(name)) entry.name = targetName(dir, taken);
  writeJsonAtomic(targetsPath(), { ...fresh, version: typeof fresh.version === "number" ? fresh.version : 1, targets: [...fresh.targets, entry] }, { space: 2, newline: true });
  return { added: true, note: `added ${String(entry.name)} to the exposure watch${gh ? ` (${gh})` : ""}` };
}

/** The REAL dirs on the watch (`targets.json`), or `null` when the file is present but unusable. */
export function exposureWatchedDirs(): Set<string> | null {
  const doc = readDoc();
  if (!doc) return null;
  return new Set(doc.targets.filter((t) => typeof t?.dir === "string").map((t) => real(t.dir as string)));
}

export type ExposureTargetLookup =
  | { ok: true; name: string; play: boolean }
  | { ok: false; why: string };

/**
 * This worktree's entry in `targets.json`, matched by REALPATH of its dir (the probe's rule) — the
 * NAME the collector's `--target` takes. Not listed, or a file that does not parse, is a sentence:
 * a re-check from the phone runs only what the daily runner would run.
 */
export function exposureTargetOf(wt: string): ExposureTargetLookup {
  const doc = readDoc();
  if (!doc) return { ok: false, why: `${FILE} exists but could not be read, so nothing was run.` };
  const me = real(wt);
  const hit = doc.targets.find((t) => typeof t?.dir === "string" && real(t.dir) === me);
  if (!hit || typeof hit.name !== "string" || !hit.name) {
    return { ok: false, why: "This repo is not on the exposure watch, so there is nothing to re-check — add it from the Opt-ins region first." };
  }
  return { ok: true, name: hit.name, play: hit.play === true };
}
