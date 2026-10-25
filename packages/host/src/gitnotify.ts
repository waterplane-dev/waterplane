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
 * - a push that SUCCEEDS resolves that key ("fixed by the 14:02 push") and
 *   leaves an information receipt — it ran for minutes;
 * - a pull that succeeds resolves the key and raises nothing: the person was
 *   watching it.
 */
import { gitAttentionKey } from "@waterplane/shared";
import type { GitOutcome } from "./git.js";

/** What it needs of the host: `notify` and `resolveAttention`, as on `HostCtx`
 *  (spelled here — a flat module never imports `routes/`). */
export interface GitNotifyDeps {
  notify(kind: "git", p: {
    title: string; body: string; tag: string; open: { to: "git"; repoId: string; verb: "pull" | "push" };
    outcome: "ok" | "failed"; key?: string; detail?: string;
  }): void;
  resolveAttention(key: string, note: string): number;
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

export function reportGitOutcome(o: GitOutcome, ctx: GitNotifyDeps): void {
  const key = gitAttentionKey(o.repo.id, o.verb);
  const open = { to: "git" as const, repoId: o.repo.id, verb: o.verb };
  const tag = `git-${o.repo.id}-${o.verb}`;
  const Verb = o.verb === "push" ? "Push" : "Pull";
  if (!o.ok) {
    ctx.notify("git", {
      title: `${Verb} failed · ${o.repo.name}`,
      body: gitFailureHeadline(o.error),
      outcome: "failed", key, tag, open,
      detail: o.error ?? "",
    });
    return;
  }
  ctx.resolveAttention(key, `fixed by the ${hhmm(o.finishedAt)} ${o.verb}`);
  if (o.verb !== "push") return;
  ctx.notify("git", {
    title: `Pushed · ${o.repo.name}`,
    body: `${o.repo.branch ? `${o.repo.branch} · ` : ""}took ${took(o.finishedAt - o.startedAt)}`,
    outcome: "ok", tag, open,
  });
}
