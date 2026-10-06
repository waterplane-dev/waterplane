/** Pure helpers over a target and a run window: where a send is aimed by default, the chain row's state word, the hh:mm clock. Split from `SendSheet.tsx` (docs/notes/send-architecture.md). */
import type { Intent, RepoTarget, SessionInfo } from "@waterplane/shared";
import { type SendTarget } from "../sendIntent";

/**
 * What a run window opens and closes at before anybody has touched it — a
 * daytime window, so the first tap on either field produces a rule that means
 * something rather than one that has to be fixed twice. 07:00–22:00 is the
 * complement of the night window people actually name, and the half-open test
 * (`inHours`) makes the two exact complements rather than two windows that both
 * claim 22:00.
 */
export const HOURS_FROM = 7 * 60;
export const HOURS_TO = 22 * 60;

/** Minutes of day as `<input type="time">` wants them. */
export const hhmm = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** …and back. Null on anything the control could not have produced — a cleared
 *  time field fires `change` with an empty string, and writing that as midnight
 *  would silently shut the door on a rule at the moment somebody was opening it. */
export function minuteOfDay(v: string): number | null {
  const [h, m] = v.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return Math.min(24 * 60 - 1, Math.max(0, h * 60 + m));
}

/**
 * The sub-line on a chain candidate: what it is doing, and where.
 *
 * Three words at most, because the row's own title is the thing being read and
 * this is what tells two rows with similar prose apart. `failed` is drawn as
 * itself rather than folded into "finished": whether the predecessor succeeded
 * is exactly the question the chip underneath is about, so a picker that hid it
 * would be asking about something it had refused to show.
 */
export function chainRowState(i: Intent): string {
  const what = i.state === "running" || i.state === "starting" ? "running now"
    : i.state === "queued" || i.state === "blocked" ? "waiting"
      : i.state === "failed" ? "finished — it failed"
        : "finished";
  const where = i.cwd.split("/").filter(Boolean).pop() ?? "";
  return where ? `${what} · ${where}` : what;
}

// ── Defaults ─────────────────────────────────────────────────────────
// Pre-filled from context, never demanded. Every one of these is a guess the
// user can see (the summary row states it) and change in one tap — which is the
// difference between a default and a decision made on someone's behalf.

export function defaultTarget(live: SessionInfo[], repos: RepoTarget[], cwdHint?: string | null): SendTarget {
  const home = cwdHint ? live.find((s) => s.cwd === cwdHint) : null;
  if (home) return { kind: "session", sessionId: home.id, cwd: home.cwd };
  if (cwdHint) return { kind: "repo", cwd: cwdHint };
  if (live[0]) return { kind: "session", sessionId: live[0].id, cwd: live[0].cwd };
  const repo = repos.find((r) => r.isPrimary) ?? repos[0];
  return { kind: "repo", cwd: repo?.worktreePath ?? "" };
}

/** The session a "session" pick lands on: the one in the words' own repo if
 *  there is one, else the first live one. */
export function firstSession(live: SessionInfo[], cwdHint?: string | null): SendTarget {
  const s = (cwdHint && live.find((x) => x.cwd === cwdHint)) || live[0];
  return s ? { kind: "session", sessionId: s.id, cwd: s.cwd } : { kind: "repo", cwd: cwdHint ?? "" };
}

/** Carry the repo across a target switch — changing WHAT kind of send this is
 *  must not silently forget WHICH repo it was for. */
export function cwdOf(t: SendTarget, repos: RepoTarget[], cwdHint?: string | null): string {
  if (t.kind === "repos") return t.dirs[0] ?? cwdHint ?? "";
  if (t.kind !== "shell" && "cwd" in t && t.cwd) return t.cwd;
  return cwdHint ?? repos.find((r) => r.isPrimary)?.worktreePath ?? repos[0]?.worktreePath ?? "";
}

export function dirsOf(t: SendTarget, cwdHint?: string | null): string[] {
  if (t.kind === "repos") return t.dirs;
  const cwd = t.kind === "shell" ? t.cwd : "cwd" in t ? t.cwd : "";
  const one = cwd || cwdHint || "";
  return one ? [one] : [];
}
