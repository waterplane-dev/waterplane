/**
 * The schedule ↔ backlog seam, in words.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
/**
 * **The schedule ↔ backlog seam, in words — one place, both directions.**
 *
 * These two lists are the same subject read at two moments: a schedule's entire
 * job is to write backlog rows, and a backlog row very often came from one. On
 * screen neither named the other, so the join lived only in a person's head —
 * "I know 'weekly security sweep' is a rule, so this 03:00 item must be from
 * it" — which is exactly the complaint that produced this.
 *
 * Three sentences, and they are here rather than inline in two sheets and an
 * App arm for `ageBucket`'s reason: the label on a chip and the label in the
 * filter bar the chip OPENS have to be the same claim about the same rule, and
 * a second copy of either is how a tap starts describing something else.
 *
 *  - `fromScheduleWords` — the chip on the backlog row (item → rule).
 *  - `scheduleRuleLabel` — what the Schedules filter bar then says it is
 *    showing, so the tap and the destination agree.
 *  - `scheduleItemsLabel` — the other direction: what the Backlog's filter bar
 *    says when a schedule card's *backlog · 1 item* opened it.
 */
export function fromScheduleWords(name: string): string {
  return `from the schedule “${name}”`;
}
export function scheduleRuleLabel(name: string): string {
  return `the schedule “${name}”`;
}
export function scheduleItemsLabel(name: string): string {
  return `written by the schedule “${name}”`;
}
/**
 * …and the third case, which the seam above cannot name: the "schedule" a row
 * came from is a **timed one-off that is now a backlog row of its own**.
 *
 * Recurrence decides the list, so a one-off aimed at one place stopped being a
 * `ScheduleEntry` — and eight rows on this desktop had already fired and
 * written a child before that was true. Their children carry
 * `origin: schedule:<parentId>`, and the lookup that resolves it reads
 * `schedules`, which no longer lists the parent: every one of those *from the
 * schedule “x”* chips went blank on the day the build shipped.
 *
 * The parent is not gone — the host sets it aside on first boot under the new
 * build, because the CHILD is the account of the work — so the chip survives
 * and its tap opens the parent where it actually lives: its repo's backlog,
 * cut to that one id (an ids cut takes the unhidden base, archived included,
 * which is the whole reason that rule exists).
 */
export function scheduleParentLabel(name: string): string {
  return `the timed one-off “${name}” that wrote this — set aside, because this row is the account of it`;
}
