/**
 * **What backlog auto will start next — one predicate, two screens.**
 *
 * The backlog's `▶ next` mark and the Automation sheet's "N rows will start
 * when free" are the same claim about the same rows, so both are this
 * function's answer and never two copies of the edge. Moved here out of
 * `backlog/useBacklogCuts.ts`, which still calls it over the rows ON SCREEN;
 * the Automation foot calls it over a repo's whole non-archived list.
 *
 * - **Where a row runs** (`runGroupKey`): `""` = a session of its own; a live
 *   session's id = typed into that session; `CLOSED_GROUP` = aimed at a session
 *   that closed and HELD there (nothing re-aims it) — unless the row reopens
 *   its conversation, which runs in a session of its own.
 * - **Not next** (`clockAhead`): a `manual` row (only its own `fire` starts it)
 *   or a row whose instant is still ahead — its clock is next, not it.
 * - With auto ON, each group's first queued row that is not clock-ahead is
 *   next; the closed group is not a queue and has no next. Auto OFF ⇒ none.
 */
import type { BacklogItem } from "@waterplane/shared";

/** Group key for rows aimed at a session that has since closed. */
export const CLOSED_GROUP = "__closed";

/** Where a row will run, given the ids of the RUNNING sessions in its repo. */
export function runGroupKey(it: BacklogItem, repoSessionIds: ReadonlySet<string>): string {
  if (!it.targetSessionId) return "";
  if (repoSessionIds.has(it.targetSessionId)) return it.targetSessionId;
  return it.reopensConv ? "" : CLOSED_GROUP;
}

/** A row auto will not start next because something else must come first. */
export function clockAhead(it: BacklogItem, now: number): boolean {
  return !!it.manual || (!!it.at && (it.at.nextAt == null || it.at.nextAt > now));
}

/**
 * The ids auto starts next, over `items` in run order (one per group). The
 * caller decides which rows: the backlog passes the rows on screen, the
 * Automation foot a repo's non-archived rows.
 */
export function nextFireIdsOf(
  items: readonly BacklogItem[],
  repoSessionIds: ReadonlySet<string>,
  auto: boolean,
  now: number,
): Set<string> {
  const out = new Set<string>();
  if (!auto) return out;
  const taken = new Set<string>();
  for (const it of items) {
    const g = runGroupKey(it, repoSessionIds);
    if (g === CLOSED_GROUP || taken.has(g)) continue;
    if (it.status === "queued" && !clockAhead(it, now)) { taken.add(g); out.add(it.id); }
  }
  return out;
}
