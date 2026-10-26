import type { ActivityFilter, ActivityRow } from "./activityTypes.ts";

/**
 * **What is still open: the to-do half of this screen.** Opened on "all", the
 * sheet read as a log — one row needing a tap under thirty-one done ones. A
 * union chip, not a bucket: these rows still have something left to happen,
 * and a person either acts on them or watches them. `scheduled` stays out
 * (not due — it has its own chip), and so does `done`.
 */
export const OPEN_BUCKETS: ReadonlySet<ActivityFilter> = new Set<ActivityFilter>(["needsYou", "failed", "running", "waiting"]);

export const ACTIVITY_FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: "open", label: "open" },
  { id: "all", label: "all" },
  { id: "needsYou", label: "needs you" },
  { id: "failed", label: "failed" },
  { id: "running", label: "running" },
  { id: "waiting", label: "waiting" },
  { id: "scheduled", label: "scheduled" },
  { id: "done", label: "done" },
  // Last, and its own chip rather than a hidden state: a dismissal that could
  // not be looked at again would be a delete wearing a softer word.
  { id: "dismissed", label: "dismissed" },
];

/**
 * Dismissal is ORTHOGONAL to the bucket, and it wins over every chip but its
 * own.
 *
 * A row filed as not-wanted still has a bucket — it is still a failure, or
 * still waiting — and leaving it under `failed` would mean a dismissal that
 * changed nothing a person can see. The one thing "clean it up" asks for is
 * that the list gets shorter, so the filed rows leave every count except the
 * one that exists to find them again.
 */
export function matchesFilter(row: ActivityRow, filter: ActivityFilter): boolean {
  if (filter === "dismissed") return row.dismissedAt != null;
  if (row.dismissedAt != null) return false;
  if (filter === "open") return OPEN_BUCKETS.has(row.bucket);
  return filter === "all" || row.bucket === filter;
}

/** How many rows each chip would show, zeros included: a 0 is no chip, it is
 *  NAMED in the head's `nothing …` line (`activityChips`) — the absence of
 *  failures is a fact worth stating on this screen. */
export function activityCounts(rows: readonly ActivityRow[]): Record<ActivityFilter, number> {
  const out: Record<ActivityFilter, number> = {
    open: 0, all: 0, needsYou: 0, failed: 0, running: 0, waiting: 0, scheduled: 0, done: 0, dismissed: 0,
  };
  for (const r of rows) {
    if (r.dismissedAt != null) { out.dismissed += 1; continue; }
    out.all += 1;
    out[r.bucket] += 1;
    if (OPEN_BUCKETS.has(r.bucket)) out.open += 1;
  }
  return out;
}

/**
 * The standing sentence over the list: what is stuck, in one line.
 *
 * `queueIdleReason`'s job, generalized past the send queue — and its lesson
 * kept: `null` means nothing is stuck, and the caller stays silent rather than
 * inventing reassurance. `cut` is the chip whose rows the number counted, so a
 * tap on the sentence opens exactly those (a count is a filter) — one function
 * for the number and the cut. `null` where no chip is that set (offline holds).
 */
export function activityHeadlineCut(all: readonly ActivityRow[], online: boolean): { text: string; cut: ActivityFilter | null } | null {
  // A filed row has been dealt with, by definition. Counting it here would make
  // the standing sentence the one thing on the screen that never shrinks.
  const rows = all.filter((r) => r.dismissedAt == null);
  if (!online) {
    const held = rows.filter((r) => r.blockReason === "offline").length;
    if (held) return { text: `${held} ${held === 1 ? "thing is" : "things are"} still on this phone — nothing expires while the link is down`, cut: null };
  }
  const needs = rows.filter((r) => r.bucket === "needsYou").length;
  if (needs) return { text: `${needs} ${needs === 1 ? "row needs" : "rows need"} a decision from you`, cut: "needsYou" };
  const failed = rows.filter((r) => r.bucket === "failed").length;
  if (failed) return { text: `${failed} ${failed === 1 ? "thing" : "things"} never ran`, cut: "failed" };
  return null;
}
