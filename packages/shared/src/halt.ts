/**
 * The emergency halt: one tap that hard-stops every AI process this host
 * started and LATCHES, so nothing automatic starts another until a person lifts
 * it.
 *
 * Why a latch and not just a kill: this host brings work back on its own — the
 * limit-resume queue reopens conversations with `--continue`, schedules and the
 * backlog fire on the intent tick, the sidecar spends on events. A kill without
 * a hold is undone within minutes. So the halt is a persisted flag every spawn
 * path asks, and the kill is what happens at the moment it is set.
 *
 * Scope is THIS host's own processes (agent sessions, attached or detached, and
 * its headless model runs). Shell sessions are not AI and are left alone; a
 * `claude` started by hand outside waterplane, and cloud sessions, are out of
 * reach and the receipt says so.
 *
 * The wording lives here so the host's refusals and the phone's banner say the
 * same sentence.
 */

import { BRAND } from "./brand.js";

/** What one halt did, counted at the moment it ran. */
export interface HaltReceipt {
  at: number;
  /** Agent sessions ended (attached, detached, or waiting to be reopened). */
  sessions: number;
  /** Processes inside those sessions that were signalled (the agent and its tools). */
  processes: number;
  /** Of those, how many ignored SIGTERM and needed SIGKILL. */
  forced: number;
  /** Headless model runs (review, naming, assess, …) stopped mid-flight. */
  sidecars: number;
  /** Waiting rows (schedules, launches, backlog) that are now held, not fired. */
  held: number;
}

/** The latch as the phone sees it: on hello and on every change. */
export interface HaltState {
  on: boolean;
  /** When it was set; null while off. */
  since: number | null;
  /** The last halt's tally; kept after a lift so the receipt can still be read. */
  receipt: HaltReceipt | null;
}

export const HALT_OFF: HaltState = { on: false, since: null, receipt: null };

/** The refusal every gated path gives while the latch is on. */
export const HALT_REFUSAL = "All AI is halted on this desktop. Lift the halt to start anything.";

const n = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;

/** One line naming what a halt did — what was stopped, what is held, and what it could not reach. */
export function haltReceiptWords(r: HaltReceipt): string {
  const stopped: string[] = [n(r.sessions, "session")];
  if (r.sidecars) stopped.push(n(r.sidecars, "background model run"));
  const procs = r.processes ? ` (${n(r.processes, "process", "processes")}${r.forced ? `, ${r.forced} forced` : ""})` : "";
  const held = r.held ? ` ${n(r.held, "waiting item")} held.` : "";
  return `Stopped ${stopped.join(" and ")}${procs}.${held} AI started outside ${BRAND.displayName} and cloud sessions are not reached.`;
}
