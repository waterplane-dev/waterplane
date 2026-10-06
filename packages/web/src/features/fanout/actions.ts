/**
 * Everything the fan-out sheet sends. Both are DURABLE ops through the one
 * send queue (`fanout.run`, `fanout.followup` are `DurableOp`s): dirs are
 * re-validated host-side at execution time, so a run delivered later may hit
 * fewer valid targets and still settle ok.
 */
import { core } from "../../sdk";
import { onceIn } from "../../sendIntent";
import { FANOUT_LANE, fanoutToast, followUpLane, followUpToast } from "./logic";

export function runFanout(dirs: string[], text: string): void {
  const c = core();
  // `launch.wire`, for the same reason every `session.create` gets it
  // (`createOp`): a sweep spawns N real sessions, so a stale synced
  // `backend` here is the same bad spawn N times over.
  const { cols, rows } = c.term.geom();
  const offline = c.queue.queueOp({ t: "fanout.run", dirs, text, launch: c.launch.wire(c.world.launch), cols, rows },
    FANOUT_LANE, text);
  c.say.toast(fanoutToast(offline, dirs.length));
}

export function followUpFanout(runId: string, text: string, dirs: string[]): void {
  const c = core();
  const offline = c.queue.queueOp({ t: "fanout.followup", runId, text, dirs }, followUpLane(runId), text);
  c.say.toast(followUpToast(offline, dirs.length));
}

/** "Later" — the same composed sweep, handed to the Send sheet's *When*. The
 *  repos and the prompt travel with it; nothing is queued yet. */
export function scheduleFanout(dirs: string[], text: string): void {
  core().nav.openSend({
    prompts: [text], target: { kind: "repos", dirs }, when: onceIn(3600e3),
    cwdHint: dirs[0] ?? null, origin: "This sweep, at a time you pick",
  });
}

export function openFanoutSession(id: string): void {
  const c = core();
  const s = c.world.sessions.find((x) => x.id === id);
  if (s) c.nav.attach(s);
}
