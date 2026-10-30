/**
 * Everything the fan-out sheet sends. Both are DURABLE ops through the one
 * send queue (`fanout.run`, `fanout.followup` are `DurableOp`s): dirs are
 * re-validated host-side at execution time, so a run delivered later may hit
 * fewer valid targets and still settle ok.
 */
import type { LaunchOpts } from "@waterplane/shared";
import { core } from "../../sdk";
import { onceIn } from "../../sendIntent";
import { FANOUT_LANE, fanoutToast, followUpLane, followUpToast } from "./logic";

/** `launch` is the sweep's own (the sheet's launch row — backend, model and
 *  effort over the new-session defaults, which every other option still is).
 *  Answers the ackId of its TRACKED queue row: the sheet reads that fire's fate
 *  (`useFireFate`) and opens the run its receipt names. */
export function runFanout(dirs: string[], text: string, launch: LaunchOpts, flagWhenDone?: boolean): string {
  const c = core();
  // Minted HERE so the sheet can name this fire before it exists — the
  // receipt's `runId` is THIS tap's run, not "the first run id it did not
  // know" (another device's sweep landing first). design review 2026-10-30 W2.
  const ackId = c.queue.mintAckId();
  // `launch.wire`, for the same reason every `session.create` gets it
  // (`createOp`): a sweep spawns N real sessions, so a stale synced
  // `backend` here is the same bad spawn N times over.
  const { cols, rows } = c.term.geom();
  const offline = c.queue.queueOp({ t: "fanout.run", dirs, text, launch: c.launch.wire(launch), ...(flagWhenDone ? { flagWhenDone: true } : {}), cols, rows },
    FANOUT_LANE, text, { ackId, track: true });
  c.say.toast(fanoutToast(offline, dirs.length));
  return ackId;
}

export function followUpFanout(runId: string, text: string, dirs: string[]): void {
  const c = core();
  const offline = c.queue.queueOp({ t: "fanout.followup", runId, text, dirs }, followUpLane(runId), text);
  c.say.toast(followUpToast(offline, dirs.length));
}

/** "Later" — the same composed sweep, handed to the Send sheet's *When*. The
 *  repos, the prompt and the launch row's pick travel with it (a snapshot: the
 *  rule fires with the launch it was saved with); nothing is queued yet. */
export function scheduleFanout(dirs: string[], text: string, launch: LaunchOpts): void {
  core().nav.openSend({
    prompts: [text], target: { kind: "repos", dirs, launch }, when: onceIn(3600e3),
    cwdHint: dirs[0] ?? null, origin: "This sweep, at a time you pick",
  });
}

export function openFanoutSession(id: string): void {
  const c = core();
  const s = c.world.sessions.find((x) => x.id === id);
  if (s) c.nav.attach(s);
}
