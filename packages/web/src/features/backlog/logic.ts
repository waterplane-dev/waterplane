/**
 * The backlog feature's pure half: the joins that let a backlog row say which
 * schedule wrote it, and the receipts App carried inline. Pinned by
 * `logic.test.mjs`.
 */
import { isTimedWorkRow, scheduleActionText, typedName, type Intent, type ScheduleEntry } from "@waterplane/shared";
import type { ComponentProps } from "react";
import type { Backlog } from "../../Backlog.tsx";
import { NO_BACKLOG_FILTER } from "../../backlogFilter.ts";

/** Every backlog mutation's refusal with the link down — one copy (`backlogFilter.ts`). */
export { BL_OFFLINE } from "../../backlogFilter.ts";

/** What the sheet is cut to — `BacklogProps["cut"]`, named here because a
 *  feature reaches the sheet's types only through the top-level module. */
export type BacklogCut = ComponentProps<typeof Backlog>["cut"];

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


// ── The cut on screen ────────────────────────────────────────────────
// One value (`backlogCut` in store.ts), written by the doors below, by the
// sheet's own taps and keystrokes, cleared by `onLeave` and put back by `keep`.
// There is no second copy for Back to restore from, so it restores the screen.

/** The cut a fresh sheet shows: the sheet's own repo choice, no search, no chips. */
export const NO_CUT: BacklogCut = { repoDir: null, text: "", filter: NO_BACKLOG_FILTER, idsLabel: undefined };

/** On a repo named on the launcher: that repo, and no ids cut — an ids cut names
 *  rows of the repo it was opened from. Status, age, kind and clock mean the
 *  same in every repo and stay — the rule the sheet's own picker follows. */
export function cutForRepo(c: BacklogCut, dir: string): BacklogCut {
  return { ...c, repoDir: dir, filter: c.filter.ids ? { ...c.filter, ids: null } : c.filter, idsLabel: undefined };
}

/** On a repo — the session's, the compose badge's — WITHOUT touching the cut
 *  when it is already that repo; `null` keeps the repo already chosen. */
export function cutInRepo(c: BacklogCut, dir: string | null | undefined): BacklogCut {
  return !dir || dir === c.repoDir ? c : cutForRepo(c, dir);
}

/** On an explicit cut from anywhere: exactly what the tap asked for, never merged
 *  with the chips left on screen — and never the typed search, which is the
 *  person's words (`local/no-draft-clobber`). */
export function cutOpenedOn(c: BacklogCut, cwd: string, ids?: string[], label?: string): BacklogCut {
  return ids?.length
    ? { ...c, repoDir: cwd, filter: { ...NO_BACKLOG_FILTER, ids }, idsLabel: label ?? "made from these" }
    : { ...c, repoDir: cwd, filter: NO_BACKLOG_FILTER, idsLabel: undefined };
}

/** The sheet stopped being on top: the cut was the tap, not a setting. The repo
 *  stays — it is where a plain open with no session lands (a door that
 *  names a repo, `openBacklogIn`, overrides it). */
export function cutLeft(c: BacklogCut): BacklogCut {
  return { ...NO_CUT, repoDir: c.repoDir };
}
