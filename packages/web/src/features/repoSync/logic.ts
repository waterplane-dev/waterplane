/**
 * Pull, push and sync across every repo — the pure part: which repos a verb
 * touches, and the sentences the sheet and the receipt say.
 */
import type { RepoTarget } from "@waterplane/shared";

export type SyncVerb = "pull" | "push" | "sync";

/** One repo's line in a run. `waiting` = queued behind the others. */
export type RowState =
  | { s: "waiting" }
  | { s: "pulling" }
  | { s: "pushing"; startedAt: number }
  | { s: "ok"; text: string }
  | { s: "failed"; text: string }
  | { s: "skipped"; text: string };

type Counted = Pick<RepoTarget, "ahead" | "behind" | "hasOrigin">;

/** A repo the verbs can act on: an `origin`, and a branch with an upstream
 *  (`ahead` ABSENT = no upstream — nothing to pull from or push to). */
export function syncable(r: Counted): boolean {
  return r.hasOrigin !== false && r.ahead !== undefined;
}

/** The repos a verb runs in. Pull and sync take every syncable repo — the
 *  counts are as of the desktop's last fetch, and the pull fetches first.
 *  Push takes only those with commits out: there is nothing else to send. */
export function targets<R extends Counted>(repos: readonly R[], verb: SyncVerb): R[] {
  const ok = repos.filter(syncable);
  return verb === "push" ? ok.filter((r) => (r.ahead ?? 0) > 0) : ok;
}

export function isBusy(st: RowState | undefined): boolean {
  return !!st && (st.s === "waiting" || st.s === "pulling" || st.s === "pushing");
}

/** The end-of-run receipt: what landed, what failed — every count in words. */
export function doneToast(rows: readonly RowState[]): string {
  const ok = rows.filter((r) => r.s === "ok").length;
  const failed = rows.filter((r) => r.s === "failed").length;
  const skipped = rows.filter((r) => r.s === "skipped").length;
  const parts = [`${ok} repo${ok === 1 ? "" : "s"} done`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} stopped`);
  return parts.join(", ");
}

/** The line under the buttons: what each one is about to do. */
export function planWords(all: number, pushN: number): string {
  if (all === 0) return "No repo here has a branch with an upstream — nothing to pull from or push to.";
  return `Pull fetches and fast-forwards all ${all}; push sends the ${pushN} with commits out, one at a time — each runs its pre-push checks first, which can take minutes. Sync is pull, then push whatever is still ahead.`;
}

/** Repos left out, said rather than silently dropped. */
export function leftOutWords(left: number): string {
  return left > 0 ? `${left} repo${left === 1 ? "" : "s"} without an origin or an upstream not listed.` : "";
}
