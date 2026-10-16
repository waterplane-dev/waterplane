import type { BlockReason, Lifecycle } from "@waterplane/shared";
import type { ActivityBucket } from "./activityTypes.ts";

// A leaf of its own: the three row builders stamp a row's bucket with it, and
// `activitySelect.ts` (which ranks by it) imports those builders — so in the
// selector it closed an import cycle.

/**
 * Which chip a row lands under.
 *
 * `needsYou` is not "important" — it is the set that will NEVER move without a
 * person: a dead session, a switch that is off, a question box waiting for an
 * answer. Everything else in `blocked` clears itself given time, and the whole
 * value of separating them is that a list of thirty waiting rows has three you
 * can actually do something about.
 *
 * `canceled` sits in `done` rather than `failed`. It is settled, and it is not
 * a failure — a chip that shows things you called off next to things that broke
 * makes the failure count useless, which is the number this screen is opened on.
 */
export function bucketOf(state: Lifecycle, reason: BlockReason | null): ActivityBucket {
  if (state === "failed") return "failed";
  if (state === "done" || state === "canceled") return "done";
  if (state === "running" || state === "starting") return "running";
  if (reason === "sessionGone" || reason === "gate" || reason === "awaitingAnswer") return "needsYou";
  if (reason === "notYet") return "scheduled";
  return "waiting";
}
