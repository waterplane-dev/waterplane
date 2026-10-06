/**
 * A per-repo list of things to run, the runs themselves, and their output.
 *
 * Build and capture are the same feature typed twice: a cached per-repo list
 * (`*.list`), a capped list of runs upserted by id (`*.run`), and a streamed
 * output buffer per run (`*.output`) whose chatty frames re-render only while
 * the sheet reading them is on top. App carried both copies line for line; this
 * is the one they move into.
 *
 * What stays with the feature: the toasts (a capture's verdict is not a
 * build's), anything a `*.list` frame carries beyond the list and the runs
 * (`capture.list`'s backends), and decoding the output frame.
 */
import type { Cached } from "../localState.ts";
import { cachedList, type CachedListStore } from "./cached.ts";
import { createStore, type Store } from "./store.ts";

export interface RunLike { runId: string; repoDir: string }

/** Runs kept per tab, newest first. */
export const RUNS_CAP = 60;
/** Output kept per run — the TAIL, since the end is where a failure says why. */
export const OUTPUT_CAP = 300_000;

/** `*.run`: the run to the front, its older copy out, the list capped. */
export function upsertRun<R extends RunLike>(prev: readonly R[], run: R, cap = RUNS_CAP): R[] {
  return [run, ...prev.filter((r) => r.runId !== run.runId)].slice(0, cap);
}

/** `*.list`: this repo's runs as the host has them, every other repo's kept. */
export function replaceRepoRuns<R extends RunLike>(prev: readonly R[], repoDir: string, runs: readonly R[]): R[] {
  return [...runs, ...prev.filter((r) => r.repoDir !== repoDir)];
}

/** `*.output`: a `full` frame replaces, anything else appends; the tail is kept. */
export function appendOutput(cur: string, chunk: string, full: boolean, cap = OUTPUT_CAP): string {
  const next = (full ? "" : cur) + chunk;
  return next.length > cap ? next.slice(-cap) : next;
}

export interface RepoRunStore<C, R extends RunLike> {
  cfgs: CachedListStore<C>;
  runs: Store<R[]>;
  /** Bumped when output a visible sheet reads has moved. The text itself is
   *  NOT state — a 20-minute run is ~800 frames — and is read by `outputOf`. */
  outTick: Store<number>;
  outputOf(runId: string): string;
  /** The buffer itself, read-only: runId → retained output. The SAME object
   *  for the store's life (it moves in place), so a sheet reading `.get(runId)`
   *  pairs it with `outTick` to know when to look again. */
  output: ReadonlyMap<string, string>;
  onList(repoDir: string, cfgs: C[], runs: R[]): void;
  onRun(run: R): void;
  /** `visible`: is the sheet that reads this on top? When not, the buffer moves
   *  and nothing re-renders. */
  onOutput(runId: string, text: string, full: boolean, visible: boolean): void;
}

export function repoRunStore<C, R extends RunLike>(io: {
  load: () => Record<string, Cached<C[]>>;
  save: (repoDir: string, list: C[]) => Record<string, Cached<C[]>>;
}): RepoRunStore<C, R> {
  const cfgs = cachedList<C>(io);
  const runs = createStore<R[]>([]);
  const outTick = createStore(0);
  const out = new Map<string, string>();
  return {
    cfgs, runs, outTick,
    output: out,
    outputOf: (runId) => out.get(runId) ?? "",
    onList(repoDir, list, rs) {
      cfgs.put(repoDir, list);
      runs.set((prev) => replaceRepoRuns(prev, repoDir, rs));
    },
    onRun(run) {
      const next = upsertRun(runs.get(), run);
      // Prune output for runs that fell off the capped list (per-tab memory).
      const keep = new Set(next.map((r) => r.runId));
      for (const id of out.keys()) if (!keep.has(id)) out.delete(id);
      runs.set(next);
    },
    onOutput(runId, text, full, visible) {
      out.set(runId, appendOutput(out.get(runId) ?? "", text, full));
      if (visible) outTick.set((n) => n + 1);
    },
  };
}
