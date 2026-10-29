/**
 * The week-end burn sheet's decisions, pure. The sentences about WHEN and WHY
 * (`plan.reasonText`, `stoppedText`, `unavailableText`) are the host's and the
 * shared module's, printed as they arrive; what is worded here is only what the
 * phone itself decides: which verb the save button is, whether "same as last
 * week" is offered, and what a running repo's row says.
 */
import type { WeekBurnStatus } from "@waterplane/shared";
import { isWeekBurnOrigin, repoLabel, twinWheres, type BacklogItem } from "@waterplane/shared";

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
  if (picked > 0) return { kind: "save", label: pickedThisWeek ? "Save this week's pick" : "Pick these for this week" };
  if (pickedThisWeek) return { kind: "cancel", label: "Cancel this week" };
  return { kind: "none", why: "Tick a repo to spend this week's budget on it." };
}

/** "Wed 18:00": an ENGLISH weekday (the sentence is English; the phone's locale is not) and the sheet's own clock. */
export function startDay(ts: number): string {
  const day = new Date(ts).toLocaleDateString("en-US", { weekday: "short" });
  const t = new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day} ${t}`;
}

/** "in 3 days", "in 5 h", "in 40 min", "now": relative, so no zone is needed. */
export function inWords(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return "now";
  if (min < 90) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

/** The sheet's one start line: `Starts Wed 18:00 · in 3 days`. */
export function startLine(startAt: number, now: number): string {
  return `Starts ${startDay(startAt)} · ${inWords(startAt - now)}`;
}

export function savedToast(picked: number, startAt?: number | null): string {
  if (picked <= 0) return "Cancelled for this week. Items already running finish.";
  const base = `${picked} repo${picked === 1 ? "" : "s"} picked for the week-end burn`;
  return startAt != null ? `${base} · starts ${startDay(startAt)}` : `${base}.`;
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

/**
 * What the burn DOES, as numbered steps at the top of the sheet: a checkbox
 * with no consequence named reads as a mystery (owner, 2026-10-26), and one
 * paragraph of it still did (owner, 2026-10-29: "I don't understand at all how
 * it works and what will be executed"). `start` is `startLine`'s words or null
 * while there is no plan.
 */
export function howItWorks(a: { start: string | null; maxPerRepo: number | null; stopPct: number }): string[] {
  const cap = a.maxPerRepo != null ? `up to ${a.maxPerRepo} a week` : "a few a week";
  return [
    `${a.start ? `${a.start.replace(/^Starts/, "From")}, the` : "From the start time, the"} desktop opens a fresh Claude session in each ticked repo — one per repo at a time, the next only after the last one ends, ${cap}. Nobody watches them.`,
    "Each session gets the prompt below: what to work on (yours, or the repo's weakest health reading), then fixed safety rules.",
    "It makes one small change, runs the repo's tests and commits on the current branch only if they pass. Nothing is pushed — the commits wait in Git for you.",
    `No new session starts once the week is at ${a.stopPct}% or resets within 20 min. One already running finishes.`,
  ];
}

export type TaskMode = "health" | "own";

export interface BurnRepo { worktreePath: string; repoName: string; branch: string; isPrimary: boolean; where?: string }
export interface BurnRow { dir: string; title: string; where?: string }

/**
 * The repos the sheet offers. A burn commits on a repo's current branch, so a
 * linked worktree (an agent's leftover `worktree-agent-…`) is not a place to
 * pick — it is listed only when it is already picked, so a pick is never hidden.
 * Two clones with one name (`ciqkit` twice — on 2026-10-28 a burn went to the
 * rewrite leftover) are titled by shared `repoLabel` (`ciqkit · garmin/`) and
 * carry their whole path as `where`. The host's `where` is used; an older host
 * sends none, so the primaries are compared here with the same `twinWheres`.
 */
export function burnRows(repos: readonly BurnRepo[], picked: readonly string[]): { rows: BurnRow[]; hidden: number } {
  const shown = repos.filter((r) => r.isPrimary || picked.includes(r.worktreePath));
  const local = twinWheres(repos.filter((r) => r.isPrimary).map((r) => ({ name: r.repoName, dir: r.worktreePath })));
  const rows: BurnRow[] = shown.map((r) => {
    const where = r.where ?? (r.isPrimary ? local.get(r.worktreePath) : undefined);
    const name = repoLabel({ repoName: r.repoName, where });
    return { dir: r.worktreePath, title: r.isPrimary ? name : `${name} · ${r.branch}`, ...(where ? { where: r.worktreePath } : {}) };
  });
  return { rows, hidden: repos.length - shown.length };
}

/** The rows the burn wrote in one repo, any state — the ids the backlog cut opens, so the count is the cut. */
export function burnRowIds(items: readonly Pick<BacklogItem, "id" | "repoDir" | "origin">[], dir: string): string[] {
  return items.filter((it) => it.repoDir === dir && isWeekBurnOrigin(it.origin)).map((it) => it.id);
}

/** The line under the list for worktrees left out; absent for none. */
export function hiddenWorktreesNote(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `${hidden} agent worktree${hidden === 1 ? "" : "s"} not listed — a burn commits on a repo's own branch.`;
}
