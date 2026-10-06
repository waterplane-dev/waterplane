/**
 * The queue sheet's pure half: the sentences its two host-held verbs and its
 * one switch say. Pinned by `logic.test.mjs`.
 */

/** What the serialize switch says it just did. */
export function serialToast(on: boolean): string {
  return on ? "new queued work will run one session at a time per repo" : "new queued work will all start at once";
}

/** A parked launch's refusal with the link down: the desktop still holds it.
 *  One copy app-wide (`backlogFilter.ts`'s `HELD_OFFLINE`, Activity's too). */
export { HELD_OFFLINE as LAUNCH_HELD_OFFLINE } from "../../backlogFilter.ts";
