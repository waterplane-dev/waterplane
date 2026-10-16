/**
 * The CUT: what a status/age/kind/clock/ids filter keeps, the sentence the filter bar says
 * about it, and the one predicate the archived hide asks (`hiddenByArchive`).
 *
 * Part of `backlogFilter.ts`, the barrel every caller imports. Pure, and its
 * imports carry `.ts` because `node --test` loads it straight off the source.
 */
import type { BacklogItem, BacklogStatus } from "@waterplane/shared";
import { AGE_LABEL, categoryBucket, type BacklogAge, type CategoryBucket, withinAge } from "./rowBuckets.ts";

/**
 * Every backlog mutation's refusal with the link down. The backlog lives on
 * the desktop, so nothing here changed — and adding still queues. ONE copy:
 * core's send and compose read it here, and the activity and backlog features
 * re-export it from their `logic.ts` (a feature never imports another).
 */
export const BL_OFFLINE = "no connection — the backlog lives on the desktop, so nothing here changed. Adding still queues.";

/** The refusal for a row the DESKTOP is holding (a handed-over launch, a
 *  held intent) while the link is down — one wording wherever it is said. */
export const HELD_OFFLINE = "no connection — the desktop is holding this one. It stays held; try again when the link is back.";

export interface BacklogFilter {
  status: BacklogStatus | null;
  age: BacklogAge | null;
  /**
   * The KIND cut — one of the four, or `none` for the rows nobody has said a
   * kind for. `null` is "no kind filter", which is a different statement from
   * `"none"`: the first shows everything, the second shows exactly the rows
   * with nothing said about them.
   */
  category: CategoryBucket | null;
  /**
   * An explicit set of ids — the cut a COUNT ON A CONTROL opens.
   *
   * A count on a control (an applied assessment's *N waiting*, a schedule's
   * rows) is a number, and CLAUDE.md's rule is that a tap on a count shows
   * exactly those things and never the unfiltered list for the reader to
   * re-derive them from. The caller carries the ids and this is where they
   * land, so the number and the cut come from the one place — the same reason
   * `ageBucket` is the only thing that buckets an age.
   *
   * The other dimensions still apply on top of it, so an ids cut with "failed"
   * on shows the failed ones of those three and the bar says "3 of N" about
   * whatever it actually drew.
   *
   * **An ids cut may name rows the default view HIDES** (an archived row the
   * cut was opened on), so the base the caller filters must be the unhidden one —
   * that is the caller's job (`Backlog.tsx` passes `p.items` without the
   * archived cut), not this predicate's: a membership test that also knew about
   * a view toggle would be two rules in one function.
   *
   * `null` is "no ids filter". An EMPTY ARRAY is a filter that shows nothing,
   * deliberately: the other reading would make a cut meant to show two specific
   * rows silently show the whole repo the moment the ids went missing, and a
   * filter that fails open is how a count stops describing its own tap.
   */
  ids: string[] | null;
  /**
   * **On a clock** — the rows whose WHEN is an instant somebody set.
   *
   * A boolean and not a bucket, because the axis has one interesting side: a
   * person asks "what is scheduled here", never "what is not". `false` is not a
   * filter for the untimed rows — it is `null`, no filter, for the same reason
   * the other three read `null` as "every value".
   */
  clock: boolean | null;
}
export const NO_BACKLOG_FILTER: BacklogFilter = { status: null, age: null, category: null, ids: null, clock: null };
export const hasBacklogFilter = (f: BacklogFilter): boolean => !!(f.status || f.age || f.category || f.ids || f.clock);

export function matchesBacklogFilter(it: BacklogItem, f: BacklogFilter, now: number): boolean {
  if (f.ids && !f.ids.includes(it.id)) return false;
  if (f.status && it.status !== f.status) return false;
  if (f.age && !withinAge(it.createdAt, f.age, now)) return false;
  if (f.category && categoryBucket(it) !== f.category) return false;
  if (f.clock && !it.at) return false;
  return true;
}

/**
 * What the filter bar says it is showing. One sentence, every dimension.
 *
 * An ids cut NAMES ITSELF rather than describing a cut: "merged into “fix the
 * flaky test”" is what the person tapped and what they are looking at, where
 * "showing 3 items" would make them work out which three. `idsLabel` is the
 * caller's, because only the sheet knows which side of a merge was tapped — the
 * merged row's chip says one thing, an original's chip says the other — and a
 * label this file invented would be the same sentence for both.
 *
 * Without one it falls back to `made from these`, which is true of every ids cut
 * this app opens and claims nothing it cannot back up.
 */
export function backlogFilterSentence(f: BacklogFilter, idsLabel?: string): string {
  const parts: string[] = [];
  if (f.status) parts.push(f.status);
  // The kind reads as a NOUN here and as a bare word on the chip, because the
  // bar is a sentence and the chip is a label: "showing failed · bugs" is what
  // the screen is showing, where "showing failed · bug" describes one row. The
  // `none` bucket says what it is rather than naming a kind — `with no kind`,
  // never "showing no kind", which reads as a list with nothing in it.
  if (f.category) parts.push(f.category === "none" ? "with no kind" : `${f.category === "bug" ? "bug" : f.category}s`);
  if (f.clock) parts.push("on a clock");
  if (f.age) parts.push(f.age === "older" ? "added over a week ago" : `added in the ${AGE_LABEL[f.age]}`);
  if (f.ids) {
    const head = idsLabel?.trim() || "made from these";
    return parts.length ? `${head} · ${parts.join(" · ")}` : head;
  }
  return parts.length ? `showing ${parts.join(" · ")}` : "showing everything";
}

/**
 * **A row the archived cut may not hide: one that is running.**
 *
 * A row can be archived while it runs (the smart pick's undo did exactly that
 * until it was removed 2026-10-16; an archive tap on a running row still
 * does). But the sheet's default base, the repo counts and the composer's
 * badge all cut on `archived` alone, so such a row vanished from the list
 * mid-run and dropped the badge by one for a session that is still typing. Nothing was destroyed; "every row says what happened to it" simply
 * stopped being true for the one row doing something.
 *
 * One predicate for all three sites, for `ageBucket`'s reason: a second copy of
 * this edge is how a badge stops describing the list it opens.
 */
export function hiddenByArchive(it: Pick<BacklogItem, "archived" | "status">): boolean {
  return !!it.archived && it.status !== "running";
}
