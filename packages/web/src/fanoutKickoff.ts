/**
 * The fan-out sheet's kickoff strip, pure — `FanoutSheet.tsx` draws it and
 * `fanoutKickoff.test.mjs` runs it under `node --test`.
 */
import { droppedWords, firedRun, type FireFate } from "./core/queue/fireFate.ts";
/** The fields of a run's target the kickoff readout reads — `FanoutTarget`'s,
 *  restated so this file stays importable under `node --test`. */
interface KickoffTarget {
  status: "pending" | "starting" | "running" | "done" | "failed";
  sessionId?: string;
}

export interface Kickoff {
  total: number;
  /** Not yet picked up by the desktop (`pending`). */
  waiting: number;
  /** Spawning a session / typing the prompt into it. */
  starting: number;
  /** Prompt delivered, the turn is still going. */
  working: number;
  finished: number;
  failed: number;
  /** Kicked off: everything past `starting`, failures included. The bar's fill. */
  kicked: number;
  /** One sentence for the strip. */
  line: string;
}

/**
 * **How far a sweep got, as one sentence and one fraction.**
 *
 * A 19-repo sweep used to answer the Run tap with a toast and then nothing on
 * screen: the run's rows sit below the whole repo checklist. This is the strip
 * above the Run button. Every bucket is a status the host wrote; nothing is
 * inferred, and a zero bucket is left out of the sentence rather than said.
 */
export function kickoff(targets: readonly KickoffTarget[]): Kickoff {
  const n = (s: KickoffTarget["status"]) => targets.filter((t) => t.status === s).length;
  const total = targets.length;
  const waiting = n("pending"), starting = n("starting"), working = n("running");
  const finished = n("done"), failed = n("failed");
  const kicked = total - waiting - starting;
  const parts = [
    starting && `${starting} starting`,
    waiting && `${waiting} waiting`,
    working && `${working} working`,
    finished && `${finished} finished`,
    failed && `${failed} failed`,
  ].filter(Boolean).join(" · ");
  const head = waiting + starting > 0 ? `Kicking off: ${kicked} of ${total} started`
    : working > 0 ? `All ${total} started`
      : `Sweep over`;
  return { total, waiting, starting, working, finished, failed, kicked, line: parts ? `${head} — ${parts}` : head };
}

/** Before the host has written the run down, the strip says where the tap is. */
export function kickoffSent(offline: boolean, repos: number): string {
  return offline ? `Queued — the sweep starts ${repos} session${repos === 1 ? "" : "s"} when the link is back`
    : `Sent — waiting for the desktop to start ${repos} session${repos === 1 ? "" : "s"}`;
}

/** A target row's second line, worded off its STATUS as well as its session:
 *  the host drops a settled target's session id once that session is gone
 *  (`intents/watch.ts`), so "no id" alone does not mean "still starting". */
export function targetSubline(t: KickoffTarget & { error?: string }): string {
  if (t.error) return t.error;
  if (t.sessionId) return "tap to open the session";
  if (t.status === "done" || t.status === "failed") return "its session has closed";
  if (t.status === "pending") return "waiting to start";
  return "starting…";
}

/**
 * **The strip between the tap and the run, read off the fire's FATE**
 * (`core/queue/fireFate.ts`, the one owner — design review 2026-10-30 W2).
 * It used to spin *Sent — waiting…* for as long as no new run id appeared, so
 * a `fanout.run` row that failed or was dismissed spun for ever. A fire that
 * will never start says so in words, without a spinner.
 */
export function fanoutFireLine(fate: FireFate, offline: boolean, repos: number): { spin: boolean; line: string } {
  switch (fate.kind) {
    case "dropped": return { spin: false, line: droppedWords("sweep", fate.reason) };
    case "refused": return { spin: false, line: `The desktop refused the sweep${fate.reason ? ` — ${fate.reason}` : ""}. Nothing was started.` };
    case "acked": return fate.runId ? { spin: true, line: kickoffSent(offline, repos) }
      : { spin: false, line: "The desktop started the sweep — its run is in the Runs list above." };
    default: return { spin: true, line: kickoffSent(offline, repos) };
  }
}

/** This tap's run: the one the receipt NAMES — never "the first run id not known at the tap" (another device's). */
export function fanoutMine<R extends { id: string }>(runs: readonly R[], fate: FireFate | null): R | undefined {
  return firedRun(runs, fate, (r) => r.id) ?? undefined;
}
