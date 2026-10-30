/**
 * Where a queue row IS — one reading for every screen that draws one.
 *
 * Before this, each reader spelled the phase itself from `status` and a
 * hand-picked set of `failState`s, and they drifted inside one sheet: the queue
 * sheet counted `stale`/`refused` rows into "try N again" while the tap
 * revived only rows with no recorded verdict (a count that was not its
 * filter), and it labelled a row the desktop was still confirming "not
 * delivered" while the strip and Activity called it confirming
 * (design review 2026-10-30 W3). Every reader now asks here;
 * `phase.test.mjs` ratchets a hand comparison anywhere else.
 *
 * Pure and type-only on its imports so node tests it directly.
 */
import type { OutboxEntry } from "../../outbox";   // type-only: erased before node sees it
import { CONFIRM_WINDOW_MS, hostStillConfirming } from "../../sendConfirm.ts";

export type RowPhase =
  /** queued, nothing in its way but the link or its lane */
  | "waiting"
  /** queued, counting down a backoff between two delivery attempts */
  | "retrying"
  /** on the wire right now */
  | "sending"
  /** typed; the desktop is still asking whether it ran (`sendConfirm.ts`) */
  | "confirming"
  /** given up, provably un-run: a re-send with the same ackId is safe */
  | "failed-retryable"
  /** the words may already be in that session (`unconfirmed` after the
   *  window, `unsubmitted`): only a person looking can tell — a re-send could
   *  run them twice */
  | "failed-unknown"
  /** the desktop recorded a no (`stale`, `refused`): the same ackId is only
   *  ever refused again, so the way out is a rewrite */
  | "failed-final";

/**
 * May this row go back in the queue as it is — same ackId, same words?
 *
 * Only a failure with no recorded verdict. `unconfirmed`/`unsubmitted` say the
 * text may already be in that session, so a re-send is how a prompt runs
 * twice; `stale`/`refused` are a no the desktop REMEMBERS by ackId, so a
 * re-send comes straight back red. The bulk "try N again" counts this and
 * revives this — one predicate, so the number is the cut.
 */
export function revivable(e: OutboxEntry): boolean {
  return e.status === "failed" && (!e.failState || e.failState === "other");
}

/** A failed row whose words may already sit in that session — still being
 *  confirmed or not. Re-sending it is a person's decision, one at a time. */
export function mayBeInSession(e: OutboxEntry): boolean {
  return e.status === "failed" && (e.failState === "unconfirmed" || e.failState === "unsubmitted");
}

export function rowPhase(e: OutboxEntry, now: number): RowPhase {
  if (e.status === "pending") return "sending";
  if (e.status === "queued") return e.retryAt != null && e.retryAt > now ? "retrying" : "waiting";
  if (hostStillConfirming(e, now)) return "confirming";
  if (revivable(e)) return "failed-retryable";
  if (mayBeInSession(e)) return "failed-unknown";
  return "failed-final";
}

export function isFailedPhase(p: RowPhase): boolean {
  return p === "failed-retryable" || p === "failed-unknown" || p === "failed-final";
}

/** The word a row wears in the queue sheet. Only `failed-retryable` is "not
 *  delivered": the others are known NOT to be that simple. */
export const PHASE_LABEL: Record<RowPhase, string> = {
  waiting: "waiting",
  retrying: "retrying",
  sending: "sending",
  confirming: "confirming it ran",
  "failed-retryable": "not delivered",
  "failed-unknown": "may be in that session",
  "failed-final": "refused",
};

/** Why a row's queued-only controls (hold, re-aim, add) are off, by phase. */
export const PHASE_NOT_QUEUED: Record<RowPhase, string> = {
  waiting: "",
  retrying: "",
  sending: "already on its way",
  confirming: "the desktop is still confirming this one — it may be running",
  "failed-retryable": "it didn't go through — try it again first",
  "failed-unknown": "it may already be in that session — open it and look, or rewrite it",
  "failed-final": "the desktop refused it — rewrite it to send it as a new one",
};

/**
 * The toast at the moment a delivery is given up on. `unconfirmed` is the
 * HOST's question (it re-asks and retypes a provably-absent prompt itself);
 * `unsubmitted` is known and waits on a person's Return — the host never
 * re-sends it (`sendConfirm.ts`), so it must not promise that.
 */
export function failToast(state: OutboxEntry["failState"], reason: string, inQueueSheet: boolean): string {
  if (state === "unconfirmed") {
    return "Typed — the desktop is confirming it ran. It re-sends it itself if it never landed.";
  }
  if (state === "unsubmitted") {
    return "Typed, but it is still sitting in that session's box — open it and press Return. The desktop won't send it again.";
  }
  // "below" is the recovery bar on the main screen — true there, and a lie
  // anywhere else. In the queue sheet the row IS on screen.
  return inQueueSheet
    ? `Not sent — ${reason}. Your words are kept; the row is below.`
    : `Not sent — ${reason}. Your words are kept below — restore or re-aim them.`;
}

/**
 * Ms until the next row stops being `confirming` by the clock alone — the
 * window runs out with no outbox change when the host never answers, so a
 * sheet that stays open must re-render then or keep saying the desktop is
 * confirming. null when no row is confirming.
 */
export function nextConfirmBoundary(entries: readonly OutboxEntry[], now: number): number | null {
  let next: number | null = null;
  for (const e of entries) {
    if (!hostStillConfirming(e, now)) continue;
    const at = e.failedAt ?? e.sentAt ?? e.ts;
    const left = at + CONFIRM_WINDOW_MS - now;
    if (next == null || left < next) next = left;
  }
  return next;
}

/**
 * The three sentences above the queue list for rows that are failed-ish but
 * not "try again"-able, each right in the singular and the plural.
 */
export function phaseNotes(confirming: number, maybeRan: number, refused: number): string[] {
  const out: string[] = [];
  if (confirming > 0) {
    out.push(confirming > 1
      ? `${confirming} were typed and the desktop is still confirming that they ran — it types them again itself if not.`
      : "1 was typed and the desktop is still confirming that it ran — it types it again itself if not.");
  }
  if (maybeRan > 0) {
    out.push(maybeRan > 1
      ? `${maybeRan} may already be in their sessions — open each and look, or rewrite them to send fresh copies.`
      : "1 may already be in its session — open it and look, or rewrite it to send a fresh copy.");
  }
  if (refused > 0) {
    out.push(refused > 1
      ? `The desktop refused ${refused} — rewrite them to send as new ones.`
      : "The desktop refused 1 — rewrite it to send as a new one.");
  }
  return out;
}

/** A failed row the desktop typed in and could not read back — the one verdict
 *  "save as done" is honestly an answer to (Activity). */
export function isUnconfirmed(e: OutboxEntry): boolean {
  return e.status === "failed" && e.failState === "unconfirmed";
}
