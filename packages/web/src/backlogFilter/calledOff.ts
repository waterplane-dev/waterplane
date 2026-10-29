/**
 * **A row that was CALLED OFF is not a row that FAILED.** The wire keeps a
 * cancelled intent at `status: "failed"` for older phones (`BacklogItem.calledOff`),
 * and reading that raw drew every call-off — an agent's replaced draft, a row
 * called off from the phone, an assessment's *already done* — as a red failure,
 * counted it as work that needs you, and offered *run it again*, *drop the
 * clock* and re-time, which the host refuses on a cancelled row in words.
 *
 * So every verb and count that means "this went wrong" asks `isFailedRow`, and
 * the status chips count and cut by `statusBucket` — never `it.status` raw.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, BacklogStatus } from "@waterplane/shared";

type Called = Pick<BacklogItem, "status" | "calledOff">;

/** `failed`, and not called off: what every "went wrong" verb and count asks. */
export const isFailedRow = (it: Called): boolean => it.status === "failed" && !it.calledOff;

/** The status a row is COUNTED and CUT by — one edge for the chip and its tap.
 *  A call-off is settled with nothing to do, so it sits with `done`, the door
 *  to *archive these N*. */
export const statusBucket = (it: Called): BacklogStatus => it.calledOff ? "done" : it.status;

/** The word on the row's status chip and its finished line. */
export const rowStatusWord = (it: Called): string =>
  it.calledOff === "agent" ? "withdrawn" : it.calledOff ? "called off" : it.status;

/** The class suffix for that chip and the row's edge (`tag-*`, `bl-*`). */
export const rowStatusKey = (it: Called): string => it.calledOff ? "calledoff" : it.status;

/** Re-fire on a call-off: the host revives it (`backlog.fire`), so a row the
 *  PERSON or an assessment called off keeps the verb. A draft its own agent
 *  withdrew does not — the agent posted the version meant to run. */
export const refireOffered = (it: Pick<BacklogItem, "status" | "calledOff">): boolean =>
  it.status === "done" || (it.status === "failed" && it.calledOff !== "agent");
