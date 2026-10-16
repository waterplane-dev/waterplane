/**
 * The emergency halt latch (`shared/halt.ts` says why it is a latch and not a
 * kill). This module owns three things and nothing else:
 *
 * - **The flag**, persisted to `<state>/halt.json` so a restart — launchd's
 *   KeepAlive, a crash, `npm run restart` — comes back still halted. A file
 *   that is PRESENT but unreadable reads as halted: the person asked for
 *   everything to stop, and a torn write must not be what starts it again.
 *   Absent is off, because a host that has never been halted has no file.
 * - **The live headless runs** (`sidecarclaude.ts` registers each child), so a
 *   halt can reach a `claude -p` that is mid-review.
 * - **Killing a process tree** with a short SIGTERM grace and then SIGKILL,
 *   where identity is pid AND start time — a pid recycled during the grace is a
 *   stranger's process, never ours to kill.
 *
 * The gates are where the spawns are (`SessionManager.create`, the intent
 * tick, `runHeadlessClaude`, `chatCompletion`, the `/usage` probe); each asks
 * `isHalted()` and refuses with `HALT_REFUSAL`. The kill itself is
 * `SessionManager.haltAll()`, which uses `killTrees` below.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HALT_OFF, HALT_REFUSAL, logTag, type HaltReceipt, type HaltState } from "@waterplane/shared";
import { ROOT } from "./env.js";
import { hostStateDir } from "./branddirs.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";

/** How long a halted process gets to flush (claude's transcript) before SIGKILL. */
export const HALT_GRACE_MS = 1000;

let state: HaltState | null = null;
const path = (): string => join(hostStateDir(ROOT), "halt.json");

function load(): HaltState {
  if (state) return state;
  const p = path();
  if (!existsSync(p)) return (state = { ...HALT_OFF });
  const unreadable: HaltState = { on: true, since: Date.now(), receipt: null };
  const v = readJsonGuarded<HaltState>(p, unreadable, (x) => typeof x === "object" && x !== null && typeof (x as HaltState).on === "boolean");
  return (state = { on: v.on, since: v.on ? (v.since ?? Date.now()) : null, receipt: v.receipt ?? null });
}

export function haltState(): HaltState { return { ...load() }; }
export function isHalted(): boolean { return load().on; }
/** The sentence a gated path refuses with while halted; null when not. */
export function haltRefusal(): string | null { return load().on ? HALT_REFUSAL : null; }

/**
 * Set or lift the latch. Persist failure keeps the in-memory value (the halt
 * still holds for this process) and is logged — the caller's kill runs either way.
 */
export function setHalted(on: boolean, receipt?: HaltReceipt): HaltState {
  const prev = load();
  state = { on, since: on ? (prev.on ? prev.since : Date.now()) : null, receipt: receipt ?? prev.receipt };
  try { writeJsonAtomic(path(), state); }
  catch (e) { console.error(`${logTag} halt: could not persist the latch (${on ? "on" : "off"}) — it holds until this process ends`, e); }
  return { ...state };
}

// ── Live headless runs ─────────────────────────────────────────────────────

const liveRuns = new Set<(sig: NodeJS.Signals) => void>();

/** Register a running headless child; the returned function unregisters it. */
export function trackRun(kill: (sig: NodeJS.Signals) => void): () => void {
  liveRuns.add(kill);
  return () => { liveRuns.delete(kill); };
}

/** SIGTERM every live headless run, SIGKILL after the grace. Returns how many. */
export function stopRuns(): number {
  const runs = [...liveRuns];
  for (const k of runs) { try { k("SIGTERM"); } catch { /* gone */ } }
  if (runs.length) setTimeout(() => { for (const k of runs) { try { k("SIGKILL"); } catch { /* gone */ } } }, HALT_GRACE_MS).unref?.();
  return runs.length;
}

// ── Process trees ──────────────────────────────────────────────────────────

interface Proc { pid: number; ppid: number; start: string }

/** The process table as pid, parent and start time; empty when `ps` fails. */
export function readProcs(): Proc[] {
  let out = "";
  try { out = execFileSync("ps", ["-Ao", "pid=,ppid=,lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return []; }
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3] });
  }
  return procs;
}

/** Each root and every descendant of it, deepest-last order not guaranteed. */
export function treeOf(roots: readonly number[], procs: readonly Proc[]): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) { const l = kids.get(p.ppid); if (l) l.push(p); else kids.set(p.ppid, [p]); }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const seen = new Set<number>(); const out: Proc[] = [];
  const stack = roots.filter((r) => r > 1 && byPid.has(r)).map((r) => byPid.get(r)!);
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p.pid) || p.pid <= 1 || p.pid === process.pid) continue;
    seen.add(p.pid); out.push(p);
    for (const k of kids.get(p.pid) ?? []) stack.push(k);
  }
  return out;
}

/**
 * SIGTERM every process under `roots` now, and SIGKILL whichever of THOSE
 * processes (same pid, same start time) is still there after the grace.
 * Resolves with how many were signalled and how many needed the SIGKILL.
 */
export function killTrees(roots: readonly number[], graceMs = HALT_GRACE_MS): Promise<{ processes: number; forced: number }> {
  const victims = treeOf(roots, readProcs());
  for (const p of victims) { try { process.kill(p.pid, "SIGTERM"); } catch { /* gone */ } }
  if (!victims.length) return Promise.resolve({ processes: 0, forced: 0 });
  return new Promise((resolve) => {
    setTimeout(() => {
      const now = new Map(readProcs().map((p) => [p.pid, p.start]));
      let forced = 0;
      for (const p of victims) {
        if (now.get(p.pid) !== p.start) continue; // gone, or a recycled pid
        try { process.kill(p.pid, "SIGKILL"); forced++; } catch { /* gone */ }
      }
      resolve({ processes: victims.length, forced });
    }, graceMs);
  });
}
