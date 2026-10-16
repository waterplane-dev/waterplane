/** Re-time many, budget holds and the skip-the-queue words. Split from `sendIntent.ts` (docs/notes/send-architecture.md); pure, no React. */
import { budgetWaived, fmtWhen, type Intent } from "@waterplane/shared";
import { type SendWhen } from "./sendTypes.ts";

// ── Re-time many ─────────────────────────────────────────────────────────────

/**
 * Why the sheet's button is off in RE-TIME mode (`SendSeed.retime`), or null.
 *
 * The WHEN half of `sendBlocker` and nothing else: there are no words to write
 * and no target to pick — each row keeps its own — so the refusals about text,
 * builds and sweeps cannot apply, and asking `sendBlocker` would refuse every
 * re-time with "write the prompt first".
 */
export function retimeBlocker(w: SendWhen, preview: number | null, n: number): string | null {
  if (n === 0) return "tick the rows to move first";
  if (w.kind === "at" && preview == null && w.rule.kind === "once") return "the time it resolves to has already passed";
  if (w.kind === "after" && !w.id) return "pick the item it waits for";
  return null;
}
/** The button in re-time mode: the count, then the WHEN in the sheet's own words. */
export function retimeWhenLabel(n: number, when: string): string {
  return `Re-time ${n === 1 ? "it" : `these ${n}`} — ${when}`;
}

/**
 * **What "now" means in re-time mode: next in line.** A re-timed row is queued
 * work, and the queue asks the ladder — the usage budget first, then one at a
 * time per repo — before it starts anything. A send's *now* types straight
 * into a session; this one cannot, and saying "now" over it put four prompts
 * behind a 75% budget with nothing on screen saying so.
 */
export const RETIME_NOW_SEG = "next in line";
/** Whatever WHEN is picked, the budget holds it — said above the editor, with the
 *  host's own sentence and the instant it expects to clear. Null when nothing
 *  holds, and null when the budget holds none of the ticked rows (`held`, the
 *  length of `budgetHeldIds`): a row already let past it is not held. */
export function retimeHeldWords(budgetNote: string | null | undefined, resumeAt: number | null | undefined, held: number): string | null {
  if (!budgetNote || held <= 0) return null;
  const until = resumeAt ? ` — resumes ${fmtWhen(resumeAt)}` : "";
  return `Held: ${budgetNote}${until}. These are queued work, so whatever when you pick, they wait for the budget like the rest of the queue.`;
}

/**
 * **Would this row run NOW if the budget let it?** Rung 2 sits ABOVE the
 * trigger, so every auto row over budget reads `budget` — including one whose
 * clock is days away. Waiving that one would be an answer about a window it
 * will not run in, so it is not "held by the budget" in any sense a person can
 * act on. Only what the phone can SEE: an `at` row's armed instant, a chain's
 * predecessor having settled the way it asked; a `files` wait the phone cannot
 * read is not called due.
 */
function dueNow(i: Intent, now: number, byId: ReadonlyMap<string, Intent>): boolean {
  switch (i.trigger.kind) {
    case "now": case "idle": case "budget": return true;
    case "at": return typeof i.nextAt === "number" && i.nextAt <= now;
    case "after": {
      const p = byId.get(i.trigger.id);
      if (!p) return false;
      return p.state === "done" || (!i.trigger.onlyIfOk && (p.state === "failed" || p.state === "canceled"));
    }
    default: return false;
  }
}
/**
 * **Is the budget what holds this row, right now?** The ONE test behind the
 * re-time sheet's *let these N past the budget* (`budgetHeldIds`) and the
 * header chip's *N held by the usage budget* — two copies had already drifted
 * (the chip did not know a waiver can expire). Held means: waiting, the host's
 * own verdict says `budget`, no waiver IN FORCE (`budgetWaived` — an expired
 * one is no waiver), and due — its trigger would pass (`dueNow`).
 */
export function isBudgetHeld(i: Intent, now: number, byId?: ReadonlyMap<string, Intent>): boolean {
  if (i.state !== "queued" && i.state !== "blocked") return false;
  if (i.blockReason !== "budget" || budgetWaived(i, now)) return false;
  return dueNow(i, now, byId ?? new Map());
}
/**
 * **Which of the ticked rows the budget is holding** — the one function behind
 * the count on *let these N past the budget* AND the ids it sends, so the
 * number and the action cannot disagree. `isBudgetHeld` is the test.
 */
export function budgetHeldIds(ids: readonly string[], intents: readonly Intent[], now: number = Date.now()): string[] {
  const byId = new Map(intents.map((i) => [i.id, i]));
  return ids.filter((id) => {
    const i = byId.get(id);
    return !!i && isBudgetHeld(i, now, byId);
  });
}
/**
 * The way past the budget, and ONLY the budget. It used to be *run all N now,
 * past the budget*, which sent `intent.run` per row — and `runNow` skips the
 * whole ladder, so four rows in one repo started at once in one checkout.
 * `intent.waive` lifts rung 2 and nothing below it: the words say *in turn*,
 * never *now*.
 */
export function pastBudgetLabel(k: number): string {
  return `let ${k === 1 ? "it" : `these ${k}`} past the budget`;
}
/** What the tap does and — the half that matters — what it leaves alone.
 *  `k` is the held rows, `n` the ticked ones; the prefix says the difference. */
export function pastBudgetNote(k: number, n: number): string {
  const rest = k < n ? `${k} of the ${n} you ticked are held by the budget; the rest wait on something else. ` : "";
  const who = k === 1 ? "this row" : `these ${k}`;
  const serial = k > 1 ? "rows in the same repo still run one at a time, " : "";
  return `${rest}Lifts the budget for ${who} and nothing else — ${serial}wait until free, the session cap and each row's own when all still apply. It lasts until the row starts, or until this budget window resets.`;
}
export function pastBudgetConfirm(k: number): string {
  return `let ${k} past the budget?`;
}
export function pastBudgetToast(k: number): string {
  return `let ${k === 1 ? "it" : k} past the budget — ${k === 1 ? "it runs" : "they run"} in turn`;
}

/**
 * **The one promise every single-row skip-the-queue verb makes** — Backlog's
 * `fire`/`re-fire`, Activity's *run it now*, the compose strip's *send now*.
 * They reach the host's `runNow` (or type straight in), which skips the WHOLE
 * ladder; that is the point of a tap on one row, and it is also why the bulk
 * release is `intent.waive` and never these. Said as TEXT where the verb is,
 * because a `title` is invisible on a phone.
 *
 * `own` is where it runs: a row aimed at a repo opens a session of its own; a
 * row aimed at a session (or the strip's words) goes into THAT session.
 */
export function skipQueueNote(own: boolean): string {
  return own
    ? "starts it this second in a session of its own — skips the queue: the budget, one at a time and wait until free"
    : "goes into its session this second — skips the queue: the budget and waiting for that session to be free";
}
/** What the tap DOES when another row is already starting or running in the
 *  same checkout — the case where skipping *one at a time* means two agents
 *  editing one worktree. Said, never asked: a fire is the manual override and
 *  takes one tap (it was a two-tap confirm that disarmed on a timer, so a
 *  person's tap on a held row only ever armed it). */
export const SKIP_QUEUE_BUSY_NOTE = "another agent is working in this checkout — this starts a second one beside it";
/**
 * Is another agent working in this checkout? `cwd` is the worktree
 * (`serialGroup`'s key), so two worktrees of one repo never count each other.
 * Ask it only for a row that opens a session of its own — typing into a
 * session starts no second agent.
 *
 * Two readings, both off the WHOLE picture: any intent starting or running
 * there — the whole store, never one sheet's slice (the Backlog once asked
 * over its own items only, so a build or a launch in the same checkout went
 * unseen there while Activity saw it) — and any live session there whose turn
 * is active (a person driving that checkout by hand is an agent too). One
 * function, so Backlog and Activity cannot answer it two ways.
 */
export function busyInCheckout(
  cwd: string | undefined,
  intents: readonly Pick<Intent, "id" | "cwd" | "state">[],
  selfId?: string,
  sessions?: readonly { cwd: string; running: boolean; turnActive?: boolean }[],
): boolean {
  if (!cwd) return false;
  if (intents.some((r) => r.id !== selfId && r.cwd === cwd && (r.state === "starting" || r.state === "running"))) return true;
  return (sessions ?? []).some((s) => s.running && s.turnActive === true && s.cwd === cwd);
}
/**
 * What *run it now* says on a standing rule whose action QUEUES a backlog item
 * (`queuesBacklogItem`): its run adds a row that waits its turn, so it skips
 * nothing and starts no second agent — `skipQueueNote` would promise both.
 */
export const QUEUES_ITEM_RUN_NOTE = "queues an item in its backlog — it runs in turn";
