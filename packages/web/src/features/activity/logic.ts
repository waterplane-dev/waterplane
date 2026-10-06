/**
 * The activity feature's pure half: which queue lane a *run it now* takes, what
 * its receipt says, and the one sentence a bulk re-send ends in. Every string
 * was an inline literal in `App.tsx`; pinned by `logic.test.mjs`.
 */
import type { IntentKind } from "@waterplane/shared";

/** The two link-down refusals, one copy each (`backlogFilter.ts`). */
export { BL_OFFLINE, HELD_OFFLINE } from "../../backlogFilter.ts";

/**
 * The queue LANE a *run it now* takes, per kind — each a rule that already
 * existed. A build shares its repo's build lane (one build per worktree), a
 * capture its repo's capture lane (plus a lease on one browser/simulator/
 * screen). A schedule shares the fan-out lane: firing one by hand spawns real
 * sessions, and a sweep is a herd of claude processes either way. Everything
 * else gets a lane of its own — a work item is one prompt into one session,
 * and parking it behind an unrelated sweep is a wait nothing asked for.
 */
export function runLane(kind: IntentKind, i: { id: string; cwd: string }): string {
  return kind === "build" ? `build:${i.cwd}`
    : kind === "capture" ? `capture:${i.cwd}`
    : kind === "schedule" ? "fanout"
    : `intent:${i.id}`;
}

/** The receipt for a *run it now*: queued offline, or what is starting. */
export function runNowToast(kind: IntentKind, offline: boolean): string {
  return offline ? "queued — it runs when the link is back"
    : kind === "launch" ? "opening it now, without the files it was waiting for"
    : kind === "build" ? "starting the build…"
    : kind === "capture" ? "taking the capture…"
    : "firing it into the session…";
}

/** A bulk re-send's ONE sentence: what went, whether it waits for the link,
 *  what could not go, and where the old rows are now. */
export function refireSummary(sent: number, total: number, offline: boolean): string {
  const missed = total - sent;
  return `${sent} ${sent === 1 ? "message" : "messages"} back as backlog items${offline ? " — added when the link is back" : ""}`
    + `${missed ? ` · ${missed} could not go` : ""} · their rows are filed under “dismissed”`;
}
