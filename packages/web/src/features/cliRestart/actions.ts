/**
 * Arm, disarm, and the check every session update runs. The restart itself is
 * `launch.relaunch` — the same kill + create as one durable op the banner's
 * "Restart, same conversation" sends — in its quiet form: it does not close
 * the sheet you are in or pull you to the tab unless you are on it.
 */
import type { SessionInfo } from "@waterplane/shared";
import { core } from "../../sdk";
import { resumeIdOf } from "../../sessionFacts";
import { armedStore } from "./store";
import { armVerdict } from "./logic";

/** How often an armed session is looked at. The session frames are App's
 *  (`webshape.test.mjs`: one handler per frame), so this reads the world App
 *  keeps instead — and only while something is armed. */
const TICK_MS = 2000;
let timer: ReturnType<typeof setInterval> | null = null;

export function armRestart(id: string, installed: string): void {
  armedStore.set((m) => ({ ...m, [id]: installed }));
  core().say.track("action:session.cliRestartIdle");
  timer ??= setInterval(tick, TICK_MS);
  // Idle already: say so now, not a tick later.
  tick();
}

export function disarmRestart(id: string): void {
  if (!(id in armedStore.get())) return;
  armedStore.set((m) => {
    const { [id]: _gone, ...rest } = m;
    return rest;
  });
  if (!Object.keys(armedStore.get()).length) stopTicking();
}

export function stopTicking(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function tick(): void {
  const sessions = core().world.sessions;
  for (const id of Object.keys(armedStore.get())) {
    const s = sessions.find((x) => x.id === id);
    // Closed or exited meanwhile: nothing left to restart.
    if (!s || !s.running) disarmRestart(id);
    else checkArmed(s);
  }
}

/** Fires at most once per arm. */
function checkArmed(s: SessionInfo): void {
  const armedFor = armedStore.get()[s.id];
  if (!armedFor) return;
  const c = core();
  const queued = c.queue.entries.filter((e) => e.sessionId === s.id && e.status !== "failed").length;
  const verdict = armVerdict(s, armedFor, c.world.update?.current, resumeIdOf(s), queued);
  if (verdict === "wait") return;
  // Disarm BEFORE the relaunch: the next update must never send a second one.
  disarmRestart(s.id);
  if (verdict === "drop") return;
  c.launch.relaunch(s, {}, { quiet: true });
  c.say.toast(`${s.title} was idle — restarting it on Claude ${armedFor}, same conversation`);
}
