/**
 * Re-time many: the pick list's eligibility, counts and receipts.
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem } from "@waterplane/shared";
import { describeRule } from "@waterplane/shared";
import { SHEET } from "../sheetNames.ts";

// ── Re-time many ──────────────────────────────────────────────────────

/**
 * **Which rows a bulk re-time can touch** — ONE edge for the checkbox, the
 * count on the button and the frames the tap sends, so the number and the cut
 * cannot come from two readings of "eligible".
 *
 * The host's `update()` is the authority and this is its reading: a running
 * row refuses (an edit would describe a run that never happened), a settled one
 * refuses, and a FAILED row is revived by a new trigger only when it was a
 * timed one — a failed row with no clock is *run it again*'s, never this verb's.
 * Archived rows are out: a clock on something filed away is a clock nobody sees.
 */
export function retimeEligible(it: BacklogItem): boolean {
  if (it.archived) return false;
  if (it.status === "running" || it.status === "done") return false;
  if (it.status === "failed") return !!it.at && !it.calledOff; // the host refuses to re-arm a call-off
  return true;
}
/** The toggle that turns the list into a pick list. */
export const RETIME_PICK_LABEL = "pick to re-time";
/**
 * What the bar says above the button. Counted against the rows that COULD be
 * picked, and the ones that could not are said in TEXT with the reason — a row
 * with no checkbox and no sentence is a row the reader thinks the tap missed.
 */
export function retimeNote(picked: number, eligible: number, shown: number): string {
  const head = `${picked} of ${eligible} picked`;
  const rest = shown - eligible;
  const skipped = rest > 0
    ? ` · ${rest} ${rest === 1 ? "has" : "have"} no box: running, finished, archived, or failed with no clock to move`
    : "";
  return `${head}${skipped}. A new when replaces each one's — the words, where it goes and the place in the list stay.`;
}
/** Nothing picked: the button is absent and this says why. */
export const RETIME_NONE_PICKED = "tick the rows to move — the button appears with the count";
/** One tap, one receipt — `dropClocksToast`'s rule. */
export function retimeToast(n: number, when: string): string {
  return n === 1 ? `re-timed — the same row, now ${when}` : `re-timed ${n} — the same rows, now ${when}`;
}
/**
 * **The receipt for a re-time that took the CLOCK OFF** (next in line, when
 * it's free, after another). Such a row leaves Schedules' *On a clock* list and
 * the launcher's clock chip and is counted on its repo's ⌛ chip instead — a
 * move nothing on screen used to announce, so four rows re-timed to "now" read
 * as gone. Says where they went, and what is holding them when something is.
 */
export function retimeQueuedToast(n: number, when: string, repos: string[], heldUntil?: string | null): string {
  const head = n === 1 ? `re-timed — now ${when}` : `re-timed ${n} — now ${when}`;
  const where = repos.length === 1 ? ` on ${repos[0]}` : repos.length > 1 ? ` on each repo's row` : "";
  const off = `. Off the clock list: ${n === 1 ? "it waits" : "they wait"} in the queue, ⌛${where}`;
  const held = heldUntil ? ` — held by the budget until ${heldUntil}` : "";
  return `${head}${off}${held}.`;
}
/** Under the When editor while re-timing to a when with no clock. */
export function retimeOffClockNote(n: number): string {
  return n === 1
    ? `No clock: it leaves the ${SHEET.automation} clock list and waits in its repo's queue — the ⌛ chip on the repo's row.`
    : `No clock: these leave the ${SHEET.automation} clock list and wait in their repo's queue — the ⌛ chip on the repo's row.`;
}
/**
 * The ⌛ chip's words beyond the count: what is holding the queue, when the
 * BUDGET holds some of it. Empty when nothing is budget-held, so the chip is a
 * bare number exactly when there is nothing more to say.
 */
export function queuedChipHeld(n: number, held: number): string {
  if (held <= 0) return "";
  return held >= n ? " · budget" : ` · ${held} budget`;
}
/**
 * **The rows on ONE clock, as one pick** — "move every one of the 20 waiting
 * for the reset past it" was 20 ticks. A count on a control is a filter: the
 * number on the button is exactly the ids the tap ticks, read as the clock
 * group (`clockGroups`, run order) cut to what is ON SCREEN and `retimeEligible`
 * — never the group's full size, which may hold rows a filter hides or a
 * running one the host refuses. A clock with fewer than two such rows is not
 * offered: one row is its own tick.
 */
export interface ClockPick { key: string; rule: string; ids: string[] }
export function clockPicks(groups: readonly { key: string; items: readonly BacklogItem[] }[],
  retimeable: readonly BacklogItem[]): ClockPick[] {
  const on = new Set(retimeable.map((it) => it.id));
  const out: ClockPick[] = [];
  for (const g of groups) {
    const ids = g.items.filter((it) => on.has(it.id)).map((it) => it.id);
    if (ids.length < 2 || !g.items[0].at) continue;
    out.push({ key: g.key, rule: describeRule(g.items[0].at.rule), ids });
  }
  return out;
}
/** The button: what it ticks, by the clock's own words (`describeRule`). */
export function clockPickLabel(c: ClockPick): string {
  return `re-time the ${c.ids.length} on “${c.rule}”`;
}
