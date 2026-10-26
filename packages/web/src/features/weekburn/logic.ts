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
  if (picked > 0) return { kind: "save", label: pickedThisWeek ? "Change this week's pick" : "Pick these for this week" };
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
 * What ticking a repo DOES, said above the list: a checkbox with no consequence
 * named reads as a mystery (owner, 2026-10-26).
 */
export const PICK_NOTE =
  "A ticked repo gets unattended sessions from the start time until the stop line, one at a time. " +
  "Each makes one small fix to the repo's weakest reading and commits it on the current branch, only if the tests pass. Nothing is pushed.";

export interface BurnRepo { worktreePath: string; repoName: string; branch: string; isPrimary: boolean }
export interface BurnRow { dir: string; title: string; where?: string }

/**
 * The repos the sheet offers. A burn commits on a repo's current branch, so a
 * linked worktree (an agent's leftover `worktree-agent-…`) is not a place to
 * pick — it is listed only when it is already picked, so a pick is never hidden.
 * Two clones with one name (`ciqkit` twice) get `where`: the shortest trailing
 * part of their paths that tells them apart (`garmin/ciqkit`, `out-ciqkit/ciqkit`).
 */
export function burnRows(repos: readonly BurnRepo[], picked: readonly string[]): { rows: BurnRow[]; hidden: number } {
  const shown = repos.filter((r) => r.isPrimary || picked.includes(r.worktreePath));
  const rows: BurnRow[] = shown.map((r) => ({
    dir: r.worktreePath,
    title: r.isPrimary ? r.repoName : `${r.repoName} · ${r.branch}`,
  }));
  const parts = (dir: string) => dir.split("/").filter(Boolean);
  for (const row of rows) {
    const twins = rows.filter((o) => o.title === row.title);
    if (twins.length < 2) continue;
    const mine = parts(row.dir);
    for (let n = 2; n <= mine.length; n++) {
      const tail = mine.slice(-n).join("/");
      if (twins.every((o) => o === row || parts(o.dir).slice(-n).join("/") !== tail)) { row.where = tail; break; }
    }
    row.where ??= row.dir;
  }
  return { rows, hidden: repos.length - shown.length };
}

/** The line under the list for worktrees left out; absent for none. */
export function hiddenWorktreesNote(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `${hidden} agent worktree${hidden === 1 ? "" : "s"} not listed — a burn commits on a repo's own branch.`;
}
