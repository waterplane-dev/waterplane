/**
 * The week-end burn sheet's decisions, pure. The sentences about WHEN and WHY
 * (`plan.reasonText`, `stoppedText`, `unavailableText`) are the host's and the
 * shared module's, printed as they arrive; what is worded here is only what the
 * phone itself decides: which verb the save button is, whether "same as last
 * week" is offered, and what a running repo's row says.
 */
import type { WeekBurnStatus } from "@waterplane/shared";

/** The chips for the stop line; the saved value is added when it is none of these. */
export const STOP_CHOICES: readonly number[] = [80, 90, 95, 100];

export function stopChoices(saved: number): number[] {
  return STOP_CHOICES.includes(saved) ? [...STOP_CHOICES] : [...STOP_CHOICES, saved].sort((a, b) => a - b);
}

/** Add the dir when absent, drop it when present; order is the pick order. */
export function toggleDir(list: readonly string[], dir: string): string[] {
  return list.includes(dir) ? list.filter((d) => d !== dir) : [...list, dir];
}

/** Last week's repos still on this desktop, in last week's order. */
export function lastWeekHere(status: WeekBurnStatus, known: readonly string[]): string[] {
  return status.prefs.lastRepos.filter((d) => known.includes(d));
}

/** "Same as last week" is offered only while this week has no pick and last week's repos still exist. */
export function sameAsLastOffered(status: WeekBurnStatus, known: readonly string[]): boolean {
  return !status.pickedThisWeek && lastWeekHere(status, known).length > 0;
}

export type SaveVerb =
  | { kind: "save"; label: string }
  | { kind: "cancel"; label: string }
  /** Nothing picked and nothing to cancel: the verb is a sentence, never a dimmed button. */
  | { kind: "none"; why: string };

export function saveVerb(picked: number, pickedThisWeek: boolean): SaveVerb {
  if (picked > 0) return { kind: "save", label: pickedThisWeek ? "Update this week's burn" : "Start this week's burn" };
  if (pickedThisWeek) return { kind: "cancel", label: "Cancel this week" };
  return { kind: "none", why: "Tick a repo to spend this week's budget on it." };
}

export function savedToast(picked: number): string {
  return picked > 0
    ? `Week-end burn set for ${picked} repo${picked === 1 ? "" : "s"}.`
    : "Cancelled for this week. Items already running finish.";
}

export const SAME_AS_LAST_TOAST = "Same repos as last week. The week-end burn is set.";

/** One running row: how many packages were posted and whether one is live now. */
export function runningWords(r: { posted: number; live: string | null; stoppedText?: string }): string {
  const posted = r.posted === 0 ? "nothing posted yet" : `${r.posted} posted`;
  const parts = [posted];
  if (r.live) parts.push("one running now");
  if (r.stoppedText) parts.push(r.stoppedText);
  return parts.join(" · ");
}

export const BRANCH_NOTE =
  "Each item commits on the repo's current branch, once its tests pass. Nothing is pushed.";
