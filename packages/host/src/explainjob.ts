/**
 * The Review sheet's Explain as a JOB, not a held request (the push's shape,
 * `git.ts` `startPush`): a brief takes a fetch and a model pass — a minute or
 * two — and the person leaves the screen meanwhile.
 *
 * - `startExplain` starts the run in a worktree, or JOINS the one running
 *   there (a second tap, another tab) — never a second paid call.
 * - `explainState` is the run going now or the last one that finished. The
 *   last finished one per worktree is persisted (`explains.json`), so the
 *   sheet reopened — after a restart too — shows the last answer instead of a
 *   blank form. A run cut by a restart is gone; the phone says so.
 * - A run that ends is told once (`setExplainSink`, installed by `main.ts`):
 *   the notification opens the Explain view on it.
 */
import { join } from "node:path";
import type { ChangeBrief, GitExplainState } from "@waterplane/shared";
import { explainChanges } from "./changebrief.js";
import { STATE_DIR } from "./env.js";
import { readJsonGuarded, writeJsonAtomic } from "./jsonstore.js";
import type { GitRepoRef } from "./git.js";

/** Worktrees remembered; the oldest finished run beyond this is dropped. */
const KEEP = 50;

interface Job extends GitExplainState { done: Promise<ChangeBrief> }
type Stored = Record<string, GitExplainState>;

const jobs = new Map<string, Job>();
let stored: Stored | null = null;
const path = () => join(STATE_DIR, "explains.json");
const isStored = (v: unknown): boolean => !!v && typeof v === "object" && !Array.isArray(v);

function load(): Stored {
  stored ??= readJsonGuarded<Stored>(path(), {}, isStored);
  return stored;
}
function save(wt: string, s: GitExplainState): void {
  const all = { ...load(), [wt]: s };
  const keep = Object.entries(all).sort((a, b) => (b[1].finishedAt ?? 0) - (a[1].finishedAt ?? 0)).slice(0, KEEP);
  stored = Object.fromEntries(keep);
  try { writeJsonAtomic(path(), stored); } catch (e) { console.error(`[explain] could not keep the last brief: ${(e as Error).message}`); }
}

/** How a run ended, for whoever turns it into a notification. */
export interface ExplainOutcome { repo: GitRepoRef; brief: ChangeBrief; startedAt: number; finishedAt: number }
let sink: ((o: ExplainOutcome) => void) | null = null;
/** Install (or, with null, remove) the one listener for finished briefs. */
export function setExplainSink(fn: ((o: ExplainOutcome) => void) | null): void { sink = fn; }

/** Start a brief in `wt`, or join the one already running there. */
export function startExplain(wt: string, body: { foci?: unknown; note?: unknown }, repo?: GitRepoRef): Job {
  const live = jobs.get(wt);
  if (live?.running) return live;
  const startedAt = Date.now();
  const foci = Array.isArray(body.foci) ? body.foci.filter((f): f is string => typeof f === "string") : [];
  const note = typeof body.note === "string" ? body.note : "";
  const job: Job = { running: true, startedAt, foci, note, done: null as never };
  job.done = explainChanges(wt, body)
    .catch((e: unknown): ChangeBrief => ({ reason: `The explanation stopped: ${e instanceof Error ? e.message : String(e)}` }))
    .then((brief) => {
      const finishedAt = Date.now();
      Object.assign(job, { running: false, result: brief, finishedAt });
      save(wt, { running: false, startedAt, foci, note, result: brief, finishedAt });
      if (repo) {
        try { sink?.({ repo, brief, startedAt, finishedAt }); } catch (e) { console.error(`[explain] sink threw: ${(e as Error).message}`); }
      }
      return brief;
    });
  jobs.set(wt, job);
  return job;
}

/** The brief running or last finished in `wt`, or null when there has been none. */
export function explainState(wt: string): GitExplainState | null {
  const job = jobs.get(wt);
  if (job) return { running: job.running, startedAt: job.startedAt, foci: job.foci, note: job.note, result: job.result, finishedAt: job.finishedAt };
  return load()[wt] ?? null;
}

/** For tests: forget everything held in memory. */
export function resetExplainJobs(): void { jobs.clear(); stored = null; }
