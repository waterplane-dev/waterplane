/**
 * The fan-out sheet's kickoff strip, pure — `FanoutSheet.tsx` draws it and
 * `fanoutKickoff.test.mjs` runs it under `node --test`.
 */
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
