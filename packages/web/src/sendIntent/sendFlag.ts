/**
 * "Flag for follow up when done" on a send (R-sessions-043) — where it may be
 * asked and what rides. Pure; split from `sendIntent.ts` (docs/notes/send-architecture.md).
 */
import type { SendTarget, SendWhen } from "./sendTypes.ts";

/**
 * Where the tick can be asked: wherever the DESKTOP opens the session and can
 * tell when it is done — a repo row that waits (when it's free, a chain, a
 * clock), and a sweep's fan-out, its per-repo rows or its chain. Not a repo
 * `now` (`session.create`, a session the person opened by hand, has no field
 * for it) and not a sweep on a clock (its schedule action has none). The ONE
 * gate the toggle, the row words and every dispatch arm read.
 */
export function flagWhenDoneOffered(t: SendTarget, w: SendWhen): boolean {
  if (t.kind === "repo") return w.kind !== "now";
  if (t.kind === "repos") return w.kind !== "at";
  return false;
}

/** The tick as it rides: `true` where it is offered and ticked, else absent. */
export function flagWhenDoneOf(t: SendTarget, w: SendWhen): true | undefined {
  return (t.kind === "repo" || t.kind === "repos") && t.flagWhenDone === true && flagWhenDoneOffered(t, w) ? true : undefined;
}
