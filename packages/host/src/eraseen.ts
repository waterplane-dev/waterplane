/**
 * **Mark the Connect IQ crash groups seen, from a tap** — the `era-seen` fix every open D3
 * finding offers (`@waterplane/shared`'s `ERA_SEEN_FIX`).
 *
 * The work is the daily runner's own: `tools/exposure.mjs era-seen --target <name>` has the ERA
 * checker record every group it lists as seen (its `--mark-seen`, its own state file) and then
 * reads the target again, so the stored row — not this module — says what is left.
 *
 *  - **The target is this worktree's own entry** in `targets.json` (REALPATH of its `dir`, with an
 *    `--era-check` arg); no name or path arrives from the client.
 *  - **Detached, never awaited**: ERA can take ~15 minutes per read and there are two reads. The
 *    child outlives a host restart; its output goes to `<exposure dir>/<name>.era-seen.log`.
 *  - **Single-flight per target**, and the state is SAID on the summary row (`eraSeenWords`):
 *    running since when, or why the last run failed — never a silent tap.
 *  - Confirm-gated (`CONFIRM_GATED_FIXES`): it marks findings handled in bulk.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { exposureDir } from "./exposure.js";
import { readJsonGuardedDetail } from "./jsonstore.js";

const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
const TOOL = resolve(import.meta.dirname, "../../..", "tools/exposure.mjs");

type Run = { state: "running"; since: string } | { state: "failed"; at: string; why: string };
const runs = new Map<string, Run>();

/** This worktree's exposure target that has an ERA check, by REALPATH of its dir. */
function eraTargetOf(wt: string): string | null {
  const p = join(exposureDir(), "targets.json");
  if (!existsSync(p)) return null;
  const doc = readJsonGuardedDetail<{ targets?: unknown } | null>(p, null).value;
  const targets = Array.isArray(doc?.targets) ? doc.targets as Array<Record<string, unknown>> : [];
  const me = real(wt);
  const hit = targets.find((t) => typeof t?.dir === "string" && real(t.dir) === me
    && Array.isArray(t.args) && t.args.includes("--era-check") && typeof t.name === "string");
  return hit ? String(hit.name) : null;
}

/** The last non-empty line of the run's log, for a failure sentence. */
function lastLine(file: string): string {
  try { return readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "no output"; }
  catch { return "no output"; }
}

export function startEraSeen(wt: string): { applied: boolean; note: string } {
  const name = eraTargetOf(wt);
  if (!name) return { applied: false, note: "this repo has no exposure target with an ERA check in targets.json — nothing marked" };
  if (!existsSync(TOOL)) return { applied: false, note: `no exposure tool on this desktop (looked for ${TOOL}) — nothing marked` };
  if (runs.get(name)?.state === "running") return { applied: false, note: "already marking these crash groups seen — the list updates when ERA has been read again" };
  const log = join(exposureDir(), `${name}.era-seen.log`);
  let fd: number;
  try { fd = openSync(log, "w"); } catch (e) { return { applied: false, note: `could not open ${log} (${(e as Error).message}) — nothing marked` }; }
  try {
    const child = spawn(process.execPath, [TOOL, "era-seen", "--target", name], {
      cwd: resolve(import.meta.dirname, "../../.."), detached: true, stdio: ["ignore", fd, fd],
    });
    runs.set(name, { state: "running", since: new Date().toISOString() });
    child.on("error", (e) => runs.set(name, { state: "failed", at: new Date().toISOString(), why: e.message }));
    // 0 = nothing new after the re-read, 10 = something else is new; 2 = ERA unreachable or nothing marked.
    child.on("exit", (code) => {
      if (code === 0 || code === 10) runs.delete(name);
      else runs.set(name, { state: "failed", at: new Date().toISOString(), why: lastLine(log) });
    });
    child.unref();
  } finally { closeSync(fd); }
  return { applied: true, note: "marking every crash group ERA lists as seen — ERA is read twice (up to ~30 minutes); the rows go when the new reading lands" };
}

const hhmm = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A sentence for the exposure summary row while a run is in flight or after one failed; null otherwise. */
export function eraSeenWords(wt: string): string | null {
  if (!runs.size) return null;
  const name = eraTargetOf(wt);
  const r = name ? runs.get(name) : undefined;
  if (!r) return null;
  return r.state === "running"
    ? `Marking the ERA crash groups seen since ${hhmm(r.since)}; the rows go when ERA has been read again.`
    : `Marking the ERA crash groups seen failed at ${hhmm(r.at)}: ${r.why}.`;
}
