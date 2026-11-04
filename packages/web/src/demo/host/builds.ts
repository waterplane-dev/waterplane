/**
 * Build commands on the demo desktop — a fault journey's fixture, never a
 * shipped scenario's.
 *
 * The shipped demo has no desktop to run a build on, so with no fixture it says
 * that: `build.list` is empty and `build.run` is refused in `NO_DESKTOP`'s words.
 * A journey that needs the build sheet's fire → receipt → run path (`scripts/ui/
 * journey-fault-build-fire.mjs`) seeds one through `faults.builds`. A fixture
 * "runs" nothing: a fire writes the row and answers, which is all the sheet can
 * see of a run. The ORDER those frames land in is the journey's (`drop` rules,
 * then `faults.emit`), so the race is driven by what arrived, never by a timer.
 */
import type { BuildConfig, BuildRun } from "@waterplane/shared";
import { mint } from "./model.ts";
import type { Desk } from "./model.ts";
import type { DemoVerdict, Msg } from "./verdict.ts";

export interface DemoBuilds {
  repoDir: string;
  list: BuildConfig[];
  /** Newest first, as the host lists them. */
  runs: BuildRun[];
  /** Build id → the sentence its fire is refused with. No toast rides with it:
   *  the receipt is all a verdict replayed after a reconnect carries. */
  refuse?: { [buildId: string]: string };
}

export const NO_DESKTOP = "Builds run commands on your desktop — the demo has no desktop to run them on. Connect your own to build.";

/** `build.run`: the row a fire started, answered by the run's id (the receipt the sheet selects by). */
export function fireBuild(d: Desk, msg: Msg<"build.run">): DemoVerdict {
  const f = d.m.builds;
  if (!f) return { ok: false, reason: NO_DESKTOP };
  const refused = f.refuse?.[msg.buildId];
  if (refused) return { ok: false, reason: refused };
  const cfg = msg.repoDir === f.repoDir ? f.list.find((b) => b.id === msg.buildId) : undefined;
  if (!cfg) return { ok: false, reason: "unknown build" };
  const run: BuildRun = {
    runId: mint(d.m, "br"), repoDir: f.repoDir, buildId: cfg.id, name: cfg.name, cmd: cfg.cmd,
    cwd: f.repoDir, status: "running", exitCode: null, startedAt: d.now(),
  };
  f.runs.unshift(run);
  d.broadcast({ t: "build.run", run });
  return { ok: true, runId: run.runId };
}
