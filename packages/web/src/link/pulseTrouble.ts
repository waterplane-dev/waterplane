/**
 * **When the connection strip draws itself in "only when something is wrong" mode.**
 *
 * The strip's readings are worth a glance on a bad link and are a standing line of
 * noise on a good one, so a person may ask for it only when it has something to say.
 * The probes keep running either way (the strip cannot know the link turned bad
 * without measuring it): what this mode saves is a line of screen, not a ping.
 *
 * What counts as wrong — each is a fact the strip itself prints, so the strip that
 * appears always shows WHY it appeared:
 *  - `offline`   the socket is not open (connecting counts: nothing gets through)
 *  - `lossy`     a probe went unanswered among the last `RECENT_N`
 *  - `slow`      the median of the last `RECENT_N` answers is past `SLOW_MS`
 *  - `insecure`  the desktop is reached over plain http (the strip's "not protected")
 *  - `stuck`     a send gave up and is waiting on a decision
 *  - `restart`   the desktop is restarting
 *
 * **It stays up `HOLD_MS` after the last wrong reading.** A link that flaps every
 * few seconds would otherwise move every screen 22 px up and down with it, and the
 * minute after a drop is exactly when "is it back?" is asked. Pure, node-tested.
 */
import type { PulseSample } from "./linkTypes";

export type PulseWhen = "always" | "trouble";
export const PULSE_WHEN: readonly PulseWhen[] = ["always", "trouble"];

export type TroubleReason = "offline" | "lossy" | "slow" | "insecure" | "stuck" | "restart";

/** Probes looked at — 30 s at the 3 s probe rate. */
export const RECENT_N = 10;
/** A median round trip past this is slow enough to feel in typing. */
export const SLOW_MS = 400;
/** How long the strip stays after the last wrong reading. */
export const HOLD_MS = 30_000;

export interface TroubleInput {
  status: string;
  samples: readonly PulseSample[];
  insecure: boolean;
  stuckSends: number;
  restarting: boolean;
}

export function troubleReasons(i: TroubleInput): TroubleReason[] {
  const out: TroubleReason[] = [];
  if (i.status !== "open") out.push("offline");
  const recent = i.samples.slice(-RECENT_N);
  if (i.status === "open" && recent.some((s) => s.ms == null)) out.push("lossy");
  const good = recent.filter((s) => s.ms != null).map((s) => s.ms as number).sort((a, b) => a - b);
  if (good.length && good[Math.floor((good.length - 1) / 2)] > SLOW_MS) out.push("slow");
  if (i.insecure) out.push("insecure");
  if (i.stuckSends > 0) out.push("stuck");
  if (i.restarting) out.push("restart");
  return out;
}

/** Draw the strip now? `lastTroubleAt` is the newest instant a reason held (or null). */
export function stripShown(when: PulseWhen, reasons: readonly TroubleReason[], lastTroubleAt: number | null, now: number): boolean {
  if (when === "always") return true;
  if (reasons.length) return true;
  return lastTroubleAt != null && now - lastTroubleAt < HOLD_MS;
}
