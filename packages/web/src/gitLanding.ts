/**
 * Where the git screen opens when something other than its own button opened
 * it: the "Explained · repo" notification lands on the Explain view's answer
 * rather than the Review sheet above it, and a failed pull/push notification
 * lands on THAT failure (a repo keeps one failed push per branch, so the newest
 * is not always the one tapped — review A3b).
 *
 * The Explain landing is a ONE-SHOT handed from the opener to `GitView`'s first
 * render, so the nav API (`openGit(repoId)`) needs no second argument.
 *
 * The repo the screen is open on and the tapped FAILURE are not one-shots and not App state:
 * they are the git ROUTE ENTRY's (`openOn`/`screenParams` in `backStep.ts`). A one-shot taken on
 * mount was lost under the Send sheet or the file tree (review A3c ML1); a slot beside the route
 * outlived the screen on every exit that was not its own close — the phone's Back kept the old
 * repo and record, so the toolbar's "diff" re-opened the previous repo on its old failure (review
 * A3d, bughunt 2026-10-29). Now a tap files them with the entry it opens, Back off the screen
 * lands on an entry that holds none, and Back from Send/browse lands on the git entry again.
 */
import { useSyncExternalStore } from "react";
import { gitVerbWords, repoLabel } from "@waterplane/shared";
import { openOn, screenParams, subscribeScreenParams } from "./backStep.ts";
import type { ListRead } from "./listRead.ts";

let pending: string | null = null;

/** The next git screen opened for `repoId` starts on its Explain view. */
export function landOnExplain(repoId: string): void { pending = repoId; }

/** True once, for the repo `landOnExplain` named. */
export function takeExplainLanding(repoId: string): boolean {
  const hit = pending === repoId;
  pending = null;
  return hit;
}

/** What the git screen on top is open on: a view of its route entry. */
export interface GitRoute { repoId: string; failureId: string | null }

/** The git entry on screen's repo and tapped failure, or null (a bare open: the active repo). */
export function gitRoute(): GitRoute | null {
  const p = screenParams("git");
  return p?.repoId ? (p as unknown as GitRoute) : null;
}

/** The repo the git view shows: its route entry's, else the session's under it, else the `?repo=`
 *  focus the URL names (`focus`, a `repoLabel`; the primary checkout over its worktrees). The session
 *  beats the focus because a focus resolves to the PRIMARY checkout: a session in one of its worktrees
 *  would get a commit screen (push and pull included) on a checkout it is not in (review R2-2c).
 *  Null when none of them names one — never a guess: the newest failure opened the commit screen on
 *  a repo nobody asked for (review R2-2b M2). Null draws `GitNoRepo`, never an empty screen. */
export function gitViewRepoId(entryRepo: string | null, focus: string | null, activeRepoId: string | null, repos: readonly { id: string; repoName: string; where?: string; isPrimary?: boolean }[]): string | null {
  if (entryRepo) return entryRepo;
  if (activeRepoId) return activeRepoId;
  if (!focus) return null;
  const named = repos.filter((r) => repoLabel(r) === focus);
  return (named.find((r) => r.isPrimary !== false) ?? named[0])?.id ?? null;
}

/** What the git screen says when `gitViewRepoId` is null: why, and the way back. `list` is the
 *  desktop's repo list as `listRead` reads it — an unread one is not a claim that anything is gone,
 *  whatever named the repo, and a read empty one is (a host with no repos waited for ever when this
 *  read the row count: design round 2026-10-30 W4). `session` is whether a session is open under
 *  the screen: its repo is null until the list loads, or for good when its folder is no repo the
 *  desktop lists — never "no session is open" over one (review R2-2c). */
export function gitNoRepoWords(focus: string | null, list: ListRead = "rows", session = false): string {
  const why = list === "unread"
    ? `Waiting for the desktop's repo list${focus ? ` to find ${focus}` : session ? " to find this session's repo" : ""}.`
    : session
      ? "The open session's folder is not one of this desktop's repos, so there is nothing to review."
      : focus
        ? `No repo called ${focus} is on this desktop's list, so there is nothing to review.`
        : "Nothing names a repo for this screen — no session is open and the link it came back on carried none — so there is nothing to review.";
  return `${why} Go back, then open a session or a repo's git view from the launcher.`;
}

/** `gitRoute` as a hook — the same object until the entry on screen changes. */
export function useGitRoute(): GitRoute | null {
  return useSyncExternalStore(subscribeScreenParams, gitRoute);
}

/** The git screen of `repoId` shows the stored failure with item id `id` — or, with `null`,
 *  the newest, as from its own button. Set by every git notification tap. */
export function focusFailure(repoId: string, id: string | null): void {
  const cur = gitRoute();
  if (cur?.repoId === repoId && cur.failureId === id) return;
  openOn("git", { repoId, failureId: id });
}

/** The failure the git screen of `repoId` is on, or null. A READ of the entry: a remount
 *  (Back from the Send sheet or the file tree) reads the same answer. */
export function failureFocus(repoId: string): string | null {
  const cur = gitRoute();
  return cur?.repoId === repoId ? cur.failureId : null;
}

/** Its focused record was dismissed: the same repo, on the newest. */
export function clearFailureFocus(): void {
  const cur = gitRoute();
  if (cur?.failureId) openOn("git", { repoId: cur.repoId, failureId: null });
}

export const subscribeFailureFocus = subscribeScreenParams;

/** `failureFocus` as a hook: the view re-renders when a tap re-targets it while open. */
export function useFailureFocus(repoId: string): string | null {
  return useSyncExternalStore(subscribeScreenParams, () => failureFocus(repoId));
}

/** A plain open of the git screen ON `repoId` (repo chip, count badges, What's new): the
 *  newest failure, never a record a previous tap focused. */
export function openGitPlain(repoId: string, open: (repoId: string) => void): void {
  openOn("git", { repoId, failureId: null });
  open(repoId);
}

/** The session toolbar's door to the git view (the diff button, the untracked count): an ASK on
 *  the session's repo, never a bare `setOverlay("git")` — a git entry for another repo under the
 *  screen on top (wide layout keeps the toolbar beside a panel) would be unwound to and show ITS
 *  repo (review R2-2 b). False, opening nothing, when the session has no known repo. */
export function openToolbarGit(activeRepoId: string | null, setOverlay: (o: "git") => void): boolean {
  if (!activeRepoId) return false;
  openGitPlain(activeRepoId, () => setOverlay("git"));
  return true;
}

/** What a tap on a git notification does, in order: the plain open first, THEN the tapped
 *  failure — so a view already open on that repo re-targets, and a closed one opens on it. */
export function landOnGit(t: { repoId: string; failureId?: string; explain?: boolean }, openGit: (repoId: string) => void): void {
  if (t.explain) landOnExplain(t.repoId);
  openGit(t.repoId);
  focusFailure(t.repoId, t.failureId ?? null);
}

/**
 * The stored failure the git view shows. No tapped id (an old link, the repo's chip, the
 * view's own button): the newest, `gitFailed`. A tapped id: exactly that record out of
 * `gitFailures` — and when it is no longer there (handled meanwhile) NONE, never another
 * record under its name. An older host sends no list: its one record is all there is.
 */
export function storedFailure<T extends { id: string }>(list: readonly T[] | undefined, newest: T | undefined, tappedId: string | null): T | undefined {
  if (!tappedId || !list) return newest;
  return list.find((f) => f.id === tappedId);
}

/** The stored failure's sentence, worded off its own record: the branch when the host filed
 *  one ("push of feature"), and what clears it — a push of THAT branch; with no branch on
 *  record (detached HEAD, an older host) any push that goes through, which is what clears it. */
export function storedFailureWords(f: { verb: "pull" | "push"; branch?: string }, ago: string): string {
  const what = gitVerbWords(f.verb, f.branch);
  const clears = f.verb === "pull" ? "A pull" : f.branch ? `A push of ${f.branch}` : "A push";
  return `The last ${what} failed ${ago}. ${clears} that goes through clears it; dismiss clears it now.`;
}
