/**
 * The backlog feature's pure half: the joins that let a backlog row say which
 * schedule wrote it, and the receipts App carried inline. Pinned by
 * `logic.test.mjs`.
 */
import { isTimedWorkRow, scheduleActionText, typedName, type Intent, type ScheduleEntry } from "@waterplane/shared";

/** Every backlog mutation's refusal with the link down — one copy (`backlogFilter.ts`). */
export { BL_OFFLINE } from "../../backlogFilter.ts";

export interface ChipRef { id: string; name: string }

/** What a rule is CALLED on a chip, in one place because the maps below answer
 *  the same question and a chip that disagreed with the card it opens would be
 *  drift. `typedName` is the same test the card, the row and Activity use: a
 *  rule nobody named carries a slice of its own prompt in that field, and a
 *  chip is no place for a 120-character truncation. */
export function schedChipName(e: ScheduleEntry): string {
  return typedName(e.name, scheduleActionText(e.action)) ?? (e.name.length > 40 ? `${e.name.slice(0, 40)}…` : e.name);
}

/**
 * **Which schedule wrote which backlog row** — two answers off the rule list.
 *
 * `byChild`: `lastResult.childId` remembers the LAST item per rule and nothing
 * older, exact and narrow (a label match would name the wrong rule the first
 * time a person typed that label themselves — a heuristic degrades to absent,
 * never to a wrong link). `byId`: the same answer by ENTRY id, for the row's
 * own `origin` (`scheduleItemOrigin(entryId)`), read through
 * `scheduleIdFromOrigin`, never a bare prefix test.
 */
export function scheduleMaps(entries: readonly ScheduleEntry[]): { byId: Map<string, ChipRef>; byChild: Map<string, ChipRef> } {
  const byId = new Map<string, ChipRef>();
  const byChild = new Map<string, ChipRef>();
  for (const e of entries) {
    const ref = { id: e.id, name: schedChipName(e) };
    byId.set(e.id, ref);
    const cid = e.lastResult?.childId;
    if (cid) byChild.set(cid, ref);
  }
  return { byId, byChild };
}

/**
 * **The same two answers off the DURABLE rows — for the legacy parents the
 * entry list no longer holds.** A one-off aimed at one place is a backlog row
 * now, not an entry, and rows that fired while it still was one carry an
 * `origin` pointing at a row `schedules` cannot answer for. Read AFTER the entry
 * maps, never instead: a live rule is the better answer wherever there is one.
 * The name is `title` — the caller passes `activityRows`' `intentTitle`, the
 * reading Activity and the chain picker use.
 */
export function clockParentsOf(intents: readonly Intent[], title: (i: Intent) => string): { byId: Map<string, ChipRef>; byChild: Map<string, ChipRef> } {
  const byId = new Map<string, ChipRef>();
  const byChild = new Map<string, ChipRef>();
  for (const i of intents) {
    if (!isTimedWorkRow(i)) continue;
    const t = title(i);
    const e = { id: i.id, name: t.length > 40 ? `${t.slice(0, 40)}…` : t };
    byId.set(i.id, e);
    const cid = i.result?.childId;
    if (cid) byChild.set(cid, e);
  }
  return { byId, byChild };
}

/** The receipt for a run of `assess.run`, scoped or whole. */
export function assessRunToast(scoped: readonly string[] | undefined): string {
  return scoped
    ? `reading the repo to judge ${scoped.length === 1 ? "this one" : `these ${scoped.length}`} — this takes a while; the proposal lands here`
    : "reading the repo — this takes a while; the proposal lands here";
}

/** The receipt for *run these N again* — queued offline, or said once. */
export function runAgainQueuedToast(n: number): string {
  return `queued — ${n === 1 ? "it goes" : `all ${n} go`} back in the queue when the link is back`;
}

