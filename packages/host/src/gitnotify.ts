/**
 * A host-run pull or push, told (notifications plan §5b).
 *
 * `git.ts` reports how each run ended (`setGitOutcomeSink`, installed by
 * `main.ts`); this turns it into the feed:
 *
 * - a FAILED pull or push is attention, filed under `gitAttentionKey(repo,
 *   verb)` so the next failure replaces it (one cause counts once), with the
 *   first meaningful line as the body and the whole error kept host-side
 *   (`detail`) for the repo listing's `gitFailed` and the git view;
 * - a failed push is filed WITH the branch and commit it tried to send (`pushHead`), and that
 *   branch IS its slot (`gitPushFailureKey`): a failure on another branch is a second record,
 *   never a replacement (review A3b). It is resolved only by what proves THAT commit went up:
 *   a push of the same branch that succeeds (resolve by that branch's key, "fixed by the 14:02
 *   push"), or — checked for EVERY branch's record when any host-run pull or push ends — the
 *   branch now on its remote (`pushreach.ts`: the commit, or the branch's tip after an amend —
 *   "it went up another way"), also on a minute tick (`startPushFailureWatch`) so a push from a
 *   TERMINAL clears it too (design round 4). Switching to an
 *   in-sync branch proves nothing about the other one, and no listing GET resolves anything
 *   (bughunt 2026-10-29 PR-7). A record with no branch (kept before the identity existed, or a
 *   push from a detached HEAD) is the bare key and the bare tray tag, cleared by the next push
 *   that succeeds and has no failure of its own branch to clear — whose receipt then takes the
 *   bare tag, so the tray entry goes with the record;
 * - a push that SUCCEEDS leaves an information receipt — it ran for minutes;
 * - a pull that succeeds resolves the pull key and raises nothing: the person was
 *   watching it.
 */
import { gitAttentionKey, gitPushFailureKey, parseAttentionKey } from "@waterplane/shared";
import type { GitOutcome } from "./git.js";
import { pushedAlready } from "./pushreach.js";
import { pushFailures, type AttentionStore } from "./attentionstore.js";
import type { ExplainOutcome } from "./explainjob.js";

/** What it needs of the host: `notify` and `resolveAttention`, as on `HostCtx`
 *  (spelled here — a flat module never imports `routes/`). */
export interface GitNotifyDeps {
  notify(kind: "git", p: {
    title: string; body: string; tag: string; open: { to: "git"; repoId: string; verb: "pull" | "push" | "explain" };
    outcome: "ok" | "failed"; key?: string; detail?: string; pushHead?: { branch: string; sha: string };
  }): void;
  resolveAttention(key: string, note: string): number;
  /** The kept attention items — where a failed push's branch and commit are read back.
   *  Absent (a test, an older wiring): a push that succeeds resolves as before. */
  attention?: Pick<AttentionStore, "unhandled">;
}

/** The line a failure's notification shows: for a push, `pushFailureText`'s
 *  "The pre-push check stopped it — <step>" or remote-refusal line comes first
 *  already; otherwise the first non-blank line. Capped for a tray. */
export function gitFailureHeadline(error: string | undefined, max = 200): string {
  const line = (error ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!line) return "No reason was given.";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const hhmm = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const took = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

export async function reportGitOutcome(o: GitOutcome, ctx: GitNotifyDeps): Promise<void> {
  const key = gitAttentionKey(o.repo.id, o.verb);
  const open = { to: "git" as const, repoId: o.repo.id, verb: o.verb };
  // The OS collapses notifications by tag: per branch for a push, or B's receipt would
  // replace A's failure in the tray.
  const bareTag = `git-${o.repo.id}-${o.verb}`;
  let tag = o.verb === "push" && o.head ? `${bareTag}-${o.head.branch}` : bareTag;
  const Verb = o.verb === "push" ? "Push" : "Pull";
  if (!o.ok) {
    ctx.notify("git", {
      title: `${Verb} failed · ${o.repo.name}`,
      body: gitFailureHeadline(o.error),
      outcome: "failed", key, tag, open,
      detail: o.error ?? "",
      ...(o.verb === "push" && o.head ? { pushHead: o.head } : {}),
    });
    return;
  }
  if (o.verb === "pull") ctx.resolveAttention(key, `fixed by the ${hhmm(o.finishedAt)} pull`);
  else {
    // The failures this push fixes: the one on the SAME branch, by its key, AND one filed with
    // no branch (an older record, a detached head) — the git view tells that one "a push that
    // goes through clears it", and every successful push does (review A3c ML2; record truth over
    // tray tidiness). The receipt takes the tray tag of the slot it cleared: the branch's own
    // when it cleared that, the bare one when the bare record was all it cleared. With both
    // open, the bare tray entry is the residual (rare: a detached-HEAD failure AND a branch one).
    const note = `fixed by the ${hhmm(o.finishedAt)} push`;
    const own = !!o.head && ctx.resolveAttention(gitPushFailureKey(o.repo.id, o.head.branch), note) > 0;
    const bare = ctx.resolveAttention(gitPushFailureKey(o.repo.id), note) > 0;
    if (o.head && !own && bare) tag = bareTag;
    ctx.notify("git", {
      title: `Pushed · ${o.repo.name}`,
      body: `${o.repo.branch ? `${o.repo.branch} · ` : ""}took ${took(o.finishedAt - o.startedAt)}`,
      outcome: "ok", tag, open,
    });
  }
  // A pull or push just ended, so refs moved: a failed push whose commit is now on its
  // branch's upstream (pushed from a terminal, merged, another machine) is moot.
  try { await settlePushFailure(o, ctx); }
  catch (e) { console.error(`[git] push-failure check: ${(e as Error).message}`); }
}

/** Resolve each of the repo's failed pushes whose branch is on its remote (`pushedAlready`: the
 *  failed commit, or the branch's current tip after an amend). Asks git about that branch, never
 *  HEAD; unknown (no remote ref, branch gone) changes nothing. */
async function settlePushFailure(o: GitOutcome, ctx: GitNotifyDeps): Promise<void> {
  if (ctx.attention && o.wt) await settleRepo(o.repo.id, o.wt, ctx.attention, ctx);
}

async function settleRepo(repoId: string, wt: string, store: Pick<AttentionStore, "unhandled">, ctx: Pick<GitNotifyDeps, "resolveAttention">): Promise<void> {
  for (const f of pushFailures(store, repoId)) {
    const h = f.head;
    if (!h || (await pushedAlready(wt, h.branch, h.sha)) !== true) continue;
    // A newer failure on that branch filed while git answered is a different commit — leave it.
    const now = pushFailures(store, repoId).find((x) => x.identity === f.identity)?.head;
    if (now?.sha !== h.sha) continue;
    ctx.resolveAttention(f.identity, `${h.branch} is on its remote — it went up another way`);
  }
}

/** What the tick needs: the store, the resolver, and the worktree each repo id names now. */
export interface PushFailureWatchDeps extends Pick<GitNotifyDeps, "resolveAttention"> {
  attention: Pick<AttentionStore, "unhandled">;
  /** repo id → worktree path, read only when a push failure is open. */
  worktrees(): Promise<Map<string, string>>;
}

/**
 * One pass over every open push failure, asked of git state — the half a push from a TERMINAL
 * needs: it is no host-run outcome, so nothing else ever looks (design round 4). Nothing open ⇒
 * no lookup and no git. Never called from a request: a GET resolves nothing.
 */
export async function settlePushFailures(deps: PushFailureWatchDeps): Promise<void> {
  const ids = new Set<string>();
  for (const r of deps.attention.unhandled()) {
    const k = parseAttentionKey(r.item.key);
    if (k?.kind === "git" && k.verb === "push" && r.extras?.pushHead) ids.add(k.repoId);
  }
  if (!ids.size) return;
  const wts = await deps.worktrees();
  for (const id of ids) {
    const wt = wts.get(id);
    if (wt) await settleRepo(id, wt, deps.attention, deps);
  }
}

/** The tick: a minute apart, idle (no git) while no push failure is open. Returns the stop. */
export function startPushFailureWatch(deps: PushFailureWatchDeps, everyMs = 60_000): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    settlePushFailures(deps).catch((e) => console.error(`[git] push-failure tick: ${(e as Error).message}`)).finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * A finished Explain, told: the brief takes a minute or two and the person
 * has usually left the screen. Information either way — a brief that could
 * not be written is its reason, not a failure anyone must deal with. The tap
 * opens the Explain view on the stored answer (`explainjob.ts`).
 */
export function reportExplainOutcome(o: ExplainOutcome, ctx: Pick<GitNotifyDeps, "notify">): void {
  const b = o.brief;
  ctx.notify("git", {
    title: `${b.text ? "Explained" : "No explanation"} · ${o.repo.name}`,
    body: b.text
      ? `${[b.push ? `${b.push} to push` : "", b.pull ? `${b.pull} to pull` : ""].filter(Boolean).join(" · ") || "ready"} · took ${took(o.finishedAt - o.startedAt)}`
      : gitFailureHeadline(b.reason),
    outcome: "ok", tag: `git-${o.repo.id}-explain`,
    open: { to: "git", repoId: o.repo.id, verb: "explain" },
  });
}
